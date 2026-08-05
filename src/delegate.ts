import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"
import { isSeamUnavailable, seamReason } from "./tools.js"

/**
 * Agent delegation and missions (zerocool-plugins#10).
 *
 * WIRE FORMAT — `Task` and `Result` cross the wire as JSON inside the
 * `task_json` / `result_json` byte fields. The Go structs `agent.Task` and
 * `agent.Result` (`opensource/sdk/agent/types.go`) carry **no JSON tags**, so Go
 * marshals them with the Go field names verbatim — `ID`, `Goal`, `Context`,
 * `Constraints`, `Status`, `Output`, `Findings`, `Metadata`. The interfaces below
 * use those exact keys. Renaming them to idiomatic camelCase would produce JSON
 * the Go side silently decodes as a zero-value task.
 *
 * The one exception is `agent.Result.ErrorInfo`, which does carry a tag and
 * marshals as `error`.
 *
 * DAEMON STATE: the `agentDelegator` and `missionMgr` seams are declared but
 * never wired, so every RPC in this module answers `Unimplemented` on a live
 * cluster today — gibson#1186.
 */

/** Operational limits on a delegated task. Mirrors Go `agent.TaskConstraints`. */
export interface TaskConstraints {
  /** Max LLM turns; 0 means no limit. */
  MaxTurns?: number
  /** Max total tokens across the task; 0 means no limit. */
  MaxTokens?: number
  /** Allowlist of tools; empty means all available tools. */
  AllowedTools?: string[]
  /** Denylist of tools; takes precedence over AllowedTools. */
  BlockedTools?: string[]
}

/** A unit of work handed to another agent. Mirrors Go `agent.Task`. */
export interface Task {
  ID: string
  Goal: string
  /** Target details, prior findings, mission context. Also carries `goal`. */
  Context?: Record<string, unknown>
  Constraints?: TaskConstraints
  Metadata?: Record<string, unknown>
}

/** Terminal state of a delegated task. Mirrors Go `agent.ResultStatus`. */
export type ResultStatus = "success" | "failed" | "partial" | "cancelled" | "timeout"

/** The outcome of a delegated task. Mirrors Go `agent.Result`. */
export interface Result {
  Status: ResultStatus
  Output?: unknown
  /** IDs of findings the delegate submitted during the task. */
  Findings?: string[]
  Metadata?: Record<string, unknown>
  /** Structured failure detail — Go `ErrorInfo`, tagged `error`. */
  error?: { message?: string; code?: string; [key: string]: unknown }
}

/** Build a Task with the Go SDK's defaults (`agent.NewTask`). */
export function newTask(goal: string, opts: Partial<Omit<Task, "Goal">> = {}): Task {
  return {
    ID: opts.ID ?? crypto.randomUUID(),
    Goal: goal,
    // The Go SDK keeps the goal in Context["goal"] as well; a delegate may read
    // either, so populate both.
    Context: { goal, ...(opts.Context ?? {}) },
    ...(opts.Constraints ? { Constraints: opts.Constraints } : {}),
    ...(opts.Metadata ? { Metadata: opts.Metadata } : {}),
  }
}

/** An agent available for delegation. Mirrors `AgentDescriptorProto`. */
export interface GibsonAgent {
  name: string
  version: string
  description: string
  capabilities: string[]
  targetTypes: string[]
}

export interface AgentDiscovery {
  agents: GibsonAgent[]
  /** Set when discovery could not run; the agent list is empty but nothing failed. */
  unavailable?: string
}

/**
 * List the agents this tenant can delegate to. Like {@link listGibsonTools},
 * an unwired daemon seam degrades to an empty list with a reason.
 */
export async function listAgents(
  component: Client<typeof ComponentService>,
  workId = "",
): Promise<AgentDiscovery> {
  try {
    const res = await component.listAgents({ workId })
    return {
      agents: res.agents.map((a) => ({
        name: a.name,
        version: a.version,
        description: a.description,
        capabilities: a.capabilities,
        targetTypes: a.targetTypes,
      })),
    }
  } catch (e) {
    if (isSeamUnavailable(e)) {
      return {
        agents: [],
        unavailable: seamReason(e) ?? "the daemon has no agent delegator wired (gibson#1186)",
      }
    }
    throw e
  }
}

/**
 * Delegate a sub-task to another Gibson agent and wait for its Result.
 *
 * Rules-of-engagement, authz and budget denials surface as a thrown ConnectRPC
 * error carrying the daemon's status message — the caller should show it rather
 * than retry, because a denial is a policy decision, not a transient fault.
 */
export async function delegateToAgent(
  component: Client<typeof ComponentService>,
  agentName: string,
  task: Task,
  workId = "",
): Promise<Result> {
  const res = await component.delegateToAgent({
    workId,
    agentName,
    taskJson: encodeJSON(task),
  })
  const result = decodeJSON<Result>(res.resultJson)
  if (!result) throw new Error(`delegateToAgent: agent ${agentName} returned an empty result`)
  return result
}

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

/** Mission info as returned by CreateMission. JSON-encoded `mission.MissionInfo`. */
export interface MissionInfo {
  [key: string]: unknown
}

/** Create a mission from a definition, bound to a target. */
export async function createMission(
  component: Client<typeof ComponentService>,
  missionDefinition: unknown,
  targetId: string,
  opts?: Record<string, unknown>,
  workId = "",
): Promise<MissionInfo> {
  const res = await component.createMission({
    workId,
    missionDefinitionJson: encodeJSON(missionDefinition),
    targetId,
    ...(opts ? { optsJson: encodeJSON(opts) } : {}),
  })
  return decodeJSON<MissionInfo>(res.missionJson) ?? {}
}

/** Queue a mission for execution. Returns as soon as the mission is queued. */
export async function runMission(
  component: Client<typeof ComponentService>,
  missionId: string,
  opts?: Record<string, unknown>,
  workId = "",
): Promise<void> {
  await component.runMission({
    workId,
    missionId,
    ...(opts ? { optsJson: encodeJSON(opts) } : {}),
  })
}

/** Current status of a mission. JSON-encoded `mission.MissionStatusInfo`. */
export async function getMissionStatus(
  component: Client<typeof ComponentService>,
  missionId: string,
  workId = "",
): Promise<Record<string, unknown>> {
  const res = await component.getMissionStatus({ workId, missionId })
  return decodeJSON<Record<string, unknown>>(res.statusJson) ?? {}
}

/**
 * Block until a mission reaches a terminal state or the timeout expires.
 *
 * The daemon holds the RPC open for the duration, so pick a timeout the transport
 * can survive rather than an arbitrarily large one.
 */
export async function waitMission(
  component: Client<typeof ComponentService>,
  missionId: string,
  timeoutMs = 300_000,
  workId = "",
): Promise<Record<string, unknown>> {
  const res = await component.waitMission({ workId, missionId, timeoutMs: BigInt(timeoutMs) })
  return decodeJSON<Record<string, unknown>>(res.resultJson) ?? {}
}

/** Final results of a completed mission. */
export async function getMissionResults(
  component: Client<typeof ComponentService>,
  missionId: string,
  workId = "",
): Promise<Record<string, unknown>> {
  const res = await component.getMissionResults({ workId, missionId })
  return decodeJSON<Record<string, unknown>>(res.resultJson) ?? {}
}

/** Request cancellation of a running mission. */
export async function cancelMission(
  component: Client<typeof ComponentService>,
  missionId: string,
  workId = "",
): Promise<void> {
  await component.cancelMission({ workId, missionId })
}

/** List missions matching a JSON filter. */
export async function listMissions(
  component: Client<typeof ComponentService>,
  filter: Record<string, unknown> = {},
  workId = "",
): Promise<unknown[]> {
  const res = await component.listMissions({ workId, filterJson: encodeJSON(filter) })
  return decodeJSON<unknown[]>(res.missionsJson) ?? []
}

function encodeJSON(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decodeJSON<T>(bytes: Uint8Array | undefined): T | undefined {
  if (!bytes || bytes.length === 0) return undefined
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
