// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { z } from "zod"
import { InputKind, JobState, type Inbox, type JobInput } from "./inbox.js"
import { TAG, type Log } from "./log.js"
import type { ToolDefinition } from "./registry.js"
import { defineTool } from "./tool.js"
import { failure, text } from "./tools/result.js"

/**
 * `ask`: the one way a job reaches a person (gibson#1706, decision 16).
 *
 * The wire has no `INPUT_KIND_QUESTION`. `gibson.job.v1.InputKind` carries
 * `TURN`, `ANSWER` and `WRAP_UP`, and issue #59 expected a
 * `JobService.SendEvent` that B1 did not ship. So the question is signalled
 * two ways with what exists: `ReportJobState(job_id, WAITING)` is the state
 * the console renders and the stale-limit reaper reads, and the text rides
 * on an input, which is the only field on the wire that carries prose. The
 * id the daemon returns for that input is remembered, so a member that is
 * handed back its own question says so instead of answering itself.
 *
 * A job runs Claude Code with `--dangerously-skip-permissions`; the gVisor
 * sandbox and the per-turn grant are the controls. So there is no permission
 * dialog, and a question has to travel the same path as every other input:
 * out through the job, back through the inbox. The driver wires this tool as
 * `--permission-prompt-tool mcp__gibson__ask`.
 *
 * The job enters `waiting` while the question is outstanding, and the next
 * input for that job is the answer. Input for another job is not an answer
 * to this question, so it is left in the stream for its own turn.
 *
 * The reply is the shape Claude Code's permission-prompt contract expects:
 * `{"behavior":"allow","updatedInput":{...}}` or
 * `{"behavior":"deny","message":"..."}`. A free-text answer to a plain
 * question comes back as an allow carrying the text, because that is how a
 * question that is not about a tool call is answered.
 */

/** What Claude Code reads back from a permission-prompt tool. */
export type PermissionDecision =
  | { behavior: "allow"; updatedInput: Record<string, unknown> }
  | { behavior: "deny"; message: string }

/** Words an answer may use to refuse. Anything else allows. */
const DENIALS = /^\s*(no|deny|denied|reject|rejected|refuse|refused|stop|do not|don't)\b/i

export function decisionFrom(answer: string, toolInput: Record<string, unknown>): PermissionDecision {
  if (DENIALS.test(answer)) return { behavior: "deny", message: answer.trim() }
  return { behavior: "allow", updatedInput: toolInput }
}

/** A source of answers: the next input for one job. */
export interface AnswerSource {
  /** Resolve with the next input for `jobId`, or reject when it cannot come. */
  next(jobId: string, signal?: AbortSignal): Promise<JobInput>
}

/**
 * Route inbox messages to whoever is waiting for that job.
 *
 * One reader of the stream, many waiters: two jobs can each hold an open
 * question at the same time, and a message for one must not wake the other.
 */
export class AnswerRouter implements AnswerSource {
  private readonly waiting = new Map<string, ((input: JobInput) => void)[]>()
  private readonly pending = new Map<string, JobInput[]>()

  /** Offer a message. Returns true when a waiter took it. */
  offer(input: JobInput): boolean {
    const queue = this.waiting.get(input.jobId)
    if (!queue) return false
    const resolve = queue.shift()
    if (!resolve) return false
    if (queue.length === 0) this.waiting.delete(input.jobId)
    resolve(input)
    return true
  }

  /** Hold a message that arrived before anyone asked for it. */
  hold(input: JobInput): void {
    if (this.offer(input)) return
    const queue = this.pending.get(input.jobId) ?? []
    queue.push(input)
    this.pending.set(input.jobId, queue)
  }

  next(jobId: string, signal?: AbortSignal): Promise<JobInput> {
    const held = this.pending.get(jobId)
    const first = held?.shift()
    if (first) {
      if (held && held.length === 0) this.pending.delete(jobId)
      return Promise.resolve(first)
    }
    return new Promise<JobInput>((resolve, reject) => {
      const queue = this.waiting.get(jobId) ?? []
      queue.push(resolve)
      this.waiting.set(jobId, queue)
      signal?.addEventListener(
        "abort",
        () => {
          const q = this.waiting.get(jobId)
          const i = q?.indexOf(resolve) ?? -1
          if (q && i >= 0) q.splice(i, 1)
          reject(new Error("the question was cancelled before an answer arrived"))
        },
        { once: true },
      )
    })
  }
}

export interface AskOptions {
  /** The job the current turn belongs to. */
  jobId: () => string | undefined
  inbox: Pick<Inbox, "send" | "reportState">
  answers: AnswerSource
  /** The Claude Code session this job runs, when the driver knows it. */
  claudeSessionId?: () => string | undefined
  log?: Log
}

export function askTool(opts: AskOptions): ToolDefinition {
  return defineTool({
    name: "ask",
    description:
      "Ask the person or the agent that opened this job a question, and wait for the answer. Use it " +
      "when you need a decision you cannot make yourself: a choice between two approaches, a missing " +
      "fact, or permission for something outside the job's declared deliverable. The job waits while " +
      "the question is open, so ask once and ask precisely.",
    input: {
      question: z.string().describe("The question, in one or two sentences. Say what you will do with each answer."),
      tool_name: z.string().optional().describe("When this is a permission prompt, the tool Claude Code wants to run."),
      input: z.record(z.string(), z.unknown()).optional().describe("When this is a permission prompt, the input Claude Code wants to run it with."),
    },
    handler: async (args, ctx) => {
      const jobId = opts.jobId()
      if (!jobId) {
        return failure(
          "no job is open",
          "ask reaches the person through the job's inbox, and this turn belongs to no job. " +
            "The driver sets the job with POST /turn before it feeds a message.",
        )
      }
      const question = args.tool_name ? `${args.question}\n\nClaude Code wants to run ${args.tool_name} with:\n${JSON.stringify(args.input ?? {}, null, 2)}` : args.question
      try {
        // The wait is armed before the question is sent. Arming it after
        // would drop an answer that came back faster than this call returns.
        const answer = opts.answers.next(jobId, ctx.signal)
        // WAITING is the signal that a question is open: it is what the
        // console renders and what the stale-limit reaper reads. The text
        // rides on an input, because that is the only field on the wire that
        // carries prose.
        await opts.inbox.reportState(jobId, JobState.WAITING, opts.claudeSessionId?.())
        const sent = await opts.inbox.send(jobId, question, InputKind.TURN)
        opts.log?.(`${TAG} job ${jobId} is waiting on a question`)
        const input = await answer.finally(async () => {
          await opts.inbox.reportState(jobId, JobState.WORKING, opts.claudeSessionId?.()).catch(() => {})
        })
        opts.log?.(`${TAG} job ${jobId} got its answer from ${input.sender || "the inbox"}`)
        if (input.id && input.id === sent.id) {
          return failure("ask heard its own question", "The inbox returned the question this job just posted. The daemon must not deliver a member its own input.")
        }
        if (args.tool_name) return text("", JSON.stringify(decisionFrom(input.message, args.input ?? {})))
        return text("", input.message)
      } catch (e) {
        return failure("ask failed", (e as Error).message)
      }
    },
  })
}
