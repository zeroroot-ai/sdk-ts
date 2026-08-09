import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { CapabilityGrantClient, normalizePlatformURL } from "./client.js"
import { loadOrGenerateHostKey } from "./keys.js"

/**
 * Check-in-once lifecycle (ADR-0045).
 *
 * A human enrolls the component once and hands over a ONE-TIME bootstrap token.
 * That token completes the first handshake; from then on the persisted host key
 * re-registers unattended. The daemon routes on credential type, so sending the
 * wrong one is not a soft failure — it is a 401.
 */

const DISCOVERY = {
  protocol_version: "1.0",
  provider_name: "Gibson",
  issuer: "https://api.example.test",
  default_location: "global",
  supported_modes: ["autonomous"],
  endpoints: {
    register: "https://api.example.test/capabilitygrant/v1/register",
    execute: "",
    list: "",
    status: "",
    revoke: "",
    introspect: "",
  },
  jwks_uri: "https://api.example.test/.well-known/jwks.json",
}

/** Stub fetch; records the Authorization header each register call carries. */
function stubFetch(seen: string[]) {
  return async (url: unknown, init?: { headers?: Record<string, string> }) => {
    if (String(url).includes(".well-known/agent-configuration")) {
      return { ok: true, json: async () => DISCOVERY } as never
    }
    seen.push(init?.headers?.authorization ?? "")
    return {
      ok: true,
      json: async () => ({ agent_id: "agent-1", component_scope: "component:zerocool" }),
    } as never
  }
}

async function withTempDir(fn: (dir: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), "cg-"))
  const originalFetch = globalThis.fetch
  try {
    await fn(dir)
  } finally {
    globalThis.fetch = originalFetch
    await rm(dir, { recursive: true, force: true })
  }
}

test("a fresh host key reports first check-in; a loaded one does not", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "host.key")
    const fresh = loadOrGenerateHostKey(path)
    assert.equal(fresh.firstCheckIn, true)
    assert.ok(existsSync(path), "the key is persisted for the next start")

    const loaded = loadOrGenerateHostKey(path)
    assert.equal(loaded.firstCheckIn, false)
    assert.equal(loaded.id, fresh.id, "the host identity is stable across restarts")
  })
})

test("first registration presents the one-time bootstrap token", async () => {
  await withTempDir(async (dir) => {
    const seen: string[] = []
    globalThis.fetch = stubFetch(seen) as never

    const client = new CapabilityGrantClient({
      platformURL: "https://api.example.test",
      agentName: "zerocool",
      hostKeyPath: join(dir, "host.key"),
      bootstrapToken: "one-time-token",
    })
    const { componentScope } = await client.register()

    assert.equal(componentScope, "component:zerocool")
    assert.equal(seen[0], "Bearer one-time-token")
  })
})

test("a checked-in host re-registers with the host key and never replays the token", async () => {
  await withTempDir(async (dir) => {
    const seen: string[] = []
    globalThis.fetch = stubFetch(seen) as never
    const hostKeyPath = join(dir, "host.key")

    // First start: the human-issued token.
    await new CapabilityGrantClient({
      platformURL: "https://api.example.test",
      agentName: "zerocool",
      hostKeyPath,
      bootstrapToken: "one-time-token",
    }).register()

    // Second start, same token still in the environment — it must NOT be reused.
    await new CapabilityGrantClient({
      platformURL: "https://api.example.test",
      agentName: "zerocool",
      hostKeyPath,
      bootstrapToken: "one-time-token",
    }).register()

    assert.equal(seen.length, 2)
    assert.equal(seen[0], "Bearer one-time-token", "first check-in uses the token")
    assert.notEqual(seen[1], "Bearer one-time-token", "a spent token must never be replayed")
    // A host JWT is a signed JWS, so it has three dot-separated sections.
    assert.equal(seen[1].replace("Bearer ", "").split(".").length, 3)
  })
})

test("the environment token is ignored once the host has checked in", async () => {
  await withTempDir(async (dir) => {
    const seen: string[] = []
    globalThis.fetch = stubFetch(seen) as never
    const hostKeyPath = join(dir, "host.key")
    loadOrGenerateHostKey(hostKeyPath) // pre-existing check-in

    process.env.GIBSON_BOOTSTRAP_TOKEN = "stale-token"
    try {
      await new CapabilityGrantClient({
        platformURL: "https://api.example.test",
        agentName: "zerocool",
        hostKeyPath,
      }).register()
    } finally {
      delete process.env.GIBSON_BOOTSTRAP_TOKEN
    }

    assert.notEqual(seen[0], "Bearer stale-token")
  })
})

test("a never-checked-in host without a token fails with actionable guidance", async () => {
  await withTempDir(async (dir) => {
    globalThis.fetch = stubFetch([]) as never
    const client = new CapabilityGrantClient({
      platformURL: "https://api.example.test",
      agentName: "zerocool",
      hostKeyPath: join(dir, "host.key"),
    })
    await assert.rejects(() => client.register(), /gibson agent enroll/)
  })
})

test("the per-RPC agent+jwt travels in x-capability-grant, not Authorization", async () => {
  // Gateway contract (epic unified-cg-identity, "Option A"): Authorization is
  // reserved for Zitadel tokens, which Envoy's jwt_authn validates into
  // x-jwt-payload. A CG token placed there is not ignored — jwt_authn fails it,
  // ext-authz sees no x-jwt-payload and rejects the RPC, so every component call
  // 401s at the edge before the daemon is ever reached.
  const dir = await mkdtemp(join(tmpdir(), "cg-header-"))
  const client = new CapabilityGrantClient({
    platformURL: "https://api.example:30443",
    hostKeyPath: join(dir, "host.key"),
    agentName: "probe",
    bootstrapToken: "bootstrap",
  })

  // Drive register() through a stub so the interceptor has an agent id + scope.
  const origFetch = globalThis.fetch
  globalThis.fetch = (async (url: string | URL) =>
    String(url).endsWith("/.well-known/agent-configuration")
      ? new Response(
          JSON.stringify({
            protocol_version: "1.0",
            endpoints: { register: "https://api.example:30443/capabilitygrant/v1/register" },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        )
      : new Response(
          JSON.stringify({ agent_id: "agt_1", component_scope: "component:probe" }),
          { status: 200, headers: { "content-type": "application/json" } },
        )) as typeof globalThis.fetch
  try {
    await client.register()
  } finally {
    globalThis.fetch = origFetch
  }

  const headers = new Headers()
  const interceptor = client.authInterceptor()
  await interceptor((async (r: unknown) => r) as never)({
    header: headers,
  } as never)

  const cg = headers.get("x-capability-grant")
  assert.ok(cg && cg.length > 0, "x-capability-grant must carry the agent+jwt")
  assert.ok(!cg.startsWith("Bearer "), "the dedicated header carries a bare token, not a Bearer scheme")
  assert.equal(headers.get("authorization"), null, "Authorization must stay free for Zitadel tokens")
})

/**
 * Audience normalization (issue #7).
 *
 * ext-authz pins CG-JWT audiences with an exact-string allowlist (gibson#1282),
 * so the platform URL must canonicalize to one exact string no matter how the
 * operator wrote GIBSON_PLATFORM_URL. A trailing slash would mint a distinct
 * `aud` and fail the pin with an opaque 401.
 */

test("normalizePlatformURL strips trailing slashes and leaves clean URLs alone", () => {
  assert.equal(normalizePlatformURL("https://api.zeroroot.ai/"), "https://api.zeroroot.ai")
  assert.equal(normalizePlatformURL("https://api.zeroroot.ai///"), "https://api.zeroroot.ai")
  assert.equal(normalizePlatformURL("https://api.zeroroot.ai"), "https://api.zeroroot.ai")
  assert.equal(normalizePlatformURL("https://api.example:30443/"), "https://api.example:30443")
  assert.equal(normalizePlatformURL("https://api.example:30443"), "https://api.example:30443")
})

test("normalizePlatformURL rejects invalid or non-http(s) URLs with a clear error", () => {
  assert.throws(() => normalizePlatformURL("api.zeroroot.ai"), /not a valid URL.*GIBSON_PLATFORM_URL/s)
  assert.throws(() => normalizePlatformURL(""), /not a valid URL/)
  assert.throws(() => normalizePlatformURL("grpc://api.zeroroot.ai"), /must be http\(s\)/)
})

test("a trailing-slash platform URL mints the canonical bare origin as aud", async () => {
  await withTempDir(async (dir) => {
    globalThis.fetch = stubFetch([]) as never

    const client = new CapabilityGrantClient({
      platformURL: "https://api.example.test/", // operator typo: trailing slash
      agentName: "zerocool",
      hostKeyPath: join(dir, "host.key"),
      bootstrapToken: "one-time-token",
    })
    await client.register()

    // The transport baseUrl and the minted audience must agree: connectGibson
    // wires createGrpcTransport's baseUrl from this same canonical value.
    assert.equal(client.platformURL, "https://api.example.test")

    const headers = new Headers()
    await client.authInterceptor()((async (r: unknown) => r) as never)({ header: headers } as never)
    const token = headers.get("x-capability-grant")
    assert.ok(token, "interceptor must attach x-capability-grant")
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as { aud: string }
    assert.equal(payload.aud, "https://api.example.test", "aud must be the normalized bare origin")
    assert.equal(payload.aud, client.platformURL, "aud and transport baseUrl source must be the same string")
  })
})
