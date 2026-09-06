// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"

import { DaemonService } from "./gen/gibson/daemon/v1/daemon_pb.js"
import {
  CAPABILITY_GRANT_HEADER,
  contextFromGrant,
  decodeGrantClaims,
  grantInterceptor,
  openTaskHarness,
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
  await icpt(next as never)({ header } as never)
  assert.equal(header.get(CAPABILITY_GRANT_HEADER), "first")
  assert.equal(header.get("authorization"), null)
  token = "second"
  await icpt(next as never)({ header } as never)
  assert.equal(header.get(CAPABILITY_GRANT_HEADER), "second")
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
