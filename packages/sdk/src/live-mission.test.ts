// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"

import { liveMissionDefinition, NoTaskGrantError, startLiveMission } from "./live-mission.js"

const enc = new TextEncoder()
const dec = new TextDecoder()

/** The work payload of an agent: one A2A message in A2A JSON. */
function a2aPayload(goal = "Interactive session"): Uint8Array {
  return enc.encode(
    JSON.stringify({
      messageId: "m-1",
      role: "ROLE_USER",
      taskId: "run-1",
      contextId: "ctx-1",
      parts: [{ text: goal }],
    }),
  )
}

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA" })}.${b64(payload)}.sig`
}
const grantFor = (missionId: string) =>
  fakeJwt({ sub: "component:agent:zerocool-claude", tenant: "t", mission_id: missionId, task_id: "run-1", mrid: "run-1", exp: 4_000 })

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
      workType: "execute",
      context: { capability_grant: grantFor("m-live"), callback_endpoint: "daemon.example:443" },
      payload: a2aPayload("Interactive session"),
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
  assert.deepEqual(live.harness.context, { missionId: "m-live", taskId: "run-1", agentName: "zerocool-claude", missionRunId: "run-1" })
  const created = calls.createMission![0] as { targetId: string; missionDefinitionJson: Uint8Array }
  assert.equal(created.targetId, "tgt-1")
  assert.match(dec.decode(created.missionDefinitionJson), /"agentName":"zerocool-claude"/)
  assert.deepEqual(calls.runMission, [{ workId: "", missionId: "m-live" }])

  await live.end({ output: { turns: 3 } })
  const submitted = calls.submitResult![0] as { workId: string; result: Uint8Array }
  assert.equal(submitted.workId, "w-live")
  const task = JSON.parse(dec.decode(submitted.result)) as { id: string; contextId: string; status: { state: string } }
  assert.equal(task.id, "run-1")
  assert.equal(task.contextId, "ctx-1")
  assert.equal(task.status.state, "TASK_STATE_COMPLETED")
})

test("a given originator creates and runs the mission; the component does not", async () => {
  const { session, calls } = fakeSession([
    async () => ({
      workId: "w-h",
      workType: "execute",
      context: { capability_grant: grantFor("m-human"), callback_endpoint: "daemon.example:443" },
      payload: a2aPayload("Interactive session"),
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

test("a queue dispatch without a task grant is answered with an error and refused before any harness opens", async () => {
  const { session, calls } = fakeSession([
    async () => ({
      workId: "w-q",
      workType: "execute",
      context: { mission_id: "m-q", authz_context: "{}", agent: "zerocool-claude" },
      payload: a2aPayload("Interactive session"),
    }),
  ])
  await assert.rejects(
    startLiveMission(session, {
      agentName: "zerocool-claude",
      targetId: "tgt-1",
      originate: async () => "m-q",
      harness: { transport: createRouterTransport(() => {}), renew: false },
    }),
    (e: unknown) => e instanceof NoTaskGrantError && e.workId === "w-q",
  )
  assert.equal(calls.submitResult!.length, 1, "the dispatch is answered, so the node does not wait for its timeout")
})

test("work for another mission is answered with an error result, not swallowed", async () => {
  const { session, calls } = fakeSession([
    async () => ({
      workId: "w-other",
      workType: "execute",
      context: { capability_grant: grantFor("m-other") },
      payload: a2aPayload("someone else's"),
    }),
    async () => ({
      workId: "w-live",
      workType: "execute",
      context: { capability_grant: grantFor("m-live"), callback_endpoint: "d:443" },
      payload: a2aPayload(),
    }),
  ])
  const live = await startLiveMission(session, {
    agentName: "zerocool-claude",
    targetId: "tgt-1",
    harness: { transport: createRouterTransport(() => {}), renew: false },
  })
  assert.equal(live.workId, "w-live")
  const refused = calls.submitResult![0] as { workId: string; error: { code: string; message: string } }
  assert.equal(refused.workId, "w-other")
  assert.equal(refused.error.code, "EXECUTION_ERROR")
  assert.match(refused.error.message, /only serves its own live mission m-live/)
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
    /no agent dispatch for it reached instance inst-1/,
  )
})

test("a failed answer to a work item with no task grant does not hide the missing grant", async () => {
  const { session } = fakeSession([
    async () => ({
      workId: "w-f",
      workType: "execute",
      context: { mission_id: "m-f", authz_context: "{}", agent: "zerocool-claude" },
      payload: a2aPayload("Interactive session"),
    }),
  ])
  const transportFailure = new Error("transport down")
  ;(session as unknown as { clients: { component: { submitResult: () => Promise<never> } } }).clients.component.submitResult = async () => {
    throw transportFailure
  }
  await assert.rejects(
    startLiveMission(session, {
      agentName: "zerocool-claude",
      targetId: "tgt-1",
      originate: async () => "m-f",
      harness: { transport: createRouterTransport(() => {}), renew: false },
    }),
    (e: unknown) => e instanceof NoTaskGrantError && e.workId === "w-f" && e.cause === transportFailure,
  )
})
