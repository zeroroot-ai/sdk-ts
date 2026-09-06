// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { fromJsonString } from "@bufbuild/protobuf"
import { TaskSchema, type Task } from "./gen/gibson/types/v1/types_pb.js"
import { openTaskHarness, type OpenTaskHarnessOptions, type TaskHarness } from "./task-harness.js"

/**
 * The sandboxed-dispatch contract (gibson ADR-0016), as the launcher writes
 * it into the sandbox environment (gibson
 * `internal/engine/harness/sandboxed/agent.go`, the `envAgent*` constants):
 *
 *   GIBSON_CG_JWT             the per-dispatch capability grant
 *   GIBSON_CALLBACK_ENDPOINT  HarnessCallbackService address
 *   GIBSON_MISSION_ID, GIBSON_MISSION_RUN_ID, GIBSON_AGENT_RUN_ID
 *   GIBSON_MODEL              the model resolved for the tenant at dispatch
 *   GIBSON_AGENT_TASK_B64     base64 of the protojson gibson.types.v1.Task
 *   GIBSON_TRACE_ID, GIBSON_SPAN_ID
 *
 * This is the one place that spells those names on the TypeScript side. An
 * entrypoint that reads anything else reads a contract the launcher does not
 * write, and fails at the first dispatch.
 */
export interface SandboxDispatch {
  grant: string
  callbackEndpoint: string
  missionId: string
  missionRunId: string
  agentRunId: string
  /** The model the tenant resolved at dispatch. Empty when the manifest left it to the agent. */
  model: string
  task: Task
  /** The task's goal, trimmed. Never empty: a dispatch without a goal is refused. */
  goal: string
  traceId: string
  spanId: string
}

export const SANDBOX_ENV = {
  grant: "GIBSON_CG_JWT",
  callbackEndpoint: "GIBSON_CALLBACK_ENDPOINT",
  missionId: "GIBSON_MISSION_ID",
  missionRunId: "GIBSON_MISSION_RUN_ID",
  agentRunId: "GIBSON_AGENT_RUN_ID",
  model: "GIBSON_MODEL",
  taskB64: "GIBSON_AGENT_TASK_B64",
  traceId: "GIBSON_TRACE_ID",
  spanId: "GIBSON_SPAN_ID",
} as const

/** Decode the launcher's base64 protojson task. */
export function taskFromB64(b64: string): Task {
  const raw = Buffer.from(b64, "base64").toString("utf8")
  return fromJsonString(TaskSchema, raw, { ignoreUnknownFields: true })
}

/**
 * Read the dispatch off the environment. Fails, never falls back: a sandbox
 * with no grant or no task has nothing to do, and answering anything else
 * would report a made-up result as the mission's.
 */
export function readSandboxDispatch(env: NodeJS.ProcessEnv): SandboxDispatch {
  const grant = env[SANDBOX_ENV.grant] ?? ""
  const callbackEndpoint = env[SANDBOX_ENV.callbackEndpoint] ?? ""
  const taskB64 = env[SANDBOX_ENV.taskB64] ?? ""
  if (!grant) throw new Error(`${SANDBOX_ENV.grant} is not set: the sandbox launch injects the per-dispatch grant; there is no other identity to fall back to`)
  if (!callbackEndpoint) throw new Error(`${SANDBOX_ENV.callbackEndpoint} is not set: the sandbox launch names the callback endpoint`)
  if (!taskB64) throw new Error(`${SANDBOX_ENV.taskB64} is not set: the sandbox launch injects the task to pursue`)
  let task: Task
  try {
    task = taskFromB64(taskB64)
  } catch (e) {
    throw new Error(`${SANDBOX_ENV.taskB64} is not a base64 protojson gibson.types.v1.Task: ${(e as Error).message}`)
  }
  const goal = task.goal.trim()
  if (!goal) throw new Error("the dispatched task carries no goal")
  return {
    grant,
    callbackEndpoint,
    missionId: env[SANDBOX_ENV.missionId] ?? "",
    missionRunId: env[SANDBOX_ENV.missionRunId] ?? "",
    agentRunId: env[SANDBOX_ENV.agentRunId] ?? "",
    model: env[SANDBOX_ENV.model] ?? "",
    task,
    goal,
    traceId: env[SANDBOX_ENV.traceId] ?? "",
    spanId: env[SANDBOX_ENV.spanId] ?? "",
  }
}

/** The task harness for a sandboxed run: the grant from the launch, nothing else. */
export function sandboxHarness(d: SandboxDispatch, opts: Omit<OpenTaskHarnessOptions, "endpoint" | "token"> = {}): TaskHarness {
  return openTaskHarness({ ...opts, endpoint: d.callbackEndpoint, token: d.grant })
}
