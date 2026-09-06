// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { TaskHarness } from "@zeroroot-ai/sdk"
import type { Principal } from "@zeroroot-ai/sdk/gen/gibson/common/v1/gibson_common_pb.js"
import type { Input } from "@zeroroot-ai/sdk/gen/gibson/job/v1/job_pb.js"
import { InputKind, JobState } from "@zeroroot-ai/sdk/gen/gibson/job/v1/job_pb.js"
import { TAG, type Log } from "./log.js"

/**
 * The member inbox (gibson#1706, decisions 6 and 11).
 *
 * Input to a long-lived member is one daemon-owned inbox, pulled outbound by
 * the sandbox: the member subscribes and the daemon streams messages down
 * it. The sandbox never accepts an inbound connection, so setec `Attach` is
 * not used and no port is opened.
 *
 * The subscription is a lifetime RPC and runs under the base grant. Each
 * message carries the grant of its own dispatch, which the driver then puts
 * in force for that turn (see turn.ts).
 */

export { InputKind, JobState }

/** One message from the inbox, flattened from `gibson.job.v1.Input`. */
export interface JobInput {
  id: string
  jobId: string
  message: string
  /** The task grant of the dispatch that sent this message. */
  grant: string
  /** Who sent it, as `<kind>:<id>`: a person, an agent, a tool or a mission node. */
  sender: string
  kind: InputKind
  /** Unix milliseconds, or 0 when the daemon sent no timestamp. */
  sentAt: number
}

export const MISSING_RPC =
  "this daemon's harness has no SubscribeInput. The inbox RPCs ship with gibson.job.v1 " +
  "(buf.build/zeroroot-ai/sdk v0.177.0); update the daemon."

/** The subset of the harness client this module needs. */
type InboxClient = Pick<TaskHarness["client"], "subscribeInput" | "sendInput" | "reportJobState">

/** True when the harness client carries the inbox RPCs. */
export function inboxAvailable(harness: TaskHarness): boolean {
  const client = harness.client as unknown as Record<string, unknown>
  return typeof client.subscribeInput === "function" && typeof client.sendInput === "function" && typeof client.reportJobState === "function"
}

function inboxClient(harness: TaskHarness): InboxClient {
  if (!inboxAvailable(harness)) throw new Error(`gibson-mcp: ${MISSING_RPC}`)
  return harness.client
}

/** `<kind>:<id>`, e.g. `KIND_USER:u-1`. Empty when the daemon named nobody. */
export function principalName(p: Principal | undefined): string {
  if (!p) return ""
  return `${p.kind}:${p.id}`
}

/** Flatten one wire `Input`. */
export function toJobInput(input: Input | undefined): JobInput {
  return {
    id: input?.id ?? "",
    jobId: input?.jobId ?? "",
    message: input?.message ?? "",
    grant: input?.grant ?? "",
    sender: principalName(input?.sender),
    kind: input?.kind ?? InputKind.UNSPECIFIED,
    sentAt: input?.sentAt ? Number(input.sentAt.seconds) * 1000 : 0,
  }
}

export interface InboxOptions {
  harness: TaskHarness
  log?: Log
  /** Backoff between reconnects, in ms. Doubles up to the cap. */
  minBackoffMs?: number
  maxBackoffMs?: number
  signal?: AbortSignal
  /** Test seam. */
  sleep?: (ms: number) => Promise<void>
}

export const MIN_BACKOFF_MS = 500
export const MAX_BACKOFF_MS = 30_000

export interface Inbox {
  /**
   * Every message for this member, in order. Reconnects on its own, so a
   * caller writes one `for await` and never handles a dropped stream.
   */
  messages(): AsyncIterable<JobInput>
  /** Send a message into a job. Returns the input the daemon recorded. */
  send(jobId: string, message: string, kind: InputKind): Promise<JobInput>
  /** Tell the daemon a job moved to WORKING or WAITING. */
  reportState(jobId: string, state: JobState, claudeSessionId?: string): Promise<void>
  /** Stop the subscription. */
  stop(): void
}

/**
 * Subscribe to the inbox, reconnecting with backoff.
 *
 * A dropped stream is normal on a long-lived member: the daemon rolls, the
 * edge recycles a connection. Reconnecting is the wrapper's job, because a
 * driver that had to do it would either drop messages or stop pulling.
 */
export function openInbox(opts: InboxOptions): Inbox {
  const { harness } = opts
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.()))
  const minBackoff = opts.minBackoffMs ?? MIN_BACKOFF_MS
  const maxBackoff = opts.maxBackoffMs ?? MAX_BACKOFF_MS
  let stopped = false
  const controller = new AbortController()
  opts.signal?.addEventListener("abort", () => controller.abort(), { once: true })

  async function* messages(): AsyncIterable<JobInput> {
    // Resolved once, outside the retry loop. A daemon with no SubscribeInput
    // is a permanent condition, and retrying it every thirty seconds forever
    // would bury the one line that says what is missing.
    const client = inboxClient(harness)
    let backoff = minBackoff
    while (!stopped && !controller.signal.aborted) {
      try {
        for await (const res of client.subscribeInput({ context: harness.context }, { signal: controller.signal })) {
          if (stopped) return
          backoff = minBackoff // a message proves the stream is healthy
          yield toJobInput(res.input)
        }
        // A clean end of stream is the daemon closing the subscription. Ask
        // again after a pause rather than treating it as the end of the
        // member's life.
      } catch (e) {
        if (stopped || controller.signal.aborted) return
        opts.log?.(`${TAG} inbox: ${(e as Error).message}; reconnecting in ${backoff}ms`)
      }
      if (stopped || controller.signal.aborted) return
      await sleep(backoff)
      backoff = Math.min(maxBackoff, backoff * 2)
    }
  }

  return {
    messages,
    send: async (jobId, message, kind) => {
      const res = await inboxClient(harness).sendInput({ context: harness.context, jobId, message, kind })
      if (res.error) throw new Error(`SendInput refused: ${res.error.message}`)
      return toJobInput(res.input)
    },
    reportState: async (jobId, state, claudeSessionId) => {
      const res = await inboxClient(harness).reportJobState({ context: harness.context, jobId, state, claudeSessionId: claudeSessionId ?? "" })
      if (res.error) throw new Error(`ReportJobState refused: ${res.error.message}`)
    },
    stop: () => {
      stopped = true
      controller.abort()
    },
  }
}

/** Somewhere an answer can be delivered. {@link AnswerRouter} implements it. */
export interface AnswerSink {
  /** Take the message as an answer to an open question. */
  offer(input: JobInput): boolean
}

/**
 * Read the inbox once and split it two ways.
 *
 * A message that answers an open `ask` belongs to that question, not to a
 * new turn, so it is consumed here and never reaches the driver. Everything
 * else is queued for the driver, which decides what turn it starts.
 *
 * The pump runs whether or not the driver is iterating. Waiting for the
 * driver to pull would mean an answer only arrives once the driver asked for
 * the next turn, and the turn cannot start until the question is answered.
 */
export function routeAnswers(inbox: Inbox, answers: AnswerSink, log?: Log): Inbox {
  const queue: JobInput[] = []
  const waiting: ((input: JobInput | undefined) => void)[] = []
  let stopped = false

  const push = (input: JobInput): void => {
    const next = waiting.shift()
    if (next) next(input)
    else queue.push(input)
  }

  void (async () => {
    try {
      for await (const input of inbox.messages()) {
        if (stopped) return
        if (answers.offer(input)) continue
        push(input)
      }
    } catch (e) {
      if (!stopped) log?.(`${TAG} inbox pump stopped: ${(e as Error).message}`)
    }
  })()

  async function* messages(): AsyncIterable<JobInput> {
    while (!stopped) {
      const first = queue.shift()
      if (first) {
        yield first
        continue
      }
      const next = await new Promise<JobInput | undefined>((resolve) => {
        waiting.push(resolve)
        if (stopped) resolve(undefined)
      })
      if (!next) return
      yield next
    }
  }

  return {
    messages,
    send: (jobId, message, kind) => inbox.send(jobId, message, kind),
    reportState: (jobId, state, claudeSessionId) => inbox.reportState(jobId, state, claudeSessionId),
    stop: () => {
      stopped = true
      for (const resolve of waiting.splice(0)) resolve(undefined)
      inbox.stop()
    },
  }
}
