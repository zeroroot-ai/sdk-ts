// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createRouterTransport } from "@connectrpc/connect"
import { HostRegistrationError, type GibsonSession, type LiveMission, type TaskHarness } from "@zeroroot-ai/sdk"
import { connectTool, type ConnectTarget } from "./connect.js"
import type { Gibson } from "../session.js"

/** A CLI spawn that prints one line and exits 0, so enrollIdentity reads a token. */
function fakeSpawn(stdout: string, calls: { n: number }) {
  return () => {
    calls.n += 1
    const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: () => void }
    child.stdout = new EventEmitter()
    child.stderr = new EventEmitter()
    child.kill = () => {}
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(stdout))
      child.emit("exit", 0)
    })
    return child as never
  }
}

function fakeSession(): GibsonSession {
  return {
    transport: createRouterTransport(() => {}),
    clients: { component: {}, harness: {} } as never,
    componentScope: "scope-1",
    instance: { current: () => "inst-1", heartbeatIntervalMs: () => 1000, renew: async () => "inst-1" },
    instanceId: "inst-1",
    stop: () => {},
  }
}

function fakeLive(): LiveMission {
  const harness = {
    transport: createRouterTransport(() => {}),
    client: {} as never,
    endpoint: "d:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "gibson-mcp", missionRunId: "run-1" },
    token: () => "tok",
    expiresAt: () => 0,
    stop: () => {},
  } as unknown as TaskHarness
  return { missionId: "m-1", workId: "w-1", harness, end: async () => {} }
}

function initial(hostKeyPath: string): Gibson {
  return {
    source: "none",
    mode: "standalone",
    reason: "",
    agentName: "gibson-mcp",
    hostKeyPath,
    settings: { callbackInsecure: false, hostKeyPath, agentName: "gibson-mcp" },
    close: async () => {},
  }
}

test("gibson_connect self-heals a stale host key: it re-enrolls and retries once", async () => {
  const dir = await mkdtemp(join(tmpdir(), "connect-selfheal-"))
  try {
    const hostKeyPath = join(dir, "host.key") // absent, so the rotate is a no-op
    const env: NodeJS.ProcessEnv = {
      ZEROCOOL_STATE_DIR: dir,
      GIBSON_PLATFORM_URL: "https://p",
      GIBSON_TARGET_ID: "tgt-1",
      GIBSON_HOST_KEY_PATH: hostKeyPath,
      GIBSON_CLI_CREDENTIALS: join(dir, "no-creds"),
    }

    let upgraded: Gibson | undefined
    const target: ConnectTarget = { current: () => initial(hostKeyPath), upgrade: async (n) => void (upgraded = n) }

    const enrolls = { n: 0 }
    let connects = 0

    const tool = connectTool(target, env, dir, {
      // target resolution is skipped (GIBSON_TARGET_ID is set), so the only CLI
      // call is the re-enroll. Counting spawns counts enrollments.
      cli: { spawn: fakeSpawn("bootstrap_token: tok-new\n", enrolls) as never },
      open: {
        hostKeyExists: () => true,
        trust: async () => {},
        connect: (async () => {
          connects += 1
          if (connects === 1) throw new HostRegistrationError(401, "Unauthorized", true)
          return fakeSession()
        }) as never,
        start: (async () => fakeLive()) as never,
      },
    })

    const res = await tool.handler({}, {} as never)

    assert.equal(enrolls.n, 1, "a fresh bootstrap token is minted once")
    assert.equal(connects, 2, "connect is attempted again after the re-enroll")
    assert.equal(res.isError ?? false, false, "the retry connected")
    assert.equal(upgraded?.mode, "live")
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
