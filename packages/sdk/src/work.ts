// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Client } from "@connectrpc/connect"
import {
  decodeWorkMessage,
  encodeTask,
  loadPinnedSkills,
  resultToTask,
  taskFromMessage,
  type A2AMessage,
  type AgentResult,
  type AgentTask,
} from "./a2a.js"
import type { ComponentService } from "./clients.js"
import type { InstanceRef } from "./component.js"

/**
 * Dispatched work — the pull side of the component contract.
 *
 * A registered component does not receive pushes. The daemon enqueues a
 * WorkItem onto a per-(tenant, kind, name) Redis stream and the component
 * claims it with PollWork, executes, and answers with SubmitResult. That is how
 * a mission node reaches code that lives outside the cluster.
 *
 * WHICH KINDS GET WORK. All three: `tool` (work_type `execute_proto`), `plugin`
 * (`plugin_invoke`) and `agent` (work_type `execute`). Agent dispatch was added
 * in gibson#1197 / ADR-0111.
 *
 * Each kind carries its own payload contract, so each gets its own codec and
 * its own `start*Worker` entry point. The poll/claim/submit/renew loop is the
 * same for every kind and is written once ({@link runWorker}); a second copy of
 * it would be a second place for the instance-renewal bug (sdk-ts#6) to live.
 *
 *   - **tool** — a protojson `gibson.tool.v1.ExecuteRequest` (`{ inputJson }`)
 *     answered with an `ExecuteResponse` (`{ outputJson }`). Both fields are
 *     JSON *strings*, not objects; the harness parses them on the far side.
 *   - **agent** — an A2A v1.0 `Message` in A2A JSON, answered with an A2A v1.0
 *     `Task` in A2A JSON (gibson#1366). The Gibson context that A2A has no
 *     field for rides in `Message.metadata` under one extension key (see
 *     `a2a.ts`). The agent has no AgentService and opens no port.
 */

/** What a tool handler receives: the already-parsed tool input. */
export interface ToolInvocation {
  workId: string
  workType: string
  context: Record<string, string>
  /** Parsed from ExecuteRequest.input_json. `{}` when the caller sent nothing. */
  input: Record<string, unknown>
}

/** A tool handler returns whatever the tool produces; it is JSON-encoded for the harness. */
export type ToolHandler = (invocation: ToolInvocation) => Promise<unknown>

const dec = new TextDecoder()
const enc = new TextEncoder()

/**
 * Decode a work item's payload into tool input.
 *
 * Tolerates both shapes protojson may produce for the field (`inputJson` and
 * `input_json`) rather than assuming the wire casing, and treats an absent or
 * empty input as `{}` — a tool invoked with no parameters is ordinary, not an
 * error worth failing the mission node over.
 */
export function decodeToolInput(payload: Uint8Array): Record<string, unknown> {
  const raw = dec.decode(payload).trim()
  if (!raw) return {}
  const envelope = JSON.parse(raw) as Record<string, unknown>
  const inner = (envelope.inputJson ?? envelope.input_json) as string | undefined
  if (!inner || !inner.trim()) return {}
  const parsed = JSON.parse(inner) as unknown
  return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : { value: parsed }
}

/** Encode a handler's return value as the ExecuteResponse the harness expects. */
export function encodeToolOutput(output: unknown): Uint8Array {
  return enc.encode(JSON.stringify({ outputJson: JSON.stringify(output ?? null) }))
}

/**
 * Encode a failure as an ExecuteResponse carrying the error.
 *
 * Reported as a result rather than left to time out: the harness blocks on this
 * work item for its full timeout (5 minutes by default), so a silent failure
 * stalls the whole mission node instead of failing it.
 */
export function encodeToolError(message: string): Uint8Array {
  return enc.encode(JSON.stringify({ outputJson: "", error: { message } }))
}

// ── agent contract (A2A over the work queue, gibson#1366) ───────────────────

/**
 * What an agent handler receives: the task that the SDK built from the A2A
 * message of the work item, plus the work-item envelope it arrived in.
 */
export interface AgentInvocation {
  workId: string
  workType: string
  /**
   * The context map of the work item: `mission_id`, `mission_name`,
   * `mission_phase`, `target_id` and the other keys. They are not in the A2A
   * message.
   */
  context: Record<string, string>
  /** The task. `task.goal` is the text of the message. `task.message` is the whole A2A message. */
  task: AgentTask
  /** `task.goal`. */
  goal: string
  /** Deadline for this run, in ms. `0` when the caller set none. */
  timeoutMs: number
  /** Aborts when the deadline of the run ends. Unset when the caller set no deadline. */
  signal?: AbortSignal
}

/**
 * What an agent handler returns. The SDK turns it into the A2A Task of the
 * result. The state of the Task is `state`. A handler that throws gives a work
 * item error with the code `EXECUTION_ERROR` and no Task.
 */
export type AgentOutcome = AgentResult

export type AgentHandler = (invocation: AgentInvocation) => Promise<AgentOutcome>

/** Decode an agent work payload. It throws {@link WorkMessageError} for a bad message. */
export function decodeAgentWork(payload: Uint8Array): { message: A2AMessage; task: AgentTask } {
  const message = decodeWorkMessage(payload)
  return { message, task: taskFromMessage(message) }
}

// ── the shared loop ─────────────────────────────────────────────────────────

/** The error codes of a work item that failed in the SDK, not in the code of the author. */
export type WorkErrorCode =
  | "DESERIALIZATION_ERROR"
  | "PINNED_SKILL_LOAD_FAILED"
  | "EXECUTION_ERROR"
  | "SERIALIZATION_ERROR"

/** The answer to a work item that failed. `error` is unset for a failure that rides in the result. */
interface WorkFailure {
  result: Uint8Array
  error?: { code: string; message: string; retryable: boolean }
}

/** Thrown by `prepare` to fail the work item with a code. */
class PrepareFailure extends Error {
  constructor(
    message: string,
    readonly code: WorkErrorCode,
  ) {
    super(message)
  }
}

/** How one work kind turns a claimed item into an invocation and back. */
interface WorkCodec<TInvocation, TOutcome> {
  decode(raw: {
    workId: string
    workType: string
    context: Record<string, string>
    payload: Uint8Array
    timeoutMs: number
  }): TInvocation
  /** Runs after `decode` and before the handler. It throws {@link PrepareFailure}. */
  prepare?(invocation: TInvocation, component: Client<typeof ComponentService>): Promise<void>
  encodeResult(outcome: TOutcome, invocation: TInvocation): Uint8Array
  fail(message: string, code: WorkErrorCode): WorkFailure
}

const toolCodec: WorkCodec<ToolInvocation, unknown> = {
  decode: (raw) => ({
    workId: raw.workId,
    workType: raw.workType,
    context: raw.context,
    input: decodeToolInput(raw.payload),
  }),
  encodeResult: (outcome) => encodeToolOutput(outcome),
  fail: (message) => ({ result: encodeToolError(message) }),
}

const agentCodec: WorkCodec<AgentInvocation, AgentOutcome> = {
  decode: (raw) => {
    const { task } = decodeAgentWork(raw.payload)
    return {
      workId: raw.workId,
      workType: raw.workType,
      context: raw.context,
      task,
      goal: task.goal,
      timeoutMs: raw.timeoutMs,
      ...(raw.timeoutMs > 0 ? { signal: AbortSignal.timeout(raw.timeoutMs) } : {}),
    }
  },
  prepare: async (inv, component) => {
    if (inv.task.pinnedSkills.length === 0) return
    // A skill that fails to load stops the run. The agent must not start with
    // a part of its pinned skills (gibson#1375).
    try {
      inv.task.skillItems = await loadPinnedSkills(async (toolName, inputJson) => {
        const res = await component.callTool({ workId: inv.workId, toolName, inputJson })
        if (res.error && (res.error.code || res.error.message)) {
          throw new Error(`${res.error.code}: ${res.error.message}`)
        }
        return res.outputJson
      }, inv.task.pinnedSkills)
    } catch (e) {
      throw new PrepareFailure((e as Error).message, "PINNED_SKILL_LOAD_FAILED")
    }
  },
  encodeResult: (outcome, inv) => encodeTask(resultToTask(inv.task, outcome)),
  fail: (message, code) => ({
    result: new Uint8Array(),
    error: { code, message, retryable: false },
  }),
}

interface LoopOptions<TInvocation, TOutcome> {
  handler: (invocation: TInvocation) => Promise<TOutcome>
  onError?: (e: unknown) => void
  onWork?: (item: TInvocation) => void
  backoffMs?: number
}

function runWorker<TInvocation, TOutcome>(
  component: Client<typeof ComponentService>,
  ref: InstanceRef,
  codec: WorkCodec<TInvocation, TOutcome>,
  opts: LoopOptions<TInvocation, TOutcome>,
): () => void {
  let stopped = false
  const backoff = opts.backoffMs ?? 2_000

  /** Answer the work item with a failure, so the mission node fails fast with a reason. */
  const submitFailure = async (workId: string, failure: WorkFailure): Promise<void> => {
    await component.submitResult({
      workId,
      result: failure.result,
      ...(failure.error ? { error: failure.error } : {}),
    })
  }

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await component.pollWork({ instanceId: ref.current() })
        if (!res.workId) continue // block timeout expired with no work
        let invocation: TInvocation
        try {
          invocation = codec.decode({
            workId: res.workId,
            workType: res.workType,
            context: res.context ?? {},
            payload: res.payload ?? new Uint8Array(),
            timeoutMs: Number(res.timeoutMs ?? 0n),
          })
        } catch (e) {
          opts.onError?.(e)
          await submitFailure(res.workId, codec.fail(`decode the work payload: ${(e as Error).message}`, "DESERIALIZATION_ERROR"))
          continue
        }
        opts.onWork?.(invocation)
        try {
          await codec.prepare?.(invocation, component)
        } catch (e) {
          opts.onError?.(e)
          const code = e instanceof PrepareFailure ? e.code : "EXECUTION_ERROR"
          await submitFailure(res.workId, codec.fail((e as Error).message, code))
          continue
        }
        let outcome: TOutcome
        try {
          outcome = await opts.handler(invocation)
        } catch (e) {
          // The handler failing is a work error, not a worker error: answer the
          // work item so the mission node fails fast with a reason.
          opts.onError?.(e)
          await submitFailure(res.workId, codec.fail((e as Error).message, "EXECUTION_ERROR"))
          continue
        }
        let result: Uint8Array
        try {
          result = codec.encodeResult(outcome, invocation)
        } catch (e) {
          opts.onError?.(e)
          await submitFailure(res.workId, codec.fail(`encode the result: ${(e as Error).message}`, "SERIALIZATION_ERROR"))
          continue
        }
        await component.submitResult({ workId: res.workId, result })
      } catch (e) {
        if (stopped) return
        opts.onError?.(e)
        // An expired instance is recoverable and self-inflicted-looking: the
        // daemon simply forgot us. Renew through the SHARED ref so the heartbeat
        // keeps the same instance alive — when the two held separate ids, the
        // heartbeat kept a dead one warm while this loop polled an id the daemon
        // let expire, and the process spun forever looking healthy.
        if (/not[ _]?found/i.test((e as Error).message)) {
          try {
            await ref.renew()
            continue
          } catch (re) {
            opts.onError?.(re)
          }
        }
        await new Promise((r) => setTimeout(r, backoff))
      }
    }
  }

  void loop()
  return () => {
    stopped = true
  }
}

export interface WorkerOptions {
  /** Handles a claimed tool invocation. */
  handler: ToolHandler
  /** Called on transport errors; polling continues regardless. */
  onError?: (e: unknown) => void
  /** Called when a work item is claimed, before the handler runs. */
  onWork?: (item: ToolInvocation) => void
  /** Delay before re-polling after an error, ms (default 2000). */
  backoffMs?: number
}

/** Poll for and serve `execute_proto` work as a registered `kind=tool`. */
export function startWorker(
  component: Client<typeof ComponentService>,
  ref: InstanceRef,
  opts: WorkerOptions,
): () => void {
  return runWorker(component, ref, toolCodec, opts)
}

export interface AgentWorkerOptions {
  /** Handles a claimed agent invocation. */
  handler: AgentHandler
  /** Called on transport errors; polling continues regardless. */
  onError?: (e: unknown) => void
  /** Called when a work item is claimed, before the handler runs. */
  onWork?: (item: AgentInvocation) => void
  /** Delay before re-polling after an error, ms (default 2000). */
  backoffMs?: number
}

/**
 * Poll for and serve agent work as a registered `kind=agent`.
 *
 * The counterpart to {@link startWorker} for goal-driven executors. The daemon
 * hands over an A2A message. The handler pursues the goal and returns an
 * {@link AgentOutcome}. The SDK submits it as an A2A Task.
 */
export function startAgentWorker(
  component: Client<typeof ComponentService>,
  ref: InstanceRef,
  opts: AgentWorkerOptions,
): () => void {
  return runWorker(component, ref, agentCodec, opts)
}
