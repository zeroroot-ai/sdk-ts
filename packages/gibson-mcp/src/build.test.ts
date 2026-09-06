// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js"
import type { GibsonSession, TaskHarness } from "@zeroroot-ai/sdk"
import { buildSurface } from "./build.js"
import { GENERATED_RPC_COUNT } from "./generated/tools.js"
import { helperToolsFor } from "./helpers/index.js"

/**
 * The tool surface per check-in source, seen through a real MCP client over
 * an in-memory transport. The platform is faked at the SDK seam: with no
 * platform URL nothing is dialed.
 */
async function open(env: NodeJS.ProcessEnv, deps = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "gm-build-"))
  // Every path that could read the developer's own state is pointed into the
  // temp directory: a host key at ~/.zerocool/host.key would otherwise make
  // this machine's check-in source the test's.
  const surface = await buildSurface(
    { ZEROCOOL_STATE_DIR: cwd, GIBSON_CLI_CREDENTIALS: join(cwd, "none"), GIBSON_HOST_KEY_PATH: join(cwd, "host.key"), ...env },
    cwd,
    deps,
  )
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = await surface.attach(serverSide)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
  return {
    surface,
    client,
    cwd,
    names: async () => (await client.listTools()).tools.map((t) => t.name).sort(),
    close: async () => {
      await client.close()
      await server.close()
      await surface.close()
    },
  }
}

function fakeHarness(): TaskHarness {
  return {
    transport: createRouterTransport(() => {}),
    client: {} as never,
    endpoint: "d:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "claude" },
    token: () => "tok",
    expiresAt: () => 0,
    stop: () => {},
  }
}

/** The tool names a posture is expected to carry, computed the same way the server does. */
function helperNames(surface: { current: () => Parameters<typeof helperToolsFor>[0] }): string[] {
  return helperToolsFor(surface.current(), "/tmp", {}).map((t) => t.name)
}

test("with no platform the server still serves: status, the way in, and the helpers that need no platform", async () => {
  const s = await open({})
  assert.deepEqual(await s.names(), ["componentize", "gibson_connect", "gibson_login", "gibson_status", "submit_finding", "validate_component"])
  const res = await s.client.callTool({ name: "gibson_status", arguments: {} })
  const body = (res.content as { text: string }[])[0]!.text
  assert.match(body, /source: none/)
  assert.match(body, /posture: standalone/)
  await s.close()
})

test("a dispatched run offers no login and no connect: the launch already decided", async () => {
  const s = await open(
    { GIBSON_CG_JWT: "jwt", GIBSON_CALLBACK_ENDPOINT: "d:50001", GIBSON_MISSION_RUN_ID: "run-3" },
    { open: { harness: () => fakeHarness(), hostKeyExists: () => true } },
  )
  const names = await s.names()
  assert.deepEqual(
    names.filter((n) => n.startsWith("gibson_")).sort(),
    ["gibson_api_call", "gibson_api_search", "gibson_status"],
    "a dispatched run offers no login and no connect",
  )
  // Two tiers (#70): the helpers and the two meta-tools are listed, the 188
  // generated RPC tools are not.
  assert.equal(names.length, helperNames(s.surface).length + 3)
  assert.ok(!names.includes("harness_callback_service_world_view"), "the generated RPC tool is behind the door")
  assert.ok(names.includes("world_view"), "the helper named after the helper stays in front")
  assert.ok(names.includes("remember"))
  // The daemon's own surface still falls back to the callback transport in a
  // dispatched run. It is built, so the door finds it; it is just not listed.
  const found = await s.client.callTool({ name: "gibson_api_search", arguments: { query: "call a tool" } })
  const out = JSON.parse((found.content as { text: string }[])[0]!.text) as { matches: { name: string }[] }
  assert.ok(out.matches.some((m) => m.name === "component_service_call_tool"), "the daemon's own surface falls back to the callback transport")
  const body = ((await s.client.callTool({ name: "gibson_status", arguments: {} })).content as { text: string }[])[0]!.text
  assert.match(body, /source: dispatched/)
  assert.match(body, /posture: task/)
  assert.match(body, /mission: m-1/)
  assert.match(body, /run: run-3/)
  await s.close()
})

test("gibson_status names the tenant, target and component scope once checked in", async () => {
  const session: GibsonSession = {
    transport: createRouterTransport(() => {}),
    clients: { component: {}, harness: {} } as never,
    componentScope: "scope-9",
    instance: { current: () => "inst-1", heartbeatIntervalMs: () => 1000, renew: async () => "inst-1" },
    instanceId: "inst-1",
    stop: () => {},
  }
  const s = await open(
    { GIBSON_PLATFORM_URL: "https://p" },
    { open: { connect: async () => session, hostKeyExists: () => true } },
  )
  const body = ((await s.client.callTool({ name: "gibson_status", arguments: {} })).content as { text: string }[])[0]!.text
  assert.match(body, /source: enrolled/)
  assert.match(body, /posture: component/)
  assert.match(body, /component_scope: scope-9/)
  const names = await s.names()
  assert.equal(
    names.length,
    helperNames(s.surface).length + 5,
    "every helper the posture can reach, plus status, login, connect and the two meta-tools",
  )
  assert.ok(names.includes("gibson_api_search") && names.includes("gibson_api_call"))
  assert.ok(names.includes("delegate"))
  assert.ok(!names.includes("remember"), "a memory is a World write and the component posture holds no mission")
  await s.close()
})

test("standalone carries no RPC tool and no door: a tool with no daemon behind it is worse than no tool", async () => {
  const s = await open({})
  const names = await s.names()
  assert.equal(names.filter((n) => n.includes("_service_")).length, 0)
  assert.ok(!names.includes("gibson_api_search"), "there is no API to search when there is no platform")
  assert.equal(s.surface.health().tools, names.length)
  assert.equal(s.surface.health().api_rpcs, 0)
  await s.close()
})

test("the 188 generated tools are absent by default and present with --expose-all-rpcs", async () => {
  const deps = { open: { harness: () => fakeHarness(), hostKeyExists: () => true } }
  const env = { GIBSON_CG_JWT: "jwt", GIBSON_CALLBACK_ENDPOINT: "d:50001" }

  const hidden = await open(env, deps)
  const byDefault = await hidden.names()
  const generated = byDefault.filter((n) => n.includes("_service_") && n !== "gibson_api_search" && n !== "gibson_api_call")
  assert.deepEqual(generated, [], "no generated RPC tool may be listed by default")
  assert.equal(hidden.surface.health().api_rpcs, GENERATED_RPC_COUNT, "they are built and reachable, just not listed")
  assert.ok(byDefault.includes("gibson_api_search") && byDefault.includes("gibson_api_call"))
  await hidden.close()

  const flat = await open(env, { ...deps, exposeAllRpcs: true })
  const withFlag = await flat.names()
  assert.ok(withFlag.includes("harness_callback_service_world_view"))
  assert.ok(withFlag.includes("component_service_call_tool"))
  assert.equal(withFlag.length, byDefault.length + GENERATED_RPC_COUNT, "the flag adds the flat tier and takes nothing away")
  // The door stays open with the flag on: finding one RPC among 188 is
  // still cheaper through a search than through the list.
  assert.ok(withFlag.includes("gibson_api_search"))
  await flat.close()
})

test("the door reaches an RPC that is not in the tool list", async () => {
  const s = await open(
    { GIBSON_CG_JWT: "jwt", GIBSON_CALLBACK_ENDPOINT: "d:50001" },
    { open: { harness: () => fakeHarness(), hostKeyExists: () => true } },
  )
  const names = await s.names()
  assert.ok(!names.includes("harness_callback_service_world_view"))
  const found = await s.client.callTool({ name: "gibson_api_search", arguments: { query: "world view" } })
  const out = JSON.parse((found.content as { text: string }[])[0]!.text) as { matches: { name: string }[] }
  assert.equal(out.matches[0]?.name, "harness_callback_service_world_view", "a tool absent from the list is still findable")
  await s.close()
})

test("gibson_connect swaps the tool set live and every session hears about it", async () => {
  const session = {
    transport: createRouterTransport(() => {}),
    clients: { component: {}, harness: {} } as never,
    componentScope: "scope-2",
    instance: { current: () => "inst-1", heartbeatIntervalMs: () => 1000, renew: async () => "inst-1" },
    instanceId: "inst-1",
    stop: () => {},
  }
  const s = await open({}, { open: { connect: async () => session, hostKeyExists: () => true } })
  let changed = 0
  s.client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
    changed += 1
  })
  const before = (await s.names()).length
  await s.surface.upgrade({ ...s.surface.current(), mode: "component", session, close: async () => {} })
  await new Promise((r) => setTimeout(r, 20))
  const after = await s.names()
  assert.equal(after.length, helperToolsFor(s.surface.current(), "/tmp", {}).length + 5)
  assert.ok(after.length > before)
  assert.ok(changed >= 1, "the client was told the tool list changed")
  await s.close()
})
