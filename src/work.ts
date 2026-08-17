import { create, fromJsonString, toJsonString } from "@bufbuild/protobuf"
import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"
import type { InstanceRef } from "./component.js"
import {
  ExecuteRequestSchema,
  ExecuteResponseSchema,
  type ExecuteRequest,
} from "./gen/gibson/agent/v1/agent_pb.js"
import { ErrorSchema } from "./gen/gibson/common/v1/gibson_common_pb.js"
import { ResultSchema, ResultStatus, type Task } from "./gen/gibson/types/v1/types_pb.js"

/**
 * Dispatched work — the pull side of the component contract.
 *
 * A registered component does not receive pushes. The daemon enqueues a
 * WorkItem onto a per-(tenant, kind, name) Redis stream and the component
 * claims it with PollWork, executes, and answers with SubmitResult. That is how
 * a mission node reaches code that lives outside the cluster.
 *
 * WHICH KINDS GET WORK. All three: `tool` (work_type `execute_proto`), `plugin`
 * (`plugin_invoke`) and `agent` (`agent_execute`). Agent dispatch was added in
 * gibson#1197 / ADR-0011 — before that an agent node resolved only against an
 * in-process registry, and a component registered as kind=agent polled forever.
 *
 * Each kind carries its own payload contract, so each gets its own codec and
 * its own `start*Worker` entry point. The poll/claim/submit/renew loop is the
 * same for every kind and is written once ({@link runWorker}); a second copy of
 * it would be a second place for the instance-renewal bug (sdk-ts#6) to live.
 *
 *   - **tool** — a protojson `gibson.tool.v1.ExecuteRequest` (`{ inputJson }`)
 *     answered with an `ExecuteResponse` (`{ outputJson }`). Both fields are
 *     JSON *strings*, not objects; the harness parses them on the far side.
 *   - **agent** — a protojson `gibson.agent.v1.ExecuteRequest` answered with a
 *     `gibson.agent.v1.ExecuteResponse`. Genuinely typed messages, so this side
 *     uses the generated schemas rather than hand-built JSON.
 */

/** A claimed unit of work. */
export interface WorkItem {
  workId: string
  workType: string
  payload: Uint8Array
  context: Record<string, string>
  timeoutMs: bigint
}

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

// ── agent contract (zerocool-plugins#33) ────────────────────────────────────

/**
 * What an agent handler receives: the decoded `gibson.agent.v1.ExecuteRequest`
 * plus the work-item envelope it arrived in.
 *
 * A goal-driven executor needs more than a parameter bag, so unlike
 * {@link ToolInvocation} this exposes the whole decoded request. The named
 * fields are the ones every handler reaches for; `request` carries the rest
 * (`mission`, `target`, and anything a newer daemon adds) without this type
 * having to grow a field per proto field.
 */
export interface AgentInvocation {
  workId: string
  workType: string
  context: Record<string, string>
  /** The task to pursue. Absent only from a malformed dispatch. */
  task?: Task
  /** `task.goal` — the natural-language objective. `""` when no task was sent. */
  goal: string
  /**
   * Where to reach HarnessCallbackService for LLM, tools, findings and
   * knowledge during this run, and the token that authenticates to it. Empty
   * when the daemon dispatched without a callback seam.
   */
  callbackEndpoint: string
  callbackToken: string
  /** Deadline for this run, in ms. `0` when the caller set none. */
  timeoutMs: number
  /** Provenance the platform correlates this run by. */
  missionRunId: string
  agentRunId: string
  runNumber: number
  traceId: string
  parentSpanId: string
  /** The full decoded request, for anything the named fields omit. */
  request: ExecuteRequest
}

/**
 * What an agent handler returns. Mapped onto `gibson.types.v1.Result`, which is
 * what `agent.ProtoToResult` reads on the gibson side.
 */
export interface AgentOutcome {
  /** JSON-encoded into `Result.output`. */
  output?: unknown
  /** IDs of findings this run submitted, for `Result.finding_ids`. */
  findingIds?: string[]
  /** Free-form strings for `Result.metadata`. */
  metadata?: Record<string, string>
  /**
   * `false` marks the run failed without throwing — a goal the agent judged
   * unreachable is a real outcome, not an exception. Defaults to `true`.
   */
  success?: boolean
}

export type AgentHandler = (invocation: AgentInvocation) => Promise<AgentOutcome>

/**
 * Decode an `agent_execute` payload.
 *
 * `ignoreUnknownFields` mirrors gibson's own `protojson.UnmarshalOptions{
 * DiscardUnknown: true}` on the response leg: a daemon that adds a field must
 * not crash every worker built against the older schema.
 */
export function decodeAgentExecute(payload: Uint8Array): ExecuteRequest {
  const raw = dec.decode(payload).trim()
  if (!raw) return create(ExecuteRequestSchema, {})
  return fromJsonString(ExecuteRequestSchema, raw, { ignoreUnknownFields: true })
}

/** Encode a successful (or self-reported failed) run as an ExecuteResponse. */
export function encodeAgentResult(outcome: AgentOutcome): Uint8Array {
  const metadata: Record<string, { kind: { case: "stringValue"; value: string } }> = {}
  for (const [k, v] of Object.entries(outcome.metadata ?? {})) {
    metadata[k] = { kind: { case: "stringValue", value: v } }
  }
  const response = create(ExecuteResponseSchema, {
    result: create(ResultSchema, {
      status: outcome.success === false ? ResultStatus.FAILED : ResultStatus.SUCCESS,
      output: { kind: { case: "stringValue", value: JSON.stringify(outcome.output ?? null) } },
      findingIds: outcome.findingIds ?? [],
      metadata,
    }),
  })
  return enc.encode(toJsonString(ExecuteResponseSchema, response))
}

/**
 * Encode a failure as an ExecuteResponse carrying `error`.
 *
 * `code` is set as well as `message` because gibson's gate is
 * `e.GetMessage() != "" || e.GetCode() != ""` — an error object with neither is
 * read as success, which would report a crashed run as a completed one.
 */
export function encodeAgentError(message: string, code = "AGENT_EXECUTION_FAILED"): Uint8Array {
  const response = create(ExecuteResponseSchema, {
    error: create(ErrorSchema, { code, message, retryable: false }),
  })
  return enc.encode(toJsonString(ExecuteResponseSchema, response))
}

// ── the shared loop ─────────────────────────────────────────────────────────

/** How one work kind turns a claimed item into an invocation and back. */
interface WorkCodec<TInvocation, TOutcome> {
  decode(raw: {
    workId: string
    workType: string
    context: Record<string, string>
    payload: Uint8Array
  }): TInvocation
  encodeResult(outcome: TOutcome): Uint8Array
  encodeError(message: string): Uint8Array
}

const toolCodec: WorkCodec<ToolInvocation, unknown> = {
  decode: (raw) => ({
    workId: raw.workId,
    workType: raw.workType,
    context: raw.context,
    input: decodeToolInput(raw.payload),
  }),
  encodeResult: encodeToolOutput,
  encodeError: encodeToolError,
}

const agentCodec: WorkCodec<AgentInvocation, AgentOutcome> = {
  decode: (raw) => {
    const request = decodeAgentExecute(raw.payload)
    return {
      workId: raw.workId,
      workType: raw.workType,
      context: raw.context,
      task: request.task,
      goal: request.task?.goal ?? "",
      callbackEndpoint: request.callbackEndpoint,
      callbackToken: request.callbackToken,
      timeoutMs: Number(request.timeoutMs),
      missionRunId: request.missionRunId,
      agentRunId: request.agentRunId,
      runNumber: request.runNumber,
      traceId: request.traceId,
      parentSpanId: request.parentSpanId,
      request,
    }
  },
  encodeResult: encodeAgentResult,
  encodeError: encodeAgentError,
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

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await component.pollWork({ instanceId: ref.current() })
        if (!res.workId) continue // block timeout expired with no work
        const invocation = codec.decode({
          workId: res.workId,
          workType: res.workType,
          context: res.context ?? {},
          payload: res.payload ?? new Uint8Array(),
        })
        opts.onWork?.(invocation)
        let result: Uint8Array
        try {
          result = codec.encodeResult(await opts.handler(invocation))
        } catch (e) {
          // The handler failing is a work error, not a worker error: answer the
          // work item so the mission node fails fast with a reason.
          result = codec.encodeError((e as Error).message)
          opts.onError?.(e)
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
 * Poll for and serve `agent_execute` work as a registered `kind=agent`.
 *
 * The counterpart to {@link startWorker} for goal-driven executors: the daemon
 * hands over a Task and a callback seam, and the handler pursues the goal for as
 * long as the dispatch allows.
 */
export function startAgentWorker(
  component: Client<typeof ComponentService>,
  ref: InstanceRef,
  opts: AgentWorkerOptions,
): () => void {
  return runWorker(component, ref, agentCodec, opts)
}
