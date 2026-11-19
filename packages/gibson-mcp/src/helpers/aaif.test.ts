// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"
import { HarnessCallbackService } from "@zeroroot-ai/sdk"
import { EXTENSION_KEY, Role, TaskState, type A2AMessage, type A2ATask, type LiveMission, type TaskHarness } from "@zeroroot-ai/sdk"
import type { Gibson } from "../session.js"
import { gatewayStub } from "../gateway-stub.test.js"
import { helperToolsFor } from "./index.js"
import { evidenceTypeToProto } from "./findings.js"
import { EvidenceType } from "@zeroroot-ai/sdk/gen/gibson/types/v1/types_pb.js"

function gibson(parts: Partial<Gibson>): Gibson {
  return {
    source: "dispatched",
    mode: "task",
    reason: "",
    agentName: "gibson-mcp",
    hostKeyPath: "/tmp/host.key",
    settings: { callbackInsecure: false, hostKeyPath: "/tmp/host.key", agentName: "gibson-mcp" },
    close: async () => {},
    ...parts,
  }
}

function liveWith(harness: Partial<TaskHarness>): LiveMission {
  const h = {
    ...gatewayStub,
    transport: createRouterTransport(() => {}),
    client: {} as never,
    endpoint: "d:1",
    context: { missionId: "m-1", taskId: "t-1", agentName: "gibson-mcp", missionRunId: "run-1" },
    token: () => "tok",
    expiresAt: () => 0,
    stop: () => {},
    ...harness,
  } as TaskHarness
  return { missionId: "m-1", workId: "w-1", harness: h, end: async () => {} }
}

const tool = (g: Gibson, name: string) => helperToolsFor(g, "/tmp", {}).find((t) => t.name === name)

test("delegate sends an A2A message through the harness and returns the Task state", async () => {
  let sent: { name: string; msg: A2AMessage; opts: unknown } | undefined
  const reply: A2ATask = {
    id: "t-1",
    contextId: "c-1",
    status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
  const live = liveWith({
    delegate: async (name, msg, opts) => {
      sent = { name, msg, opts }
      return reply
    },
  })
  const t = tool(gibson({ live }), "delegate")
  assert.ok(t, "a run with a task grant can delegate")
  const res = await t.handler(
    { agent: "helper", goal: "scan it", context: { host: "10.0.0.1" }, max_turns: 3, bank_id: "bank-1" },
    {},
  )
  assert.notEqual(res.isError, true)
  const body = (res.content as { text: string }[])[0]!.text
  assert.match(body, /helper: TASK_STATE_COMPLETED/)
  assert.equal(sent?.name, "helper")
  assert.deepEqual(sent?.opts, { bankId: "bank-1" })
  assert.equal(sent?.msg.role, Role.ROLE_USER)
  assert.equal(sent?.msg.parts[0]?.content?.$case, "text")
  assert.deepEqual(sent?.msg.metadata?.[EXTENSION_KEY], { context: { host: "10.0.0.1" }, constraints: { max_turns: 3 } })
})

test("delegate reports a failure of the delegation as a tool error", async () => {
  const live = liveWith({
    delegate: async () => {
      throw new Error("no task grant: the agent has no task grant to send to the gateway")
    },
  })
  const res = await tool(gibson({ live }), "delegate")!.handler({ agent: "helper", goal: "x" }, {})
  assert.equal(res.isError, true)
  assert.match((res.content as { text: string }[])[0]!.text, /no task grant/)
})

test("there is no list_agents tool, and a component with no grant has no delegate tool", () => {
  const names = helperToolsFor(gibson({ live: liveWith({}) }), "/tmp", {}).map((t) => t.name)
  assert.ok(!names.includes("list_agents"))
  assert.ok(names.includes("delegate"))
  assert.equal(tool(gibson({ source: "enrolled", mode: "component", live: undefined }), "delegate"), undefined)
})

test("submit_finding sends tool_call_ids on the typed callback request", async () => {
  let req: { toolCallIds: string[]; finding?: { evidence: { type: number; tier?: number }[] } } | undefined
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, {
      submitFinding: (r) => {
        req = r as never
        return {}
      },
    })
  })
  const live = liveWith({ transport, client: undefined as never })
  // The typed backend calls harness.client, so give it a real client on the router transport.
  const { createClient } = await import("@connectrpc/connect")
  live.harness.client = createClient(HarnessCallbackService, transport)
  const res = await tool(gibson({ live }), "submit_finding")!.handler(
    {
      title: "t",
      description: "d",
      category: "c",
      severity: "high",
      evidence: "GET / 200",
      tool_call_ids: ["tc-1", "tc-2"],
    },
    {},
  )
  assert.notEqual(res.isError, true, JSON.stringify(res))
  assert.deepEqual(req?.toolCallIds, ["tc-1", "tc-2"])
  assert.equal(req?.finding?.evidence[0]?.type, EvidenceType.OTHER)
  assert.ok(!req?.finding?.evidence[0]?.tier, "an agent sets no evidence tier")
})

test("the evidence type strings map to the proto enum and an unknown one is OTHER", () => {
  assert.equal(evidenceTypeToProto("http_request"), EvidenceType.REQUEST)
  assert.equal(evidenceTypeToProto("code_snippet"), EvidenceType.CODE)
  assert.equal(evidenceTypeToProto("network_trace"), EvidenceType.NETWORK_TRACE)
  assert.equal(evidenceTypeToProto("whatever"), EvidenceType.OTHER)
})
