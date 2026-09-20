// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { create, toJsonString } from "@bufbuild/protobuf"
import { createRouterTransport } from "@connectrpc/connect"
import { TaskSchema } from "./gen/gibson/types/v1/types_pb.js"
import { SANDBOX_ENV, readSandboxDispatch, sandboxHarness, taskFromB64 } from "./sandbox.js"

const taskB64 = (goal: string) =>
  Buffer.from(toJsonString(TaskSchema, create(TaskSchema, { id: "t-1", goal }))).toString("base64")

test("readSandboxDispatch reads exactly what the gibson launcher writes", () => {
  const d = readSandboxDispatch({
    GIBSON_CG_JWT: "grant",
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
    GIBSON_MISSION_ID: "m-1",
    GIBSON_MISSION_RUN_ID: "run-1",
    GIBSON_AGENT_RUN_ID: "ar-1",
    GIBSON_MODEL: "anthropic.claude-opus-4-7-v1",
    GIBSON_AGENT_TASK_B64: taskB64("  find exposed secrets  "),
    GIBSON_TRACE_ID: "tr",
  })
  assert.equal(d.grant, "grant")
  assert.equal(d.callbackEndpoint, "gibson:50001")
  assert.deepEqual([d.missionId, d.missionRunId, d.agentRunId, d.model, d.traceId], ["m-1", "run-1", "ar-1", "anthropic.claude-opus-4-7-v1", "tr"])
  assert.equal(d.goal, "find exposed secrets")
  assert.equal(d.task.id, "t-1")
})

test("the env names are the launcher's, not the work-queue worker's", () => {
  // gibson sandboxed/agent.go envAgent* constants. GIBSON_CALLBACK_TOKEN and
  // GIBSON_TASK_GOAL are NOT written by the launcher.
  assert.equal(SANDBOX_ENV.grant, "GIBSON_CG_JWT")
  assert.equal(SANDBOX_ENV.taskB64, "GIBSON_AGENT_TASK_B64")
})

test("a dispatch with no grant, no endpoint, no task, or an empty goal is refused", () => {
  const ok = { GIBSON_CG_JWT: "g", GIBSON_CALLBACK_ENDPOINT: "e", GIBSON_AGENT_TASK_B64: taskB64("go") }
  assert.throws(() => readSandboxDispatch({ ...ok, GIBSON_CG_JWT: "" }), /GIBSON_CG_JWT is not set/)
  assert.throws(() => readSandboxDispatch({ ...ok, GIBSON_CALLBACK_ENDPOINT: "" }), /GIBSON_CALLBACK_ENDPOINT is not set/)
  assert.throws(() => readSandboxDispatch({ ...ok, GIBSON_AGENT_TASK_B64: "" }), /GIBSON_AGENT_TASK_B64 is not set/)
  assert.throws(() => readSandboxDispatch({ ...ok, GIBSON_AGENT_TASK_B64: Buffer.from("not json").toString("base64") }), /not a base64 protojson/)
  assert.throws(() => readSandboxDispatch({ ...ok, GIBSON_AGENT_TASK_B64: taskB64("   ") }), /no goal/)
})

test("taskFromB64 tolerates fields this build does not know", () => {
  const raw = JSON.stringify({ id: "t", goal: "g", futureField: 1 })
  assert.equal(taskFromB64(Buffer.from(raw).toString("base64")).goal, "g")
})

/** An unsigned JWT with the given payload. The client never verifies. */
function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64(payload)}.sig`
}

test("sandboxHarness carries GIBSON_MISSION_RUN_ID into the context, and leaves it out when the launch set none", () => {
  const env = {
    GIBSON_CG_JWT: fakeJwt({ sub: "component:agent:zerocool", mission_id: "m-1", task_id: "t-1" }),
    GIBSON_CALLBACK_ENDPOINT: "gibson:50001",
    GIBSON_AGENT_TASK_B64: taskB64("go"),
  }
  const opts = { transport: createRouterTransport(() => {}), renew: false }

  const named = sandboxHarness(readSandboxDispatch({ ...env, GIBSON_MISSION_RUN_ID: "mr-1" }), opts)
  assert.deepEqual(named.context, { missionId: "m-1", taskId: "t-1", agentName: "zerocool", missionRunId: "mr-1" })
  named.stop()

  const unnamed = sandboxHarness(readSandboxDispatch(env), opts)
  assert.deepEqual(unnamed.context, { missionId: "m-1", taskId: "t-1", agentName: "zerocool" })
  unnamed.stop()
})
