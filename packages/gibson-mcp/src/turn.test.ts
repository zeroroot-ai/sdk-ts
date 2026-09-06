// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport, type Transport } from "@connectrpc/connect"
import { CAPABILITY_GRANT_HEADER, HarnessCallbackService, type TaskHarness } from "@zeroroot-ai/sdk"
import { rpcTools } from "./rpc.js"
import { createTurnController, TURN_GRANT_HEADER } from "./turn.js"

/**
 * A harness whose transport records the grant header of every call, so a
 * test can see which credential a tool call actually carried.
 */
function recordingHarness(seen: string[], token = "base-grant"): TaskHarness {
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, { worldView: () => ({ entities: [], truncated: false }) })
  })
  // `openTaskHarness` builds its transport with the grant interceptor, so
  // the base transport already carries the base grant. The fake does the
  // same, then records whatever grant the call ended up with.
  const wrapped: Transport = {
    unary: (method, signal, timeoutMs, header, input, ctx) => {
      const h = new Headers(header)
      if (!h.get(CAPABILITY_GRANT_HEADER)) h.set(CAPABILITY_GRANT_HEADER, token)
      seen.push(h.get(CAPABILITY_GRANT_HEADER) ?? "")
      return transport.unary(method, signal, timeoutMs, h, input, ctx)
    },
    stream: (method, signal, timeoutMs, header, input, ctx) => {
      const h = new Headers(header)
      if (!h.get(CAPABILITY_GRANT_HEADER)) h.set(CAPABILITY_GRANT_HEADER, token)
      seen.push(h.get(CAPABILITY_GRANT_HEADER) ?? "")
      return transport.stream(method, signal, timeoutMs, h, input, ctx)
    },
  }
  return {
    transport: wrapped,
    client: {} as never,
    endpoint: "daemon:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "claude" },
    token: () => token,
    expiresAt: () => 0,
    stop: () => {},
  }
}

/** Build the turn transport over the recording one, so every hop is visible. */
function controllerOver(base: TaskHarness) {
  return createTurnController({
    base,
    // The real controller dials the callback endpoint over gRPC. The test
    // gives it the same transport with the grant interceptor it would build,
    // so what is under test is which token the interceptor reads.
    makeTransport: (_baseUrl, token) => ({
      unary: (method, signal, timeoutMs, header, input, ctx) => {
        const h = new Headers(header)
        h.set(CAPABILITY_GRANT_HEADER, token())
        return base.transport.unary(method, signal, timeoutMs, h, input, ctx)
      },
      stream: (method, signal, timeoutMs, header, input, ctx) => {
        const h = new Headers(header)
        h.set(CAPABILITY_GRANT_HEADER, token())
        return base.transport.stream(method, signal, timeoutMs, h, input, ctx)
      },
    }),
  })
}

async function callWorldView(harness: TaskHarness, transport: Transport): Promise<void> {
  const tool = rpcTools({ channels: { task: { ...harness, transport } }, streamLimit: 10 }).find((t) => t.name === "harness_callback_service_world_view")!
  const res = await tool.handler({ focus: [] }, {})
  assert.notEqual(res.isError, true, JSON.stringify(res.content))
}

test("two turns produce two different grants, and a call between them uses the base grant", async () => {
  const seen: string[] = []
  const base = recordingHarness(seen)
  const turns = controllerOver(base)
  const transport = turns.transport()

  turns.set({ jobId: "job-1", grant: "grant-for-job-1", endpoint: base.endpoint, insecure: false })
  await callWorldView(base, transport)

  // Between turns: the dispatch that sent the last message is answered, and
  // holding its grant would attribute later work to a job that is done.
  turns.clear()
  await callWorldView(base, transport)

  turns.set({ jobId: "job-2", grant: "grant-for-job-2", endpoint: base.endpoint, insecure: false })
  await callWorldView(base, transport)

  assert.deepEqual(seen, ["grant-for-job-1", "base-grant", "grant-for-job-2"])
  turns.close()
})

test("a per-request grant applies to that request alone and wins over the turn in force", async () => {
  const seen: string[] = []
  const base = recordingHarness(seen)
  const turns = controllerOver(base)
  const transport = turns.transport()
  turns.set({ jobId: "job-1", grant: "turn-grant", endpoint: base.endpoint, insecure: false })

  await turns.withGrant("header-grant", () => callWorldView(base, transport))
  await callWorldView(base, transport)

  assert.deepEqual(seen, ["header-grant", "turn-grant"])
  assert.equal(turns.current()?.jobId, "job-1", "a per-request grant does not change the turn in force")
  turns.close()
})

test("two turns running at once do not see each other's grant", async () => {
  const seen: string[] = []
  const base = recordingHarness(seen)
  const turns = controllerOver(base)
  const transport = turns.transport()
  // Concurrency is why the per-request grant is async-local storage and not
  // a field: a field would be whatever the last writer set.
  await Promise.all([
    turns.withGrant("grant-a", () => callWorldView(base, transport)),
    turns.withGrant("grant-b", () => callWorldView(base, transport)),
  ])
  assert.deepEqual([...seen].sort(), ["grant-a", "grant-b"])
  turns.close()
})

test("the lifetime transport is the one the launch opened, whatever turn is in force", () => {
  const base = recordingHarness([])
  const turns = controllerOver(base)
  turns.set({ jobId: "job-1", grant: "turn-grant", endpoint: base.endpoint, insecure: false })
  assert.equal(turns.lifetimeTransport(), base.transport)
  assert.notEqual(turns.transport(), base.transport)
  turns.close()
})

test("the header name is the one the driver sends", () => {
  assert.equal(TURN_GRANT_HEADER, "x-gibson-turn-grant")
})
