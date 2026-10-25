// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Code, ConnectError, createRouterTransport } from "@connectrpc/connect"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import type { TaskHarness } from "@zeroroot-ai/sdk"
import { buildSurface } from "./build.js"
import { InboxConflictError, InputKind, JobState, openInbox } from "./inbox.js"
import { TURN_TOKEN_ENV } from "./http.js"

/** A harness that counts every SubscribeInput. The daemon allows one per member (ADR-0119). */
function countingHarness(over: { subscribeInput?: () => AsyncIterable<unknown> } = {}) {
  const counts = { subscribe: 0, send: 0, states: [] as JobState[] }
  const harness: TaskHarness = {
    transport: createRouterTransport(() => {}),
    client: {
      subscribeInput: () => {
        counts.subscribe += 1
        return over.subscribeInput ? over.subscribeInput() : (async function* () {})()
      },
      sendInput: async (req: { jobId: string; message: string; kind: InputKind }) => {
        counts.send += 1
        return { input: { id: "sent-1", jobId: req.jobId, message: req.message, kind: req.kind } }
      },
      reportJobState: async (req: { state: JobState }) => {
        counts.states.push(req.state)
        return {}
      },
    } as never,
    endpoint: "d:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "claude", missionRunId: "run-1" },
    token: () => "tok",
    expiresAt: () => 0,
    stop: () => {},
  }
  return { harness, counts }
}

async function openMember(harness: TaskHarness, extra: NodeJS.ProcessEnv) {
  const cwd = await mkdtemp(join(tmpdir(), "gm-driver-inbox-"))
  const surface = await buildSurface(
    {
      ZEROCOOL_STATE_DIR: cwd,
      GIBSON_CLI_CREDENTIALS: join(cwd, "none"),
      GIBSON_HOST_KEY_PATH: join(cwd, "host.key"),
      GIBSON_CG_JWT: "jwt",
      GIBSON_CALLBACK_ENDPOINT: "d:50001",
      ...extra,
    },
    cwd,
    { open: { harness: () => harness, hostKeyExists: () => true } },
  )
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = await surface.attach(serverSide)
  const client = new Client({ name: "test", version: "0" })
  await client.connect(clientSide)
  return {
    surface,
    client,
    close: async () => {
      await client.close()
      await server.close()
      await surface.close()
    },
  }
}

test("a server started by the member driver never opens a SubscribeInput stream", async () => {
  const { harness, counts } = countingHarness()
  const s = await openMember(harness, { [TURN_TOKEN_ENV]: "driver-token" })
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counts.subscribe, 0, "the daemon allows one reader for each member, and the driver is that reader")
  assert.ok(s.surface.answer, "the driver hands answers to the server instead")
  await s.close()
  assert.equal(counts.subscribe, 0)
})

test("an ask gets its answer from the driver over the answer route", async () => {
  const { harness, counts } = countingHarness()
  const s = await openMember(harness, { [TURN_TOKEN_ENV]: "driver-token" })
  s.surface.turn!.set({ jobId: "j-1", grant: "grant-1" })
  const asked = s.client.callTool({ name: "ask", arguments: { question: "which approach?" } })
  // The question is open once the job reports WAITING.
  for (let i = 0; i < 100 && !counts.states.includes(JobState.WAITING); i++) await new Promise((r) => setTimeout(r, 10))
  assert.equal(s.surface.answer!.deliver({ jobId: "j-other", message: "wrong job" }), false, "no question is open for another job")
  assert.equal(s.surface.answer!.deliver({ jobId: "j-1", message: "use the second approach" }), true)
  const res = await asked
  assert.equal((res.content as { text: string }[])[0]!.text, "use the second approach")
  assert.equal(counts.subscribe, 0)
  await s.close()
})

test("without a driver this process is the one reader and subscribes", async () => {
  const { harness, counts } = countingHarness()
  const s = await openMember(harness, {})
  await new Promise((r) => setTimeout(r, 50))
  assert.equal(counts.subscribe, 1)
  assert.equal(s.surface.answer, undefined)
  await s.close()
})

test("AlreadyExists is a second reader: it ends the stream with one clear line and is not retried", async () => {
  const { harness, counts } = countingHarness({
    subscribeInput: () =>
      (async function* () {
        yield* []
        throw new ConnectError("this member's inbox already has a subscriber", Code.AlreadyExists)
      })(),
  })
  const lines: string[] = []
  const slept: number[] = []
  const inbox = openInbox({ harness, log: (l) => lines.push(l), sleep: async (ms) => void slept.push(ms) })
  await assert.rejects(async () => {
    for await (const _ of inbox.messages()) break
  }, InboxConflictError)
  assert.equal(counts.subscribe, 1, "a second reader is a bug, so there is no retry")
  assert.deepEqual(slept, [])
  assert.equal(lines.length, 1)
  assert.match(lines[0]!, /second process reads this member's inbox/)
})
