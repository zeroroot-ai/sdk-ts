// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"

import { liveMissionDefinition, startLiveMission } from "./live-mission.js"

const enc = new TextEncoder()
const dec = new TextDecoder()

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA" })}.${b64(payload)}.sig`
}
const grantFor = (missionId: string) =>
  fakeJwt({ sub: "component:agent:zerocool-claude", tenant: "t", mission_id: missionId, task_id: "run-1", exp: 4_000 })

test("the live mission is one AGENT node that names this component, with a long timeout", () => {
  const def = liveMissionDefinition({ agentName: "zerocool-claude", targetId: "tgt-1" }) as {
    name: string
    description: string
    nodes: Record<string, { type: string; name: string; timeout: string; agentConfig: { agentName: string; task: { goal: string } } }>
  }
  assert.match(def.name, /^zerocool-claude session \d{4}-\d{2}-\d{2}T/)
  assert.match(def.description, /Live session/)
  const node = def.nodes.session!
  assert.equal(node.type, "NODE_TYPE_AGENT")
  assert.equal(node.name, "zerocool-claude")
  assert.equal(node.agentConfig.agentName, "zerocool-claude")
  assert.equal(node.timeout, "28800s")
  assert.match(node.agentConfig.task.goal, /Interactive session/)
})

function fakeSession(polls: (() => Promise<unknown>)[]) {
  const calls: Record<string, unknown[]> = { createMission: [], runMission: [], submitResult: [] }
  let i = 0
  const component = {
    createMission: async (req: unknown) => {
      calls.createMission!.push(req)
      return { missionJson: enc.encode(JSON.stringify({ id: "m-live", name: "s", status: "created" })) }
    },
    runMission: async (req: unknown) => {
      calls.runMission!.push(req)
      return {}
    },
    pollWork: async () => {
      const p = polls[i++]
      if (!p) return new Promise<never>(() => {}) // park like a real long-poll
      return p()
    },
    submitResult: async (req: { workId: string; result: Uint8Array }) => {
      calls.submitResult!.push(req)
      return {}
    },
  }
  const harness = { observe: async () => ({}) }
  const session = {
    clients: { component, harness },
    instance: { current: () => "inst-1" },
  }
  return { session: session as never, calls }
}

test("startLiveMission creates, runs, claims its own dispatch and ends it", async () => {
  const { session, calls } = fakeSession([
    async () => ({ workId: "", workType: "", context: {} }), // poll timeout, no work
    async () => ({
      workId: "w-live",
      workType: "agent_execute",
      context: { capability_grant: grantFor("m-live"), callback_endpoint: "daemon.example:443" },
      payload: enc.encode(JSON.stringify({ task: { goal: "Interactive session" } })),
    }),
  ])
  const transport = createRouterTransport(() => {})
  const live = await startLiveMission(session, {
    agentName: "zerocool-claude",
    targetId: "tgt-1",
    harness: { transport, renew: false },
  })

  assert.equal(live.missionId, "m-live")
  assert.equal(live.workId, "w-live")
  assert.deepEqual(live.harness.context, { missionId: "m-live", taskId: "run-1", agentName: "zerocool-claude" })
  const created = calls.createMission![0] as { targetId: string; missionDefinitionJson: Uint8Array }
  assert.equal(created.targetId, "tgt-1")
  assert.match(dec.decode(created.missionDefinitionJson), /"agentName":"zerocool-claude"/)
  assert.deepEqual(calls.runMission, [{ workId: "", missionId: "m-live" }])

  await live.end({ output: { turns: 3 } })
  const submitted = calls.submitResult![0] as { workId: string; result: Uint8Array }
  assert.equal(submitted.workId, "w-live")
  const envelope = JSON.parse(dec.decode(submitted.result)) as { result: { status: string } }
  assert.equal(envelope.result.status, "RESULT_STATUS_SUCCESS")
})

test("a given originator creates and runs the mission; the component does not", async () => {
  const { session, calls } = fakeSession([
    async () => ({
      workId: "w-h",
      workType: "agent_execute",
      context: { capability_grant: grantFor("m-human"), callback_endpoint: "daemon.example:443" },
      payload: enc.encode(JSON.stringify({ task: { goal: "Interactive session" } })),
    }),
  ])
  const seen: { definition: unknown; targetId: string }[] = []
  const live = await startLiveMission(session, {
    agentName: "zerocool-claude",
    targetId: "tgt-1",
    name: "claude session 1",
    originate: async (definition, targetId) => {
      seen.push({ definition, targetId })
      return "m-human"
    },
    harness: { transport: createRouterTransport(() => {}), renew: false },
  })
  assert.equal(live.missionId, "m-human")
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.targetId, "tgt-1")
  assert.equal((seen[0]!.definition as { name: string }).name, "claude session 1")
  assert.deepEqual(calls.createMission, [])
  assert.deepEqual(calls.runMission, [])
})

test("a queue dispatch without a task grant is claimed by context.mission_id and runs on the session harness", async () => {
  const { session } = fakeSession([
    async () => ({
      workId: "w-q",
      workType: "agent_execute",
      context: { mission_id: "m-q", authz_context: "{}", agent: "zerocool-claude" },
      payload: enc.encode(JSON.stringify({ task: { goal: "Interactive session" } })),
    }),
  ])
  const live = await startLiveMission(session, {
    agentName: "zerocool-claude",
    targetId: "tgt-1",
    originate: async () => "m-q",
    harness: { transport: createRouterTransport(() => {}), renew: false },
  })
  assert.equal(live.missionId, "m-q")
  assert.equal(live.workId, "w-q")
  assert.deepEqual(live.harness.context, { missionId: "m-q", taskId: "w-q", agentName: "zerocool-claude" })
  assert.equal(live.harness.client, (session as unknown as { clients: { harness: unknown } }).clients.harness)
  assert.equal(live.harness.token(), "")
})

test("work for another mission is answered with an error result, not swallowed", async () => {
  const { session, calls } = fakeSession([
    async () => ({
      workId: "w-other",
      workType: "agent_execute",
      context: { capability_grant: grantFor("m-other") },
      payload: enc.encode(JSON.stringify({ task: { goal: "someone else's" } })),
    }),
    async () => ({
      workId: "w-live",
      workType: "agent_execute",
      context: { capability_grant: grantFor("m-live"), callback_endpoint: "d:443" },
      payload: enc.encode("{}"),
    }),
  ])
  const live = await startLiveMission(session, {
    agentName: "zerocool-claude",
    targetId: "tgt-1",
    harness: { transport: createRouterTransport(() => {}), renew: false },
  })
  assert.equal(live.workId, "w-live")
  const refused = calls.submitResult![0] as { workId: string; result: Uint8Array }
  assert.equal(refused.workId, "w-other")
  assert.match(dec.decode(refused.result), /only serves its own live mission m-live/)
  live.harness.stop()
})

test("startLiveMission gives up when its dispatch never arrives", async () => {
  let now = 0
  const { session } = fakeSession([async () => ({ workId: "", workType: "", context: {} })])
  await assert.rejects(
    startLiveMission(session, {
      agentName: "zerocool-claude",
      targetId: "tgt-1",
      claimTimeoutMs: 1_000,
      clock: () => (now += 600),
    }),
    /no agent_execute dispatch for it reached instance inst-1/,
  )
})
