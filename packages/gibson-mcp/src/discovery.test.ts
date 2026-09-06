// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createClient, createRouterTransport } from "@connectrpc/connect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import type { GibsonSession } from "@zeroroot-ai/sdk"
import { ComponentService } from "@zeroroot-ai/sdk/gen/gibson/component/v1/component_pb.js"
import { startDiscovery, toolKey, pluginKey } from "./discovery.js"
import { ToolRegistry } from "./registry.js"
import { attachServer } from "./server.js"

/** A daemon whose catalog a test can change between polls. */
function fakeDaemon(state: { tools: string[]; plugins: string[]; fail?: boolean }) {
  const transport = createRouterTransport(({ service }) => {
    service(ComponentService, {
      listTools: () => {
        if (state.fail) throw new Error("catalog unreachable")
        return { tools: state.tools.map((name) => ({ name, version: "1.0.0", description: `the ${name} tool`, tags: [], inputMessageType: `gibson.tool.v1.${name}Request`, outputMessageType: "" })) }
      },
      listAvailablePlugins: () => ({
        plugins: state.plugins.map((name) => ({ name, version: "1.0.0", description: `the ${name} plugin`, methods: ["run"], configSchemaJson: "", enabled: true, configured: true, healthStatus: "healthy" })),
      }),
      callTool: (req) => ({ outputJson: JSON.stringify({ called: req.toolName, input: JSON.parse(req.inputJson) }) }),
      queryPlugin: (req) => ({ resultJson: JSON.stringify({ called: `${req.pluginName}.${req.method}` }) }),
    })
  })
  const session: GibsonSession = {
    transport,
    clients: { component: createClient(ComponentService, transport), harness: {} as never },
    componentScope: "scope-1",
    instance: { current: () => "i", heartbeatIntervalMs: () => 1000, renew: async () => "i" },
    instanceId: "i",
    stop: () => {},
  }
  return session
}

const quiet = () => {}

test("a tool checked in between two polls appears, and the host is told the list changed", async () => {
  const state = { tools: ["nmap"], plugins: [] as string[] }
  const registry = new ToolRegistry()
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = await attachServer({ registry }, serverSide)
  const client = new Client({ name: "host", version: "0" })
  await client.connect(clientSide)
  let changed = 0
  client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed += 1
  })

  // One pass at a time: the interval is the production cadence, and a test
  // that waited 60 seconds would prove nothing extra.
  const discovery = startDiscovery({ group: registry.group(), session: fakeDaemon(state), log: quiet, intervalMs: 0 })
  const first = await discovery.refresh()
  assert.equal(first.tools, 1)
  assert.equal(first.changed, true)
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name), [toolKey("nmap")])

  state.tools = ["nmap", "nuclei"]
  const second = await discovery.refresh()
  assert.equal(second.changed, true)
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual((await client.listTools()).tools.map((t) => t.name).sort(), [toolKey("nmap"), toolKey("nuclei")])
  assert.ok(changed >= 2, `expected a tools/list_changed per pass, saw ${changed}`)

  // A pass that changes nothing must not wake every host for no reason.
  const seen = changed
  const third = await discovery.refresh()
  assert.equal(third.changed, false)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(changed, seen)

  discovery.stop()
  await client.close()
  await server.close()
})

test("a tool that leaves the catalog leaves the tool list", async () => {
  const state = { tools: ["nmap", "nuclei"], plugins: ["gitlab"] }
  const registry = new ToolRegistry()
  const discovery = startDiscovery({ group: registry.group(), session: fakeDaemon(state), log: quiet, intervalMs: 0 })
  await discovery.refresh()
  assert.deepEqual(registry.list().map((t) => t.name).sort(), [pluginKey("gitlab"), toolKey("nmap"), toolKey("nuclei")].sort())
  state.tools = ["nmap"]
  state.plugins = []
  await discovery.refresh()
  assert.deepEqual(registry.list().map((t) => t.name), [toolKey("nmap")])
  discovery.stop()
})

test("a failed poll keeps the tools already registered", async () => {
  const state = { tools: ["nmap"], plugins: [] as string[], fail: false }
  const registry = new ToolRegistry()
  const discovery = startDiscovery({ group: registry.group(), session: fakeDaemon(state), log: quiet, intervalMs: 0 })
  await discovery.refresh()
  assert.equal(registry.size(), 1)
  state.fail = true
  await assert.rejects(discovery.refresh())
  assert.equal(registry.size(), 1, "a transient fault must not take a working tool away mid-task")
  discovery.stop()
})

test("a discovered tool calls through the harness and returns the daemon's output", async () => {
  const registry = new ToolRegistry()
  const discovery = startDiscovery({ group: registry.group(), session: fakeDaemon({ tools: ["nmap"], plugins: ["gitlab"] }), log: quiet, intervalMs: 0 })
  await discovery.refresh()
  const tool = registry.get(toolKey("nmap"))!
  assert.match(tool.description, /gibson\.tool\.v1\.nmapRequest/)
  const res = await tool.handler({ input: { host: "example.com" } }, {})
  assert.match((res.content as { text: string }[])[0]!.text, /"called": "nmap"/)

  const plugin = registry.get(pluginKey("gitlab"))!
  const out = await plugin.handler({ method: "run" }, {})
  assert.match((out.content as { text: string }[])[0]!.text, /gitlab\.run/)
  discovery.stop()
})

test("a catalog name that is not a legal tool name is made into one", () => {
  assert.equal(toolKey("scan.web/v2"), "gibson_scan_web_v2")
  assert.equal(pluginKey("git lab"), "gibson_plugin_git_lab")
})

test("a discovered tool never takes a name a helper already owns", async () => {
  const registry = new ToolRegistry()
  const group = registry.group()
  // `gibson_call_tool` is a helper. A tenant tool literally called
  // `call_tool` would collide with it.
  registry.register({ name: toolKey("call_tool"), description: "the helper", inputSchema: { type: "object" }, handler: async () => ({ content: [] }) })
  const discovery = startDiscovery({ group, session: fakeDaemon({ tools: ["call_tool"], plugins: [] }), log: quiet, intervalMs: 0 })
  await discovery.refresh()
  assert.equal(registry.get(toolKey("call_tool"))?.description, "the helper")
  discovery.stop()
})
