// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { createPublicKey, verify, type KeyObject } from "node:crypto"
import { mkdtempSync, rmSync } from "node:fs"
import type { IncomingMessage, ServerResponse } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"

import { AgentCard, Task, TaskState } from "@a2a-js/sdk"
import { InboundA2AClient, InboundA2ARefusedError, INBOUND_TARGETS_KEY } from "./a2a-inbound.js"
import { CapabilityGrantClient } from "./auth/client.js"
import { makeTestCa, startTlsServer } from "./tls-fixture.test.js"

const AGENT_ID = "agent-row-1"
/** The longest life that ext-authz accepts for a component token (5 minutes). */
const MAX_LIFETIME_S = 5 * 60

interface RpcCall {
  method: string
  params: Record<string, unknown>
}

/**
 * The checks of the daemon side for the inbound class, in the same order
 * (gibson internal/server/extauthz/cgjwt, ComponentVerifier.verify). It returns
 * the reason of a refusal, or "" for a good token.
 */
function verifyToken(token: string | undefined, path: string, key: KeyObject, seenJti: Set<string>): string {
  if (!token) return "no capability grant"
  const parts = token.split(".")
  if (parts.length !== 3) return "not a compact JWT"
  const [h, p, s] = parts as [string, string, string]
  const header = JSON.parse(Buffer.from(h, "base64url").toString("utf8")) as Record<string, unknown>
  if (header.typ !== "agent+jwt") return `unexpected typ ${String(header.typ)}`
  if (header.kid !== AGENT_ID) return `unknown kid ${String(header.kid)}`
  if (header.alg !== "EdDSA") return `unexpected alg ${String(header.alg)}`
  if (!verify(null, Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) return "signature invalid"
  const claims = JSON.parse(Buffer.from(p, "base64url").toString("utf8")) as Record<string, unknown>
  if (claims.aud !== "zeroroot.ai/gibson-daemon") return `audience ${String(claims.aud)}`
  if (typeof claims.exp !== "number" || typeof claims.iat !== "number") return "no exp or no iat"
  const now = Date.now() / 1000
  if (claims.exp <= now) return "expired"
  if (claims.iat > now + 1) return "issued in the future"
  if (claims.exp - claims.iat > MAX_LIFETIME_S || claims.exp - now > MAX_LIFETIME_S) return "lifetime too long"
  if (!claims.method) return "no method claim"
  if (claims.method !== path) return `token bound to ${String(claims.method)}, presented at ${path}`
  if (typeof claims.jti !== "string" || !claims.jti) return "no jti"
  if (seenJti.has(claims.jti)) return `jti ${claims.jti} already used`
  seenJti.add(claims.jti)
  return ""
}

function task(id: string, state: TaskState) {
  return Task.toJSON({
    id,
    contextId: "ctx-1",
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: undefined,
  })
}

/**
 * Enroll an identity with a stubbed platform, and start the edge that checks
 * its tokens. The stub records the agent key that the identity registers.
 */
async function setup(opts: { refuse?: number; answerMessage?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "inbound-"))
  const originalFetch = globalThis.fetch
  let agentKey: KeyObject | undefined
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    if (String(url).includes(".well-known/agent-configuration")) {
      return {
        ok: true,
        json: async () => ({
          protocol_version: "1.0",
          endpoints: { register: "https://api.example.test/capabilitygrant/v1/register" },
        }),
      } as never
    }
    const body = JSON.parse(init?.body ?? "{}") as { agent_key_jwk: Record<string, string> }
    agentKey = createPublicKey({ key: body.agent_key_jwk, format: "jwk" })
    return { ok: true, json: async () => ({ agent_id: AGENT_ID, component_scope: "component:agent/caller" }) } as never
  }) as typeof fetch
  const identity = new CapabilityGrantClient({
    platformURL: "https://api.example.test",
    agentName: "caller",
    hostKeyPath: join(dir, "host_key.pem"),
    bootstrapToken: "boot-1",
  })
  try {
    await identity.register()
  } finally {
    globalThis.fetch = originalFetch
  }
  assert.ok(agentKey, "the identity registered its agent key")
  const key = agentKey

  const ca = makeTestCa()
  const seenJti = new Set<string>()
  const paths: string[] = []
  const calls: RpcCall[] = []
  const refusals: string[] = []
  const srv = await startTlsServer(ca, (req: IncomingMessage, res: ServerResponse) => {
    const path = req.url ?? ""
    if (opts.refuse) {
      res.statusCode = opts.refuse
      res.end("refused")
      return
    }
    // ext-authz reads the :path of the request, which holds the query too.
    const refusal = verifyToken(req.headers["x-capability-grant"] as string | undefined, path, key, seenJti)
    if (refusal) {
      refusals.push(refusal)
      res.statusCode = 401
      res.end(refusal)
      return
    }
    paths.push(path)
    res.setHeader("content-type", "application/json")
    if (req.method === "GET" && path === "/a2a/inbound/recon/.well-known/agent-card.json") {
      res.end(JSON.stringify(AgentCard.toJSON({
        name: "recon",
        description: "finds hosts",
        supportedInterfaces: [{ url: `${srv.url}/a2a/inbound/recon`, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
        provider: undefined,
        version: "1",
        capabilities: undefined,
        securitySchemes: {},
        securityRequirements: [],
        defaultInputModes: [],
        defaultOutputModes: [],
        skills: [],
        signatures: [],
      })))
      return
    }
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as RpcCall & { id: unknown }
      calls.push({ method: rpc.method, params: rpc.params })
      let result: unknown
      if (rpc.method === "SendMessage") {
        result = opts.answerMessage
          ? { message: { messageId: "m-1", role: "ROLE_AGENT", parts: [{ text: "hello" }] } }
          : { task: task("mission-1", TaskState.TASK_STATE_SUBMITTED) }
      } else if (rpc.method === "GetTask") {
        result = task(String(rpc.params.id), TaskState.TASK_STATE_WORKING)
      } else {
        result = task(String(rpc.params.id), TaskState.TASK_STATE_CANCELED)
      }
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result }))
    })
  })
  return {
    identity, ca, srv, key, seenJti, paths, calls, refusals,
    client: new InboundA2AClient({ baseUrl: srv.url, signer: identity, caPem: ca.caPem }),
    async close() {
      await srv.close()
      ca.cleanup()
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

test("the inbound client calls each method with a new token for its path", async () => {
  const s = await setup()
  try {
    const card = await s.client.agentCard("recon")
    assert.equal(card.name, "recon")
    assert.equal(card.supportedInterfaces[0]?.url, `${s.srv.url}/a2a/inbound/recon`)

    const sent = await s.client.sendMessage("recon", "scan the hosts", { targets: ["target-1", "target-2"] })
    assert.equal(sent.id, "mission-1")
    assert.equal(sent.status?.state, TaskState.TASK_STATE_SUBMITTED)

    const got = await s.client.getTask("recon", sent.id)
    assert.equal(got.status?.state, TaskState.TASK_STATE_WORKING)
    // A second read proves that two calls of one path never share a token: the
    // edge refuses a jti that it saw before.
    await s.client.getTask("recon", sent.id)

    const canceled = await s.client.cancelTask("recon", sent.id)
    assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED)

    assert.deepEqual(s.refusals, [])
    assert.deepEqual(s.paths, [
      "/a2a/inbound/recon/.well-known/agent-card.json",
      "/a2a/inbound/recon", "/a2a/inbound/recon", "/a2a/inbound/recon", "/a2a/inbound/recon",
    ])
    assert.equal(s.seenJti.size, 5, "each request has its own jti")
    assert.deepEqual(s.calls.map((c) => c.method), ["SendMessage", "GetTask", "GetTask", "CancelTask"])

    const msg = s.calls[0]?.params.message as { messageId: string; role: string; parts: Record<string, unknown>[] }
    assert.ok(msg.messageId)
    assert.equal(msg.role, "ROLE_USER")
    assert.equal(msg.parts.length, 2)
    assert.equal(msg.parts[0]?.text, "scan the hosts")
    assert.deepEqual(msg.parts[1]?.data, { [INBOUND_TARGETS_KEY]: ["target-1", "target-2"] })
    assert.equal(s.calls[1]?.params.id, "mission-1")
  } finally {
    await s.close()
  }
})

test("a message with no target has no data part", async () => {
  const s = await setup()
  try {
    await s.client.sendMessage("recon", "scan")
    const msg = s.calls[0]?.params.message as { parts: Record<string, unknown>[] }
    assert.equal(msg.parts.length, 1)
    await s.client.sendMessage("recon", "scan", { targets: [] })
    const second = s.calls[1]?.params.message as { parts: unknown[] } | undefined
    assert.equal(second?.parts.length, 1)
  } finally {
    await s.close()
  }
})

test("an answer that is a message and not a task is an error", async () => {
  const s = await setup({ answerMessage: true })
  try {
    await assert.rejects(s.client.sendMessage("recon", "scan"), /not a task/)
  } finally {
    await s.close()
  }
})

test("the edge check refuses another path, a replay and a changed token", async () => {
  const s = await setup()
  try {
    const token = s.identity.signPath("/a2a/inbound/recon")
    const seen = new Set<string>()
    assert.match(verifyToken(token, "/a2a/inbound/other", s.key, seen), /presented at/)
    assert.match(verifyToken(token, "/a2a/inbound/recon?x=1", s.key, seen), /presented at/)
    assert.equal(verifyToken(token, "/a2a/inbound/recon", s.key, seen), "")
    assert.match(verifyToken(token, "/a2a/inbound/recon", s.key, seen), /already used/)
    assert.equal(verifyToken(undefined, "/a2a/inbound/recon", s.key, seen), "no capability grant")
    const changed = `${token.slice(0, -4)}AAAA`
    assert.equal(verifyToken(changed, "/a2a/inbound/recon", s.key, seen), "signature invalid")
    assert.notEqual(s.identity.signPath("/a2a/inbound/recon"), s.identity.signPath("/a2a/inbound/recon"))
    assert.throws(() => s.identity.signPath("a2a/inbound/recon"), /does not start with \//)
  } finally {
    await s.close()
  }
})

for (const status of [401, 403]) {
  test(`a caller that the platform refuses with ${status} gets InboundA2ARefusedError`, async () => {
    const s = await setup({ refuse: status })
    try {
      const refused = (err: unknown) => err instanceof InboundA2ARefusedError && err.status === status
      await assert.rejects(s.client.agentCard("recon"), refused)
      await assert.rejects(s.client.sendMessage("recon", "scan"), refused)
      await assert.rejects(s.client.getTask("recon", "mission-1"), refused)
      await assert.rejects(s.client.cancelTask("recon", "mission-1"), refused)
    } finally {
      await s.close()
    }
  })
}

test("the client refuses a bad agent name before it signs", async () => {
  let signed = 0
  const client = new InboundA2AClient({
    baseUrl: "https://api.example.test",
    signer: { signPath: () => { signed++; return "t" } },
  })
  for (const agent of ["", "Recon", "re/con", "../x", "-recon", "recon?x=1", "a".repeat(64)]) {
    await assert.rejects(client.sendMessage(agent, "scan"), /not a DNS label/)
    await assert.rejects(client.agentCard(agent), /not a DNS label/)
  }
  assert.equal(signed, 0)
})

test("the client needs an https origin", () => {
  const signer = { signPath: () => "t" }
  assert.throws(() => new InboundA2AClient({ baseUrl: "http://api.example.test", signer }), /https/)
  assert.throws(() => new InboundA2AClient({ baseUrl: "http://localhost:8080", signer }), /https/)
  assert.throws(() => new InboundA2AClient({ baseUrl: "not a url", signer }), /not a URL/)
  assert.throws(() => new InboundA2AClient({ baseUrl: "https://api.example.test/a2a/inbound", signer }), /origin/)
  assert.throws(() => new InboundA2AClient({ baseUrl: "https://api.example.test?x=1", signer }), /origin/)
  assert.throws(() => new InboundA2AClient({ baseUrl: "https://u:p@api.example.test", signer }), /origin/)
  assert.throws(() => new InboundA2AClient({ baseUrl: "https://api.example.test", signer, caPem: "not pem" }), /no certificate/)
  new InboundA2AClient({ baseUrl: "https://api.example.test/", signer })
})

test("signPath needs a registered identity", () => {
  const dir = mkdtempSync(join(tmpdir(), "inbound-"))
  try {
    const identity = new CapabilityGrantClient({
      platformURL: "https://api.example.test", agentName: "caller", hostKeyPath: join(dir, "host_key.pem"),
    })
    assert.throws(() => identity.signPath("/a2a/inbound/recon"), /register\(\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
