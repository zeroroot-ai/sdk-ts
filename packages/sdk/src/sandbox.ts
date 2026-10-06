// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { fromJsonString, toJsonString } from "@bufbuild/protobuf"
import { FORKABLE_ENV, forkable, park, parkTimeout, Watcher, type Claim, type Claimer } from "./fork.js"
import { TaskSchema, type Task } from "./gen/gibson/types/v1/types_pb.js"
import { openTaskHarness, type ForkableHarness, type OpenTaskHarnessOptions } from "./task-harness.js"

/**
 * The sandboxed-dispatch contract (ADR-0116), as the launcher writes
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

/**
 * The task harness for a sandboxed run: the grant and the mission run from
 * the launch, nothing else.
 */
export function sandboxHarness(d: SandboxDispatch, opts: Omit<OpenTaskHarnessOptions, "endpoint" | "token" | "missionRunId"> = {}): ForkableHarness {
  return openTaskHarness({ ...opts, endpoint: d.callbackEndpoint, token: d.grant, ...(d.missionRunId ? { missionRunId: d.missionRunId } : {}) })
}

/**
 * The launch environment of a fork, from its claim (D74). A fork runs its
 * task through the same launch contract as a fresh sandbox, so a driver
 * reads it with {@link readSandboxDispatch} and runs it the same way. The
 * claim replaces the grant, the ids, the model and the task, and keeps the
 * callback endpoint. A fork was not launched as a fork source, so the
 * result has no {@link FORKABLE_ENV}.
 */
export function dispatchEnvFromClaim(env: NodeJS.ProcessEnv, claim: Claim): NodeJS.ProcessEnv {
  if (!claim.grant) throw new Error("gibson-sdk: the claim has no grant")
  if (!claim.task) throw new Error("gibson-sdk: the claim has no task")
  const { [FORKABLE_ENV]: _forkable, ...rest } = env
  return {
    ...rest,
    [SANDBOX_ENV.grant]: claim.grant,
    [SANDBOX_ENV.missionId]: claim.missionId,
    [SANDBOX_ENV.missionRunId]: claim.missionRunId,
    [SANDBOX_ENV.agentRunId]: claim.agentRunId,
    [SANDBOX_ENV.model]: claim.model,
    [SANDBOX_ENV.taskB64]: Buffer.from(toJsonString(TaskSchema, claim.task), "utf8").toString("base64"),
  }
}

/** Options of {@link parkAfterResult}. */
export interface ParkAfterResultOptions {
  /** Dial the callback listener without TLS. */
  insecure?: boolean
  /** Test seams. */
  claimer?: Claimer
  pollIntervalMs?: number
  signal?: AbortSignal
}

/**
 * The end of a forkable run (D74). Call it after the result line. A process
 * that is not a fork source gets `undefined` at once. A fork source parks
 * until a fork happens or {@link parkTimeout} ends. The parent gets
 * `undefined` and exits with status 0. A fork claims its dispatch once and
 * gets the launch environment of its own task, to run it the same way.
 *
 * Make the watcher at process start, before a fork can happen.
 */
export async function parkAfterResult(env: NodeJS.ProcessEnv, watcher: Watcher, opts: ParkAfterResultOptions = {}): Promise<NodeJS.ProcessEnv | undefined> {
  if (!forkable(env)) return undefined
  const timeoutMs = parkTimeout(env)
  const harness = opts.claimer ? undefined : sandboxHarness(readSandboxDispatch(env), { insecure: opts.insecure ?? false, renew: false })
  try {
    const claim = await park(watcher, opts.claimer ?? harness!, {
      timeoutMs,
      ...(opts.pollIntervalMs ? { pollIntervalMs: opts.pollIntervalMs } : {}),
      ...(opts.signal ? { signal: opts.signal } : {}),
    })
    return claim ? dispatchEnvFromClaim(env, claim) : undefined
  } finally {
    harness?.stop()
  }
}
