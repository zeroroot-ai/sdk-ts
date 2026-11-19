// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { fromJson, type JsonValue } from "@bufbuild/protobuf"
import {
  Message,
  Role,
  Task,
  TaskState,
  type Artifact,
  type Message as A2AMessage,
  type Part,
  type Task as A2ATask,
} from "@a2a-js/sdk"
import { JobSpecSchema, type JobSpec } from "./gen/gibson/job/v1/job_pb.js"
import { functionCallOutput, type FunctionCallItem, type FunctionCallOutputItem } from "./openresponses.js"

/**
 * A2A as the agent wire, over the work queue.
 *
 * The work payload of an agent is one A2A v1.0 `Message` in A2A JSON. The
 * result is one A2A v1.0 `Task` in A2A JSON. This file is the one place where
 * the types of an agent author, {@link AgentTask} and {@link AgentResult}, meet
 * the A2A types. The state of a task is the A2A `TaskState`. There is no second
 * list of states.
 *
 * The types of A2A come from the official A2A JS SDK, `@a2a-js/sdk`
 * (Apache-2.0). This SDK adds no copy of them.
 */

export { Role, TaskState }
export type { A2AMessage, A2ATask, Artifact, Part }

/**
 * The key in `Message.metadata` and `Task.metadata` under which Gibson carries
 * what A2A has no field for. The value is a JSON object. The shape of the
 * message value is {@link Envelope}. The shape of the task value is
 * {@link ResultEnvelope}.
 */
export const EXTENSION_KEY = "https://zeroroot.ai/a2a/ext/gibson-run/v1"

/** Names the run that the daemon started a task for. */
export interface RunContext {
  missionRunId: string
  agentRunId: string
  runNumber: number
  /** The job that this run serves. Empty for a run with no job. */
  jobId: string
  traceId: string
  parentSpanId: string
}

/** The limits of a task. */
export interface AgentTaskConstraints {
  /** Max model turns. `0` means no limit. */
  maxTurns: number
  /** Max total tokens across the task. `0` means no limit. */
  maxTokens: number
  /** Allowlist of tools. Empty means all available tools. */
  allowedTools: string[]
  /** Denylist of tools. It wins over `allowedTools`. */
  blockedTools: string[]
}

/**
 * The Gibson context of a work item, as the daemon puts it in
 * `Message.metadata[EXTENSION_KEY]`. The field names are the JSON names of the
 * contract. All fields are optional.
 *
 * The mission id, the mission name and phase, the target and the full mission
 * execution context stay in the context map of the work item. They are not in
 * the envelope.
 */
export interface Envelope {
  mission_run_id?: string
  agent_run_id?: string
  run_number?: number
  job_id?: string
  trace_id?: string
  parent_span_id?: string
  /** Agent Skill ids (`skill:<name>`, the SKILL.md format). Not A2A card skills. */
  pinned_skills?: string[]
  constraints?: { max_turns?: number; max_tokens?: number; allowed_tools?: string[]; blocked_tools?: string[] }
  /** The free-form maps of the task. */
  context?: Record<string, unknown>
  metadata?: Record<string, unknown>
  /** A `gibson.job.v1.JobSpec` in protojson form. */
  job?: unknown
}

/** The structured error of a failed run. */
export interface ResultError {
  code: string
  message: string
  details?: Record<string, unknown>
  cause?: ResultError
  retryable: boolean
  component?: string
  stack?: string
}

/**
 * The Gibson part of the metadata of the Task that the SDK returns. It lives
 * in `Task.metadata[EXTENSION_KEY]`.
 */
export interface ResultEnvelope {
  /** The ids of the findings that the run submitted. */
  finding_ids?: string[]
  metadata?: Record<string, unknown>
  error?: ResultError
}

/** The task that an agent author works on. It comes from the A2A message of a work item. */
export interface AgentTask {
  /** The Gibson task id. It is the `taskId` of the message. */
  id: string
  /** The text of all text parts of the message, joined with a newline. */
  goal: string
  /** The A2A context id. The SDK copies it to the Task that it returns. */
  contextId: string
  /** The A2A message that started the run. It holds every part, for example a file part. */
  message: A2AMessage
  run: RunContext
  /** The Agent Skill ids that the mission pins for this task. */
  pinnedSkills: string[]
  /**
   * The loaded pinned skills as Open Responses items, a function call and a
   * function call output for each skill. The SDK fills it before the handler
   * runs. An agent puts these items at the start of its conversation, before
   * its first model call.
   */
  skillItems: (FunctionCallItem | FunctionCallOutputItem)[]
  constraints: AgentTaskConstraints
  context: Record<string, unknown>
  metadata: Record<string, unknown>
  /** Names the typed resources of a job. Unset for a task that needs none. */
  job?: JobSpec
}

/** What an agent author returns. {@link resultToTask} turns it into an A2A Task. */
export interface AgentResult {
  /**
   * The A2A Task state of the run, for example `TaskState.TASK_STATE_COMPLETED`
   * or `TaskState.TASK_STATE_INPUT_REQUIRED`. When it is unset, the state is
   * completed, or failed when `error` is set.
   */
  state?: TaskState
  /**
   * The task result. A string becomes a text part. A `Uint8Array` becomes a
   * raw part. Any other value becomes a data part. The SDK puts it in an
   * artifact named `output`. For the states input-required and auth-required it
   * becomes the status message instead.
   */
  output?: unknown
  /** A2A artifacts that the agent builds itself. They come before the `output` artifact. */
  artifacts?: Artifact[]
  /** Messages that the agent adds to the history. The message of the work item comes first. */
  history?: A2AMessage[]
  /** The ids of the findings that the run submitted. */
  findings?: string[]
  metadata?: Record<string, unknown>
  error?: ResultError
}

/** The error that {@link decodeWorkMessage} and {@link taskFromMessage} throw for a bad work item. */
export class WorkMessageError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "WorkMessageError"
  }
}

/** Decode the payload of a work item. It is one A2A message in A2A JSON. */
export function decodeWorkMessage(payload: Uint8Array): A2AMessage {
  let raw: unknown
  try {
    raw = JSON.parse(new TextDecoder().decode(payload))
  } catch (cause) {
    throw new WorkMessageError("the work payload is not JSON", { cause })
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new WorkMessageError("the work payload is not an A2A message")
  }
  try {
    return Message.fromJSON(raw)
  } catch (cause) {
    throw new WorkMessageError(`the work payload is not an A2A message: ${(cause as Error).message}`, { cause })
  }
}

/** Return the text of all text parts of a message, joined with a newline. */
export function messageTextOf(msg: A2AMessage): string {
  const texts: string[] = []
  for (const p of msg.parts) {
    if (p.content?.$case === "text" && p.content.value !== "") texts.push(p.content.value)
  }
  return texts.join("\n")
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []
}

/**
 * Build the task of an agent author from the A2A message of a work item. The
 * message must name its task and its context.
 */
export function taskFromMessage(msg: A2AMessage): AgentTask {
  if (!msg.taskId) throw new WorkMessageError("a2a message has no taskId")
  if (!msg.contextId) throw new WorkMessageError("a2a message has no contextId")
  const env = asRecord(msg.metadata?.[EXTENSION_KEY]) as Envelope
  const c = asRecord(env.constraints)
  const task: AgentTask = {
    id: msg.taskId,
    goal: messageTextOf(msg),
    contextId: msg.contextId,
    message: msg,
    run: {
      missionRunId: typeof env.mission_run_id === "string" ? env.mission_run_id : "",
      agentRunId: typeof env.agent_run_id === "string" ? env.agent_run_id : "",
      runNumber: typeof env.run_number === "number" ? env.run_number : 0,
      jobId: typeof env.job_id === "string" ? env.job_id : "",
      traceId: typeof env.trace_id === "string" ? env.trace_id : "",
      parentSpanId: typeof env.parent_span_id === "string" ? env.parent_span_id : "",
    },
    pinnedSkills: strings(env.pinned_skills),
    skillItems: [],
    constraints: {
      maxTurns: typeof c.max_turns === "number" ? c.max_turns : 0,
      maxTokens: typeof c.max_tokens === "number" ? c.max_tokens : 0,
      allowedTools: strings(c.allowed_tools),
      blockedTools: strings(c.blocked_tools),
    },
    context: asRecord(env.context),
    metadata: asRecord(env.metadata),
  }
  if (env.job !== undefined && env.job !== null) {
    try {
      task.job = fromJson(JobSpecSchema, env.job as JsonValue, { ignoreUnknownFields: true })
    } catch (cause) {
      throw new WorkMessageError(`decode job of the gibson envelope: ${(cause as Error).message}`, { cause })
    }
  }
  return task
}

/** Make an A2A message. The caller sets the ids that it needs. */
export function newMessage(
  role: Role,
  parts: Part[],
  ids: { taskId?: string; contextId?: string; metadata?: Record<string, unknown> } = {},
): A2AMessage {
  return {
    messageId: crypto.randomUUID(),
    contextId: ids.contextId ?? "",
    taskId: ids.taskId ?? "",
    role,
    parts,
    metadata: ids.metadata,
    extensions: [],
    referenceTaskIds: [],
  }
}

/** Make a text part. */
export function textPart(text: string): Part {
  return { content: { $case: "text", value: text }, metadata: undefined, filename: "", mediaType: "" }
}

/** Make a raw (bytes) part. */
export function rawPart(bytes: Uint8Array): Part {
  return { content: { $case: "raw", value: Buffer.from(bytes) }, metadata: undefined, filename: "", mediaType: "" }
}

/** Make a data part. The value is any JSON value. */
export function dataPart(value: unknown): Part {
  return { content: { $case: "data", value }, metadata: undefined, filename: "", mediaType: "" }
}

function outputPart(v: unknown): Part {
  if (typeof v === "string") return textPart(v)
  if (v instanceof Uint8Array) return rawPart(v)
  try {
    JSON.stringify(v)
  } catch (cause) {
    throw new Error(`encode the output of the result: ${(cause as Error).message}`, { cause })
  }
  return dataPart(v)
}

function failureText(r: AgentResult): string {
  if (!r.error) return "the run failed"
  return r.error.component ? `${r.error.component} [${r.error.code}]: ${r.error.message}` : `[${r.error.code}]: ${r.error.message}`
}

/**
 * Build the A2A Task that the SDK returns for a run. The Task state is the
 * state of the result. The history starts with the message that started the
 * run.
 */
export function resultToTask(task: AgentTask, result: AgentResult): A2ATask {
  const failed = result.error !== undefined
  let state = result.state ?? TaskState.TASK_STATE_UNSPECIFIED
  if (state === TaskState.TASK_STATE_UNSPECIFIED) {
    state = failed ? TaskState.TASK_STATE_FAILED : TaskState.TASK_STATE_COMPLETED
  }
  const out: A2ATask = {
    id: task.id,
    contextId: task.contextId,
    status: { state, message: undefined, timestamp: new Date().toISOString() },
    artifacts: [...(result.artifacts ?? [])],
    history: [task.message, ...(result.history ?? [])],
    metadata: undefined,
  }
  const ids = { taskId: task.id, contextId: task.contextId }
  if (failed) {
    out.status = { ...out.status!, message: newMessage(Role.ROLE_AGENT, [textPart(failureText(result))], ids) }
  }
  if (result.output !== undefined && result.output !== null) {
    const part = outputPart(result.output)
    if (state === TaskState.TASK_STATE_INPUT_REQUIRED || state === TaskState.TASK_STATE_AUTH_REQUIRED) {
      out.status = { ...out.status!, message: newMessage(Role.ROLE_AGENT, [part], ids) }
    } else {
      out.artifacts.push({
        artifactId: crypto.randomUUID(),
        name: "output",
        description: "",
        parts: [part],
        metadata: undefined,
        extensions: [],
      })
    }
  }
  const findings = result.findings ?? []
  const hasMetadata = result.metadata !== undefined && Object.keys(result.metadata).length > 0
  if (findings.length > 0 || hasMetadata || result.error) {
    const env: ResultEnvelope = {
      ...(findings.length > 0 ? { finding_ids: findings } : {}),
      ...(hasMetadata ? { metadata: result.metadata } : {}),
      ...(result.error ? { error: result.error } : {}),
    }
    out.metadata = { [EXTENSION_KEY]: env }
  }
  return out
}

/** Return an A2A Task as a plain A2A JSON value. */
export function taskToJson(task: A2ATask): unknown {
  return Task.toJSON(task)
}

/** Encode an A2A Task as A2A JSON, for `SubmitResult`. */
export function encodeTask(task: A2ATask): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(taskToJson(task)))
}

/** Return the name of the state of a Task, for example `TASK_STATE_COMPLETED`. */
export function taskStateName(task: A2ATask): string {
  return String((taskToJson(task) as { status?: { state?: unknown } }).status?.state ?? "TASK_STATE_UNSPECIFIED")
}

/** The name of the meta-tool that loads one Agent Skill. */
export const INVOKE_TOOL_NAME = "invoke_tool"

/** Call a tool by name with a JSON input. It returns the JSON output. */
export type ToolCaller = (toolName: string, inputJson: string) => Promise<string>

/**
 * Load each pinned Agent Skill with the `invoke_tool` meta-tool. It returns
 * two Open Responses items for each skill: a function call and a function call
 * output. A skill that fails to load stops the call, and the error names the
 * skill. The run must not start with a part of its pinned skills.
 */
export async function loadPinnedSkills(
  call: ToolCaller,
  ids: string[],
): Promise<(FunctionCallItem | FunctionCallOutputItem)[]> {
  const items: (FunctionCallItem | FunctionCallOutputItem)[] = []
  for (const [i, id] of ids.entries()) {
    const args = JSON.stringify({ id })
    let body: string
    try {
      const raw = await call(INVOKE_TOOL_NAME, args)
      try {
        body = JSON.stringify(JSON.parse(raw))
      } catch {
        body = raw
      }
    } catch (cause) {
      throw new Error(`load pinned skill ${JSON.stringify(id)}: ${(cause as Error).message}`, { cause })
    }
    const callId = `pinned_skill_${i}`
    items.push(
      { type: "function_call", call_id: callId, name: INVOKE_TOOL_NAME, arguments: args, status: "completed" },
      functionCallOutput(callId, body),
    )
  }
  return items
}
