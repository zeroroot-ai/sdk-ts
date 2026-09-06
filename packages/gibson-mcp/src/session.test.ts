// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"
import type { GibsonSession, LiveMission, TaskHarness } from "@zeroroot-ai/sdk"
import type { Settings } from "./config.js"
import { openGibson } from "./session.js"

const settings = (o: Partial<Settings> = {}): Settings => ({
  callbackInsecure: false,
  hostKeyPath: "/home/u/.zerocool/host.key",
  agentName: "gibson-mcp",
  ...o,
})

const quiet = () => {}

function fakeSession(): GibsonSession & { stopped: number } {
  const s = {
    stopped: 0,
    transport: createRouterTransport(() => {}),
    clients: { component: {}, harness: {} } as never,
    componentScope: "scope-1",
    instance: { current: () => "inst-1", heartbeatIntervalMs: () => 1000, renew: async () => "inst-1" },
    instanceId: "inst-1",
    stop: () => {
      s.stopped += 1
    },
  }
  return s
}

function fakeHarness(agentName = "gibson-mcp"): TaskHarness & { stopped: number } {
  const h = {
    stopped: 0,
    transport: createRouterTransport(() => {}),
    client: {} as never,
    endpoint: "d:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName },
    token: () => "tok",
    expiresAt: () => 0,
    stop: () => {
      h.stopped += 1
    },
  }
  return h
}

function fakeLive(): LiveMission & { ended: unknown[] } {
  const l = {
    ended: [] as unknown[],
    missionId: "m-1",
    workId: "w-1",
    harness: fakeHarness(),
    end: async (o?: unknown) => {
      l.ended.push(o)
    },
  }
  return l
}

test("the dispatched grant wins over an enrolled host key, and nothing is dialed for a check-in", async () => {
  let dialed = false
  const harness = fakeHarness("claude")
  const g = await openGibson({
    settings: settings({ platformURL: "https://p", targetId: "tgt" }),
    log: quiet,
    env: { GIBSON_CG_JWT: "jwt", GIBSON_CALLBACK_ENDPOINT: "d:50001", GIBSON_MISSION_RUN_ID: "run-9" },
    connect: async () => {
      dialed = true
      throw new Error("must not check in")
    },
    harness: () => harness,
    hostKeyExists: () => true,
  })
  assert.equal(g.source, "dispatched")
  assert.equal(g.mode, "task")
  assert.equal(dialed, false)
  assert.equal(g.live?.missionId, "m-1")
  assert.equal(g.runId, "run-9")
  assert.equal(g.agentName, "claude", "the agent name comes off the grant, not the settings")
  await g.close()
  assert.equal(harness.stopped, 1)
})

test("a dispatched grant the harness refuses still starts, standalone, with the reason", async () => {
  const g = await openGibson({
    settings: settings(),
    log: quiet,
    env: { GIBSON_CG_JWT: "not-a-jwt", GIBSON_CALLBACK_ENDPOINT: "d:50001" },
    harness: () => {
      throw new Error("task grant is not a JWT")
    },
    hostKeyExists: () => false,
  })
  assert.equal(g.source, "dispatched")
  assert.equal(g.mode, "standalone")
  assert.match(g.reason, /not a JWT/)
})

test("standalone when the platform is not configured; nothing is dialed", async () => {
  let dialed = false
  const g = await openGibson({
    settings: settings(),
    log: quiet,
    connect: async () => {
      dialed = true
      throw new Error("must not dial")
    },
    hostKeyExists: () => false,
  })
  assert.equal(g.source, "none")
  assert.equal(g.mode, "standalone")
  assert.equal(dialed, false)
})

test("a connect failure falls back to standalone and says why", async () => {
  const lines: string[] = []
  const g = await openGibson({
    settings: settings({ platformURL: "https://p", targetId: "t" }),
    log: (l) => lines.push(l),
    connect: async () => {
      throw new Error("edge unreachable")
    },
    hostKeyExists: () => true,
  })
  assert.equal(g.source, "enrolled")
  assert.equal(g.mode, "standalone")
  assert.match(g.reason, /edge unreachable/)
  assert.ok(lines.some((l) => /continuing standalone/.test(l)))
})

test("the bootstrap token is passed only when no host key exists", async () => {
  const seen: (string | undefined)[] = []
  const connect = async (cfg: { bootstrapToken?: string }) => {
    seen.push(cfg.bootstrapToken)
    return fakeSession()
  }
  const first = await openGibson({
    settings: settings({ platformURL: "https://p", bootstrapToken: "once" }),
    log: quiet,
    connect: connect as never,
    hostKeyExists: () => false,
  })
  assert.equal(first.source, "bootstrap")
  const later = await openGibson({
    settings: settings({ platformURL: "https://p", bootstrapToken: "once" }),
    log: quiet,
    connect: connect as never,
    hostKeyExists: () => true,
  })
  assert.equal(later.source, "enrolled")
  assert.deepEqual(seen, ["once", undefined])
})

test("checked in with a target: the session is a live mission, and close ends it before it stops the component", async () => {
  const session = fakeSession()
  const live = fakeLive()
  const g = await openGibson({
    settings: settings({ platformURL: "https://p", targetId: "tgt" }),
    log: quiet,
    connect: async () => session,
    start: async (_s, opts) => {
      assert.equal(opts.agentName, "gibson-mcp")
      assert.equal(opts.targetId, "tgt")
      return live
    },
    hostKeyExists: () => true,
  })
  assert.equal(g.mode, "live")
  assert.equal(g.live?.missionId, "m-1")
  await g.close()
  await g.close()
  assert.equal(live.ended.length, 1, "end once, even when closed twice")
  assert.equal(session.stopped, 1)
})

test("a live-mission failure lands in the component posture with the reason, not in standalone", async () => {
  const g = await openGibson({
    settings: settings({ platformURL: "https://p", targetId: "tgt" }),
    log: quiet,
    connect: async () => fakeSession(),
    start: async () => {
      throw new Error("no dispatch arrived")
    },
    hostKeyExists: () => true,
  })
  assert.equal(g.mode, "component")
  assert.match(g.reason, /no dispatch arrived/)
  assert.ok(g.knowledge, "reads still work under the component grant")
})
