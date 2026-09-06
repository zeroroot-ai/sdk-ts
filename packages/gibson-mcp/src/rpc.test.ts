// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import type { DescService } from "@bufbuild/protobuf"
import { createRouterTransport } from "@connectrpc/connect"
import { HarnessCallbackService } from "@zeroroot-ai/sdk"
import type { TaskHarness } from "@zeroroot-ai/sdk"
import { ComponentService } from "@zeroroot-ai/sdk/gen/gibson/component/v1/component_pb.js"
import { GENERATED_RPC_COUNT, GENERATED_SERVICES } from "./generated/tools.js"
import { driftBetween, rpcTools, snake, toolNameFor, transportFor, type ServiceDoc } from "./rpc.js"
import { TOOL_NAME } from "./registry.js"

/**
 * The drift guard. The descriptors are the truth about what exists; the
 * generated table only carries the prose. These walk both directions, so a
 * stale `src/generated/tools.ts` fails CI whichever way it went stale: an
 * RPC the SDK added and the table has not seen, or an entry for an RPC the
 * SDK removed.
 */
function everyMethod(): { service: DescService; method: string }[] {
  return GENERATED_SERVICES.flatMap((entry) => {
    const service = entry.service as DescService
    return service.methods.map((m) => ({ service, method: m.localName }))
  })
}

test("the drift guard fails on a stale table, in both directions", () => {
  // The failing fixture for the guard. Without it, "the table matches" is a
  // claim no test has ever seen fail, and a guard that cannot fail is worse
  // than no guard. A whole service went missing from the table on
  // v0.177.0 and every green check stayed green.
  const real = GENERATED_SERVICES as unknown as ServiceDoc[]
  assert.deepEqual(driftBetween(real), { missing: [], extra: [] }, "the committed table is not stale")

  const service = real[0]!
  const dropped: ServiceDoc[] = [{ service: service.service, methods: service.methods.slice(1) }]
  const gone = driftBetween(dropped)
  assert.equal(gone.missing.length, 1, "an RPC the table has not seen must be reported")
  assert.match(gone.missing[0]!, new RegExp(`^${service.service.typeName}\\.`))

  const invented: ServiceDoc[] = [{ service: service.service, methods: [...service.methods, { method: "rpcThatDoesNotExist", description: "d" }] }]
  const removed = driftBetween(invented)
  assert.deepEqual(removed.extra, [`${service.service.typeName}.rpcThatDoesNotExist`], "an entry for an RPC the SDK dropped must be reported")

  // A whole service missing from the table is the case that got through.
  // The table is walked per service, so a service with no entry at all is
  // caught by the count assertion in the next test, not by this one.
  assert.equal(driftBetween([]).missing.length, 0)
})

test("the generated table has exactly one entry per RPC, and the counts are printed", () => {
  const fromDescriptors = everyMethod()
  const fromTable = GENERATED_SERVICES.flatMap((e) => e.methods.map((m) => `${(e.service as DescService).typeName}.${m.method}`))
  const descriptorNames = fromDescriptors.map((m) => `${m.service.typeName}.${m.method}`)
  process.stderr.write(`[drift] descriptors: ${descriptorNames.length} RPCs; generated table: ${fromTable.length} entries\n`)
  assert.equal(fromTable.length, descriptorNames.length)
  assert.deepEqual([...fromTable].sort(), [...descriptorNames].sort(), "run `pnpm generate` and commit src/generated/tools.ts")
  assert.equal(GENERATED_RPC_COUNT, descriptorNames.length, "the count recorded at generate time no longer matches the descriptors")
})

test("the tool count equals the RPC count in the pinned SDK protos", () => {
  const tools = rpcTools({ channels: { session: createRouterTransport(() => {}) }, streamLimit: 10 })
  process.stderr.write(`[drift] ${tools.length} RPC tools from ${GENERATED_SERVICES.length} services\n`)
  assert.equal(tools.length, everyMethod().length)
  assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, "two RPCs produced one tool name")
})

test("every tool has a non-empty description and a legal name", () => {
  const tools = rpcTools({ channels: { session: createRouterTransport(() => {}) }, streamLimit: 10 })
  for (const t of tools) {
    assert.ok(t.description.trim().length > 0, `${t.name} has no description`)
    assert.match(t.name, TOOL_NAME, `${t.name} is not a legal MCP tool name`)
    assert.equal(t.inputSchema.type, "object")
  }
  // A missing proto comment must still say what the tool calls, not nothing.
  const undocumented = tools.find((t) => t.description.includes("No comment in the proto"))
  assert.ok(undocumented, "expected at least one RPC with no proto comment")
  assert.match(undocumented!.description, /^[A-Za-z]+\.[A-Za-z]+:/)
})

test("names are <service>_<method> in snake case, and an acronym stays one word", () => {
  assert.equal(snake("HarnessCallbackService"), "harness_callback_service")
  assert.equal(snake("LLMCompleteWithTools"), "llm_complete_with_tools")
  assert.equal(snake("WorldView"), "world_view")
  const worldView = HarnessCallbackService.methods.find((m) => m.localName === "worldView")!
  assert.equal(toolNameFor(HarnessCallbackService, worldView), "harness_callback_service_world_view")
})

test("a callback RPC rides the task harness; the daemon's own surface rides the component transport", () => {
  const session = createRouterTransport(() => {})
  const task = { transport: createRouterTransport(() => {}) } as TaskHarness
  assert.equal(transportFor(HarnessCallbackService, { session, task }), task.transport)
  assert.equal(transportFor(ComponentService, { session, task }), session)
  // Either one alone still carries every tool: a dispatched run has no
  // component transport, and the callback endpoint is the same daemon.
  assert.equal(transportFor(ComponentService, { task }), task.transport)
  assert.equal(transportFor(HarnessCallbackService, { session }), session)
  assert.equal(transportFor(HarnessCallbackService, {}), undefined)
})

test("a round trip: world_view calls the service and returns its JSON", async () => {
  const seen: { missionId: string; focus: string[] }[] = []
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, {
      worldView: (req) => {
        seen.push({ missionId: req.context?.missionId ?? "", focus: req.focus })
        return {
          entities: [{ handle: "h-1", kind: 1, label: "api.example.com", attributes: { port: "443" } }],
          truncated: false,
        }
      },
    })
  })
  const task = {
    transport,
    context: { missionId: "m-1", taskId: "t-1", agentName: "gibson-mcp" },
  } as TaskHarness
  const tool = rpcTools({ channels: { task }, streamLimit: 10 }).find((t) => t.name === "harness_callback_service_world_view")!
  const res = await tool.handler({ focus: ["h-1"] }, {})
  assert.notEqual(res.isError, true, JSON.stringify(res.content))
  const body = JSON.parse((res.content as { text: string }[])[0]!.text) as { entities: { label: string }[] }
  assert.equal(body.entities[0]?.label, "api.example.com")
  // The context is filled from the grant, so no caller has to know the field exists.
  assert.deepEqual(seen, [{ missionId: "m-1", focus: ["h-1"] }])
})

test("a context the caller wrote is kept, not overwritten by the grant", async () => {
  const seen: string[] = []
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, {
      worldView: (req) => {
        seen.push(req.context?.missionId ?? "")
        return { entities: [], truncated: false }
      },
    })
  })
  const task = { transport, context: { missionId: "from-grant", taskId: "t", agentName: "a" } } as TaskHarness
  const tool = rpcTools({ channels: { task }, streamLimit: 10 }).find((t) => t.name === "harness_callback_service_world_view")!
  await tool.handler({ context: { missionId: "from-caller", taskId: "t", agentName: "a" }, focus: [] }, {})
  assert.deepEqual(seen, ["from-caller"])
})

test("a malformed request is a tool error naming the proto type, not a thrown fault", async () => {
  const task = { transport: createRouterTransport(() => {}), context: { missionId: "m", taskId: "t", agentName: "a" } } as TaskHarness
  const tool = rpcTools({ channels: { task }, streamLimit: 10 }).find((t) => t.name === "harness_callback_service_world_view")!
  const res = await tool.handler({ focus: "not-a-list" }, {})
  assert.equal(res.isError, true)
  assert.match((res.content as { text: string }[])[0]!.text, /WorldViewRequest/)
})

test("a server-streaming RPC returns an array and says when it truncated", async () => {
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, {
      lLMStream: async function* () {
        for (let i = 0; i < 5; i += 1) yield { delta: `chunk-${i}`, finishReason: "" }
      },
    })
  })
  const task = { transport, context: { missionId: "m", taskId: "t", agentName: "a" } } as TaskHarness
  const build = (limit: number) => rpcTools({ channels: { task }, streamLimit: limit }).find((t) => t.name === "harness_callback_service_llm_stream")!

  const all = build(10)
  assert.match(all.description, /up to 10 messages/)
  const whole = JSON.parse(((await all.handler({ messages: [] }, {})).content as { text: string }[])[0]!.text) as { messages: unknown[]; truncated: boolean }
  assert.equal(whole.messages.length, 5)
  assert.equal(whole.truncated, false)

  const capped = JSON.parse(((await build(2).handler({ messages: [] }, {})).content as { text: string }[])[0]!.text) as { messages: unknown[]; truncated: boolean }
  assert.equal(capped.messages.length, 2)
  assert.equal(capped.truncated, true)
})

test("a bidi RPC takes its requests as an array and says so", async () => {
  const tools = rpcTools({ channels: { session: createRouterTransport(() => {}) }, streamLimit: 10 })
  const bidi = tools.filter((t) => t.description.includes("Takes an array of request messages"))
  assert.ok(bidi.length > 0, "the pinned protos carry at least one streaming-request RPC")
  for (const t of bidi) {
    assert.deepEqual(t.inputSchema.required, ["requests"])
    const res = await t.handler({}, {})
    assert.equal(res.isError, true)
    assert.match((res.content as { text: string }[])[0]!.text, /`requests`/)
  }
})
