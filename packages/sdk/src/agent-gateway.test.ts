// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import type { IncomingHttpHeaders } from "node:http"
import test from "node:test"

import { Role, TaskState, Task, Message } from "@a2a-js/sdk"
import { newMessage, textPart, type A2ATask } from "./a2a.js"
import { delegateToResolvedAgent, isSettled } from "./agent-gateway.js"
import { staticGrantHeaders } from "./gateway.js"
import { makeTestCa, startTlsServer } from "./tls-fixture.test.js"

interface RpcCall {
  method: string
  params: Record<string, unknown>
  headers: IncomingHttpHeaders
  path: string
}

function task(id: string, state: TaskState, text?: string): A2ATask {
  return {
    id,
    contextId: "ctx-1",
    status: {
      state,
      message: text ? newMessage(Role.ROLE_AGENT, [textPart(text)], { taskId: id, contextId: "ctx-1" }) : undefined,
      timestamp: new Date().toISOString(),
    },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
}

/** An A2A server on a private CA. `reply` builds the JSON-RPC result of each call. */
async function a2aServer(ca: ReturnType<typeof makeTestCa>, reply: (call: RpcCall, n: number) => unknown) {
  const calls: RpcCall[] = []
  const srv = await startTlsServer(ca, (req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const rpc = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id: unknown
        method: string
        params: Record<string, unknown>
      }
      const call: RpcCall = { method: rpc.method, params: rpc.params, headers: req.headers, path: req.url ?? "" }
      calls.push(call)
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: reply(call, calls.length) }))
    })
  })
  return { ...srv, calls }
}

const userMsg = () => newMessage(Role.ROLE_USER, [textPart("scan 10.0.0.1")], { contextId: "ctx-1" })

test("delegate sends SendMessage with the route headers and the grant, and returns the Task", async () => {
  const ca = makeTestCa()
  const srv = await a2aServer(ca, () => ({ task: Task.toJSON(task("t-1", TaskState.TASK_STATE_COMPLETED)) }))
  try {
    const out = await delegateToResolvedAgent(
      {
        gatewayUrl: `${srv.url}/a2a/helper`,
        routeHeaders: { "x-gibson-agent": "helper" },
        gatewayCaPem: ca.caPem,
        agentCardUrl: "",
      },
      userMsg(),
      { headers: staticGrantHeaders(() => "task-grant") },
    )
    assert.equal(out.id, "t-1")
    assert.equal(out.status?.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(srv.calls.length, 1)
    assert.equal(srv.calls[0]?.method, "SendMessage")
    assert.equal(srv.calls[0]?.path, "/a2a/helper")
    assert.equal(srv.calls[0]?.headers["x-gibson-agent"], "helper")
    assert.equal(srv.calls[0]?.headers["x-capability-grant"], "task-grant")
    assert.equal(srv.calls[0]?.headers.authorization, undefined)
    const sent = (srv.calls[0]?.params.message ?? {}) as { messageId: string; role: string; parts: { text: string }[] }
    assert.ok(sent.messageId, "the SDK sets the message id")
    assert.equal(sent.role, "ROLE_USER")
    assert.equal(sent.parts[0]?.text, "scan 10.0.0.1")
  } finally {
    await srv.close()
    ca.cleanup()
  }
})

test("delegate polls GetTask until the task is settled", async () => {
  const ca = makeTestCa()
  const srv = await a2aServer(ca, (call, n) => {
    if (call.method === "SendMessage") return { task: Task.toJSON(task("t-2", TaskState.TASK_STATE_WORKING)) }
    return Task.toJSON(task("t-2", n < 3 ? TaskState.TASK_STATE_WORKING : TaskState.TASK_STATE_INPUT_REQUIRED, "which port?"))
  })
  try {
    const out = await delegateToResolvedAgent(
      { gatewayUrl: srv.url, routeHeaders: {}, gatewayCaPem: ca.caPem, agentCardUrl: "" },
      userMsg(),
      { pollIntervalMs: 5 },
    )
    assert.equal(out.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
    assert.deepEqual(srv.calls.map((c) => c.method), ["SendMessage", "GetTask", "GetTask"])
    assert.equal(srv.calls[1]?.params.id, "t-2")
  } finally {
    await srv.close()
    ca.cleanup()
  }
})

test("a failed task is a Task, not a thrown error", async () => {
  const ca = makeTestCa()
  const srv = await a2aServer(ca, () => ({ task: Task.toJSON(task("t-3", TaskState.TASK_STATE_FAILED, "boom")) }))
  try {
    const out = await delegateToResolvedAgent(
      { gatewayUrl: srv.url, routeHeaders: {}, gatewayCaPem: ca.caPem, agentCardUrl: "" },
      userMsg(),
    )
    assert.equal(out.status?.state, TaskState.TASK_STATE_FAILED)
  } finally {
    await srv.close()
    ca.cleanup()
  }
})

test("a plain message reply becomes a completed Task that holds the message", async () => {
  const ca = makeTestCa()
  const reply = newMessage(Role.ROLE_AGENT, [textPart("done")], { contextId: "ctx-9" })
  const srv = await a2aServer(ca, () => ({ message: Message.toJSON(reply) }))
  try {
    const out = await delegateToResolvedAgent(
      { gatewayUrl: srv.url, routeHeaders: {}, gatewayCaPem: ca.caPem, agentCardUrl: "" },
      userMsg(),
    )
    assert.equal(out.status?.state, TaskState.TASK_STATE_COMPLETED)
    assert.equal(out.contextId, "ctx-9")
    assert.equal(out.status?.message?.parts[0]?.content?.$case, "text")
  } finally {
    await srv.close()
    ca.cleanup()
  }
})

test("delegate trusts only the bundle of the Agent gateway", async () => {
  const ca = makeTestCa()
  const other = makeTestCa("other-ca")
  const srv = await a2aServer(ca, () => ({ task: Task.toJSON(task("t-4", TaskState.TASK_STATE_COMPLETED)) }))
  try {
    await assert.rejects(
      delegateToResolvedAgent({ gatewayUrl: srv.url, routeHeaders: {}, gatewayCaPem: other.caPem, agentCardUrl: "" }, userMsg()),
    )
    await assert.rejects(
      delegateToResolvedAgent({ gatewayUrl: srv.url, routeHeaders: {}, gatewayCaPem: "", agentCardUrl: "" }, userMsg()),
    )
    assert.equal(srv.calls.length, 0)
  } finally {
    await srv.close()
    ca.cleanup()
    other.cleanup()
  }
})

test("delegate refuses a missing URL and a bundle with an http URL", async () => {
  const ca = makeTestCa()
  try {
    await assert.rejects(
      delegateToResolvedAgent({ gatewayUrl: "", routeHeaders: {}, gatewayCaPem: "", agentCardUrl: "" }, userMsg()),
      /no gateway URL/,
    )
    await assert.rejects(
      delegateToResolvedAgent(
        { gatewayUrl: "http://gateway.example", routeHeaders: {}, gatewayCaPem: ca.caPem, agentCardUrl: "" },
        userMsg(),
      ),
      /https/,
    )
  } finally {
    ca.cleanup()
  }
})

test("isSettled names the terminal and the interrupted states", () => {
  assert.equal(isSettled(TaskState.TASK_STATE_SUBMITTED), false)
  assert.equal(isSettled(TaskState.TASK_STATE_WORKING), false)
  assert.equal(isSettled(TaskState.TASK_STATE_UNSPECIFIED), false)
  for (const s of [
    TaskState.TASK_STATE_COMPLETED,
    TaskState.TASK_STATE_FAILED,
    TaskState.TASK_STATE_CANCELED,
    TaskState.TASK_STATE_REJECTED,
    TaskState.TASK_STATE_INPUT_REQUIRED,
    TaskState.TASK_STATE_AUTH_REQUIRED,
  ]) {
    assert.equal(isSettled(s), true)
  }
})
