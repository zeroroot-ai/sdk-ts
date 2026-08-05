import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

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
 * Each kind carries its own payload contract. The helpers below cover the tool
 * contract; an agent worker receives a protojson `gibson.agent.v1.ExecuteRequest`
 * and answers with an `ExecuteResponse`.
 *
 * The tool payload is a protojson-encoded gibson.tool.v1.ExecuteRequest —
 * `{ inputJson: string }` — and the result must be a protojson-encoded
 * ExecuteResponse — `{ outputJson: string }`. Both `input_json` and
 * `output_json` are themselves JSON *strings*, not objects; the harness parses
 * them on the far side.
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

export interface WorkerOptions {
  /** Instance id returned by RegisterComponent. */
  instanceId: string
  /** Handles a claimed tool invocation. */
  handler: ToolHandler
  /** Called on transport errors; polling continues regardless. */
  onError?: (e: unknown) => void
  /** Called when a work item is claimed, before the handler runs. */
  onWork?: (item: ToolInvocation) => void
  /** Delay before re-polling after an error, ms (default 2000). */
  backoffMs?: number
  /**
   * Re-register and return a fresh instance id.
   *
   * The daemon expires a component instance that stops heartbeating, and then
   * PollWork answers NotFound forever. Without a way back, a worker that
   * survives a brief disconnect turns into a process that is up, logging, and
   * permanently invisible to the fleet — the worst failure shape available.
   */
  reregister?: () => Promise<string>
}

/**
 * Poll for work until stopped. Returns a stop function.
 *
 * PollWork long-polls server-side, so this is not a busy loop: each call blocks
 * until work arrives or the server's block timeout expires, then immediately
 * polls again. Errors back off instead of hot-looping, because the common
 * failure here is the daemon being briefly unreachable and a tight retry would
 * turn that into a self-inflicted outage.
 */
export function startWorker(
  component: Client<typeof ComponentService>,
  opts: WorkerOptions,
): () => void {
  let stopped = false
  const backoff = opts.backoffMs ?? 2_000

  let instanceId = opts.instanceId

  const loop = async (): Promise<void> => {
    while (!stopped) {
      try {
        const res = await component.pollWork({ instanceId })
        if (!res.workId) continue // block timeout expired with no work
        const invocation: ToolInvocation = {
          workId: res.workId,
          workType: res.workType,
          context: res.context ?? {},
          input: decodeToolInput(res.payload ?? new Uint8Array()),
        }
        opts.onWork?.(invocation)
        let result: Uint8Array
        try {
          result = encodeToolOutput(await opts.handler(invocation))
        } catch (e) {
          // The handler failing is a tool error, not a worker error: answer the
          // work item so the mission node fails fast with a reason.
          result = encodeToolError((e as Error).message)
          opts.onError?.(e)
        }
        await component.submitResult({ workId: res.workId, result })
      } catch (e) {
        if (stopped) return
        opts.onError?.(e)
        // An expired instance is recoverable and self-inflicted-looking: the
        // daemon simply forgot us. Re-register rather than backing off forever
        // against an id that will never be valid again.
        if (opts.reregister && /not[ _]?found/i.test((e as Error).message)) {
          try {
            instanceId = await opts.reregister()
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
