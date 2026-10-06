// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { create, toJson } from "@bufbuild/protobuf"
import { hostname } from "node:os"
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect"

import { HarnessCallbackService } from "./clients.js"
import { DaemonService } from "./gen/gibson/daemon/v1/daemon_pb.js"
import { ContextInfoSchema } from "./gen/gibson/harness/v1/harness_callback_pb.js"
import {
  CAPABILITY_GRANT_HEADER,
  contextFromGrant,
  decodeGrantClaims,
  grantInterceptor,
  IDENTITY_SOCKET_ENV,
  NoSandboxIdentityError,
  openTaskHarness,
  SANDBOX_ID_HEADER,
  SANDBOX_IDENTITY_AUDIENCE,
  SANDBOX_IDENTITY_HEADER,
  sandboxIdentityInterceptor,
  sandboxIdentityToken,
} from "./task-harness.js"

/** An unsigned JWT with the given payload. The client never verifies. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64(payload)}.sig`
}

const CLAIMS = { sub: "component:agent:zerocool", tenant: "t-1", mission_id: "m-1", task_id: "run-1", exp: 1_000 }

test("decodeGrantClaims reads the addressing claims the daemon mints", () => {
  const c = decodeGrantClaims(fakeJwt(CLAIMS))
  assert.deepEqual(c, { sub: "component:agent:zerocool", tenant: "t-1", missionId: "m-1", taskId: "run-1", exp: 1_000 })
})

test("decodeGrantClaims refuses a token that is not a JWT", () => {
  assert.throws(() => decodeGrantClaims("not-a-jwt"), /three dot-separated segments/)
  assert.throws(() => decodeGrantClaims("a.!!!.c"), /base64url JSON/)
})

test("contextFromGrant derives agent_name from the component subject", () => {
  const ctx = contextFromGrant(decodeGrantClaims(fakeJwt(CLAIMS)))
  assert.deepEqual(ctx, { missionId: "m-1", taskId: "run-1", agentName: "zerocool" })
})

test("contextFromGrant fails closed on a subject or mission it cannot address", () => {
  assert.throws(() => contextFromGrant(decodeGrantClaims(fakeJwt({ ...CLAIMS, sub: "user:alice" }))), /component:<kind>:<name>/)
  assert.throws(() => contextFromGrant(decodeGrantClaims(fakeJwt({ ...CLAIMS, mission_id: "" }))), /no mission_id/)
})

test("grantInterceptor sends the current grant in x-capability-grant, never a Bearer", async () => {
  let token = "first"
  const icpt = grantInterceptor(() => token)
  const header = new Headers()
  const next = async (req: { header: Headers }) => req as never
  const call = { service: HarnessCallbackService, method: HarnessCallbackService.method.getMissionRunHistory, header }
  await icpt(next as never)(call as never)
  assert.equal(header.get(CAPABILITY_GRANT_HEADER), "first")
  assert.equal(header.get("authorization"), null)
  token = "second"
  await icpt(next as never)(call as never)
  assert.equal(header.get(CAPABILITY_GRANT_HEADER), "second")
})

test("grantInterceptor sends no grant on ClaimFork: the identity token is the only proof (D80)", async () => {
  const icpt = grantInterceptor(() => "source-grant")
  const header = new Headers({ [CAPABILITY_GRANT_HEADER]: "set-by-the-caller" })
  const next = async (req: { header: Headers }) => req as never
  await icpt(next as never)({ service: HarnessCallbackService, method: HarnessCallbackService.method.claimFork, header } as never)
  assert.equal(header.get(CAPABILITY_GRANT_HEADER), null)
})

/** Manual timers: the test fires what the harness scheduled. */
function manualTimers() {
  const pending: { fn: () => void; delay: number; id: number }[] = []
  let seq = 0
  return {
    pending,
    setTimeout: ((fn: () => void, delay: number) => {
      const id = ++seq
      pending.push({ fn, delay, id })
      return id
    }) as unknown as typeof setTimeout,
    clearTimeout: ((id: number) => {
      const i = pending.findIndex((p) => p.id === id)
      if (i >= 0) pending.splice(i, 1)
    }) as unknown as typeof clearTimeout,
    fire: async () => {
      const p = pending.shift()
      if (!p) throw new Error("nothing scheduled")
      p.fn()
      await new Promise((r) => setImmediate(r))
    },
  }
}

test("openTaskHarness renews the grant before it expires and swaps the token in place", async () => {
  const now = 100_000 // ms; grant exp is 1_000s => 900s remaining
  const renewed: { agentId: string; missionId: string; taskId: string }[] = []
  const transport = createRouterTransport(({ service }) => {
    service(DaemonService, {
      renewCapabilityGrant: async (req) => {
        renewed.push({ agentId: req.agentId, missionId: req.missionId, taskId: req.taskId })
        return { capabilityGrant: fakeJwt({ ...CLAIMS, exp: 2_800 }), expiresAtUnix: 2_800n }
      },
    })
  })
  const timers = manualTimers()
  const seen: unknown[] = []
  const h = openTaskHarness({
    endpoint: "daemon.example:443",
    token: fakeJwt(CLAIMS),
    transport,
    timers,
    clock: () => now,
    onRenew: (r) => seen.push(r),
  })

  assert.equal(h.endpoint, "daemon.example:443", "the endpoint is kept for a later process to reuse")
  assert.equal(timers.pending.length, 1, "one renewal scheduled at open")
  assert.equal(timers.pending[0]!.delay, Math.floor(900_000 * 0.8), "renews at 80% of remaining life")

  await timers.fire()
  assert.deepEqual(renewed, [{ agentId: "component:agent:zerocool", missionId: "m-1", taskId: "run-1" }])
  assert.equal(decodeGrantClaims(h.token()).exp, 2_800, "the harness now presents the renewed grant")
  assert.equal(h.expiresAt(), 2_800_000)
  assert.equal(timers.pending.length, 1, "the next renewal is scheduled from the new expiry")
  assert.deepEqual(seen, [{ token: h.token(), expiresAt: 2_800_000 }])

  h.stop()
  assert.equal(timers.pending.length, 0, "stop cancels the pending renewal")
})

test("a failed renewal keeps the current grant and tries again", async () => {
  const transport = createRouterTransport(({ service }) => {
    service(DaemonService, {
      renewCapabilityGrant: async () => {
        throw new Error("daemon rolling")
      },
    })
  })
  const timers = manualTimers()
  const seen: unknown[] = []
  const first = fakeJwt(CLAIMS)
  const h = openTaskHarness({ endpoint: "d:443", token: first, transport, timers, clock: () => 100_000, onRenew: (r) => seen.push(r) })
  await timers.fire()
  assert.equal(h.token(), first)
  assert.ok((seen[0] as { error?: unknown }).error, "the failure is reported")
  assert.equal(timers.pending.length, 1, "and a retry is scheduled")
  h.stop()
})

test("openTaskHarness refuses an empty grant and never schedules without an exp", () => {
  assert.throws(() => openTaskHarness({ endpoint: "d:443", token: "" }), /refusing to dial/)
  const timers = manualTimers()
  const h = openTaskHarness({
    endpoint: "d:443",
    token: fakeJwt({ ...CLAIMS, exp: undefined }),
    transport: createRouterTransport(() => {}),
    timers,
  })
  assert.equal(timers.pending.length, 0)
  assert.equal(h.expiresAt(), 0)
  h.stop()
})

test("a grant with a far-future exp renews at Node's timer ceiling, not at once", () => {
  const timers = manualTimers()
  const h = openTaskHarness({
    endpoint: "d:443",
    token: fakeJwt({ ...CLAIMS, exp: 4_000_000_000 }),
    transport: createRouterTransport(() => {}),
    timers,
    clock: () => 0,
  })
  assert.equal(timers.pending.length, 1)
  assert.equal(timers.pending[0]!.delay, 2_147_483_647, "delay above 2^31-1 would fire immediately")
  h.stop()
})

test("the mission run from the launch rides in ContextInfo, and only when the launch named one", () => {
  const open = (missionRunId?: string) =>
    openTaskHarness({
      endpoint: "d:443",
      token: fakeJwt(CLAIMS),
      transport: createRouterTransport(() => {}),
      renew: false,
      ...(missionRunId ? { missionRunId } : {}),
    })

  const withRun = open("mr-7")
  assert.deepEqual(withRun.context, { missionId: "m-1", taskId: "run-1", agentName: "zerocool", missionRunId: "mr-7" })
  const onWire = create(ContextInfoSchema, withRun.context)
  assert.equal(onWire.missionRunId, "mr-7", "the daemon identifies the calling member by mission_run_id")

  const withoutRun = open()
  assert.deepEqual(withoutRun.context, { missionId: "m-1", taskId: "run-1", agentName: "zerocool" })
  const bare = create(ContextInfoSchema, withoutRun.context)
  assert.equal(bare.missionRunId, "", "no run named, the field stays empty")
  const bareJson = { missionId: "m-1", taskId: "run-1", agentName: "zerocool" }
  assert.deepEqual(toJson(ContextInfoSchema, bare), bareJson)
  assert.deepEqual(toJson(ContextInfoSchema, onWire), { ...bareJson, missionRunId: "mr-7" }, "nothing else on the wire changes")
})

/**
 * A fake setec identity socket (setec#235). Each request gets a new token of
 * the current generation. A snapshot raises the generation.
 */
async function fakeIdentitySocket(answer?: (res: import("node:http").ServerResponse) => void) {
  const { createServer } = await import("node:http")
  const { mkdtempSync, rmSync } = await import("node:fs")
  const { tmpdir } = await import("node:os")
  const { join } = await import("node:path")
  const dir = mkdtempSync(join(tmpdir(), "id"))
  const path = join(dir, "identity.sock")
  const state = { generation: 0, requests: 0, audiences: [] as string[] }
  const server = createServer((req, res) => {
    state.requests++
    state.audiences.push(new URL(req.url ?? "", "http://x").searchParams.get("audience") ?? "")
    if (answer) return answer(res)
    res.setHeader("Content-Type", "application/json")
    res.end(JSON.stringify({ token: `gen${state.generation}-req${state.requests}`, expires: 1 }))
  })
  await new Promise<void>((r) => server.listen(path, r))
  return {
    path,
    state,
    snapshot: () => void state.generation++,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Run the interceptor once and return the headers that the call carried. */
async function callWith(icpt: ReturnType<typeof sandboxIdentityInterceptor>): Promise<Headers> {
  const header = new Headers()
  await icpt((async (req: { header: Headers }) => req) as never)({ header } as never)
  return header
}

test("each call carries a new identity token for the daemon audience, and the hostname", async () => {
  const sock = await fakeIdentitySocket()
  try {
    const icpt = sandboxIdentityInterceptor({ [IDENTITY_SOCKET_ENV]: sock.path })
    const first = await callWith(icpt)
    assert.equal(first.get(SANDBOX_IDENTITY_HEADER), "gen0-req1")
    assert.equal(first.get(SANDBOX_ID_HEADER), hostname().trim())
    assert.equal((await callWith(icpt)).get(SANDBOX_IDENTITY_HEADER), "gen0-req2")
    assert.deepEqual(sock.state.audiences, [SANDBOX_IDENTITY_AUDIENCE, SANDBOX_IDENTITY_AUDIENCE])
  } finally {
    await sock.close()
  }
})

test("a fork after a snapshot sends its own token, never a cached parent token", async () => {
  const sock = await fakeIdentitySocket()
  try {
    const icpt = sandboxIdentityInterceptor({ [IDENTITY_SOCKET_ENV]: sock.path })
    assert.equal((await callWith(icpt)).get(SANDBOX_IDENTITY_HEADER), "gen0-req1")
    sock.snapshot()
    assert.equal((await callWith(icpt)).get(SANDBOX_IDENTITY_HEADER), "gen1-req2")
  } finally {
    await sock.close()
  }
})

test("a missing token is a clear error", async () => {
  // No socket: no token, and the call goes on for the daemon to decide.
  await assert.rejects(sandboxIdentityToken({}), NoSandboxIdentityError)
  const none = await callWith(sandboxIdentityInterceptor({}))
  assert.equal(none.get(SANDBOX_IDENTITY_HEADER), null)

  // A socket that refuses: the call stops with Unauthenticated and the cause.
  const refusing = await fakeIdentitySocket((res) => {
    res.statusCode = 502
    res.end(JSON.stringify({ error: "reach the launcher: no route" }))
  })
  try {
    const env = { [IDENTITY_SOCKET_ENV]: refusing.path }
    let reached = false
    const icpt = sandboxIdentityInterceptor(env)
    await assert.rejects(
      icpt((async () => {
        reached = true
      }) as never)({ header: new Headers() } as never),
      (err: unknown) => err instanceof ConnectError && err.code === Code.Unauthenticated && /reach the launcher: no route/.test(err.message),
    )
    assert.equal(reached, false, "a call with no token is not sent")
  } finally {
    await refusing.close()
  }

  // A socket that is gone, an answer with no token, an answer with no JSON.
  await assert.rejects(sandboxIdentityToken({ [IDENTITY_SOCKET_ENV]: "/nonexistent/gone.sock" }), /gone\.sock/)
  const empty = await fakeIdentitySocket((res) => res.end("{}"))
  const garbage = await fakeIdentitySocket((res) => res.end("not json"))
  try {
    await assert.rejects(sandboxIdentityToken({ [IDENTITY_SOCKET_ENV]: empty.path }), /no token/)
    await assert.rejects(sandboxIdentityToken({ [IDENTITY_SOCKET_ENV]: garbage.path }), /no JSON/)
  } finally {
    await empty.close()
    await garbage.close()
  }
})
