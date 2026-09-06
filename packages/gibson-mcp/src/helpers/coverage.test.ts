// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import * as sdk from "@zeroroot-ai/sdk"
import { createRouterTransport } from "@connectrpc/connect"
import type { GibsonSession, LiveMission, TaskHarness } from "@zeroroot-ai/sdk"
import type { Gibson } from "../session.js"
import { HELPER_TOOL_FOR_EXPORT, NOT_A_TOOL, TOOL_WITHOUT_EXPORT } from "./coverage.js"
import { helperToolsFor } from "./index.js"

/**
 * The guard that keeps the helper half of the 1:1 surface honest. The RPC
 * half is generated and cannot fall behind; a helper is hand-signed, so a
 * new SDK export has to be decided about here before it can land.
 */
function sdkFunctionExports(): string[] {
  return Object.entries(sdk)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
    .sort()
}

function fakeHarness(): TaskHarness {
  return {
    transport: createRouterTransport(() => {}),
    client: {} as never,
    endpoint: "d:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "gibson-mcp" },
    token: () => "tok",
    expiresAt: () => 0,
    stop: () => {},
  }
}

function fakeSession(): GibsonSession {
  return {
    transport: createRouterTransport(() => {}),
    clients: { component: {}, harness: {} } as never,
    componentScope: "scope-1",
    instance: { current: () => "i", heartbeatIntervalMs: () => 1000, renew: async () => "i" },
    instanceId: "i",
    stop: () => {},
  }
}

function gibson(parts: Partial<Gibson>): Gibson {
  return {
    source: "enrolled",
    mode: "live",
    reason: "",
    agentName: "gibson-mcp",
    hostKeyPath: "/tmp/host.key",
    settings: { callbackInsecure: false, hostKeyPath: "/tmp/host.key", agentName: "gibson-mcp" },
    close: async () => {},
    ...parts,
  }
}

const live = (): LiveMission => ({ missionId: "m-1", workId: "w-1", harness: fakeHarness(), end: async () => {} })

/** The widest posture: checked in, with a live mission. */
function everyHelperTool(): string[] {
  const session = fakeSession()
  const g = gibson({ session, live: live(), knowledge: sdk.taskKnowledge(fakeHarness()) })
  return helperToolsFor(g, "/tmp", {}).map((t) => t.name).sort()
}

test("every SDK function export is either a tool or on the list, with a reason", () => {
  const missing: string[] = []
  for (const name of sdkFunctionExports()) {
    if (HELPER_TOOL_FOR_EXPORT[name] || NOT_A_TOOL[name]) continue
    missing.push(name)
  }
  assert.deepEqual(
    missing,
    [],
    "these SDK exports are neither a tool nor on the notATool list; add them to src/helpers/coverage.ts with a tool or a reason",
  )
})

test("no export is in both maps, and every reason says something", () => {
  for (const name of Object.keys(HELPER_TOOL_FOR_EXPORT)) {
    assert.equal(NOT_A_TOOL[name], undefined, `${name} is both a tool and not a tool`)
  }
  for (const [name, reason] of Object.entries(NOT_A_TOOL)) {
    assert.ok(reason.trim().length > 10, `${name} needs a real reason, not "${reason}"`)
  }
})

test("both maps name real SDK exports, so a rename cannot leave a stale entry", () => {
  const exports = new Set(sdkFunctionExports())
  for (const name of [...Object.keys(HELPER_TOOL_FOR_EXPORT), ...Object.keys(NOT_A_TOOL)]) {
    assert.ok(exports.has(name), `${name} is in the coverage table but the SDK no longer exports it`)
  }
})

test("every tool the table promises is actually registered in the widest posture", () => {
  const registered = new Set(everyHelperTool())
  const promised = new Set(Object.values(HELPER_TOOL_FOR_EXPORT))
  process.stderr.write(`[helpers] ${registered.size} helper tools from ${promised.size} named by the coverage table\n`)
  for (const name of promised) {
    assert.ok(registered.has(name), `the table names ${name} but no posture registers it`)
  }
})

test("every registered helper tool traces back to an export or is accounted for", () => {
  const promised = new Set(Object.values(HELPER_TOOL_FOR_EXPORT))
  for (const name of everyHelperTool()) {
    if (promised.has(name)) continue
    assert.ok(TOOL_WITHOUT_EXPORT[name], `${name} is registered but nothing accounts for it; add it to TOOL_WITHOUT_EXPORT with where it comes from`)
  }
})

test("a posture registers only the helpers its grant can reach", () => {
  const standalone = helperToolsFor(gibson({ mode: "standalone" }), "/tmp", {}).map((t) => t.name).sort()
  // With no platform a finding still has somewhere to go, and componentize
  // needs nothing but a disk.
  assert.deepEqual(standalone, ["componentize", "submit_finding", "validate_component"])

  const dispatched = helperToolsFor(
    gibson({ source: "dispatched", mode: "task", live: live(), knowledge: sdk.taskKnowledge(fakeHarness()) }),
    "/tmp",
    {},
  ).map((t) => t.name)
  assert.ok(dispatched.includes("remember"), "a dispatched run holds a mission, so it can write memories")
  assert.ok(dispatched.includes("world_view"))
  assert.ok(!dispatched.includes("delegate"), "delegation is a ComponentService call and a dispatched run has no component client")
  assert.ok(!dispatched.includes("enroll_component"))
})
