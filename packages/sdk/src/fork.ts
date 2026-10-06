// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { hostname } from "node:os"
import { Code, ConnectError } from "@connectrpc/connect"
import { BinaryReader, WireType } from "@bufbuild/protobuf/wire"
import type { Task } from "./gen/gibson/types/v1/types_pb.js"

/**
 * The runtime fork contract (D74, zeroroot-ai/sdk#248), the TypeScript copy of
 * the Go package `github.com/zeroroot-ai/sdk/fork`.
 *
 * A fork from a snapshot continues the process of its parent. It starts with
 * the grant, the callback identity and the task of the parent in memory. This
 * module lets the process find out that it is a fork, and claim its own
 * dispatch from the daemon before it does anything else.
 *
 *  - Each callback carries a new setec identity token and the hostname
 *    (`sandboxIdentityInterceptor` in task-harness). The daemon takes the
 *    sandbox of the caller only from the token.
 *  - The daemon refuses the grant of a forked source outside the source
 *    sandbox with FAILED_PRECONDITION and the reason
 *    {@link REASON_FORK_UNCLAIMED}. {@link isForkUnclaimed} recognizes it.
 *  - A fork claims its dispatch with `HarnessCallbackService.ClaimFork`. The
 *    call carries the identity token and no grant (D80): the grant in memory
 *    is the one of the source, and it can be long expired. The claim holds
 *    the new grant, the ids, the node id, the model and the task.
 *  - A source that may be forked ({@link FORKABLE_ENV}) parks after its
 *    result line ({@link park}). An agent that forks its current state gets
 *    {@link ForkedError} in the fork ({@link point}).
 */

/** Set to "1" by the daemon at the launch of a node that a later node names in starts_from. */
export const FORKABLE_ENV = "GIBSON_FORKABLE"

/** Bounds the park of a source, as a Go duration ("10m"). Unset or empty means the default. */
export const PARK_TIMEOUT_ENV = "GIBSON_PARK_TIMEOUT"

/** The ErrorInfo reason of the refusal of a grant outside the sandbox it was given to. */
export const REASON_FORK_UNCLAIMED = "GIBSON_FORK_UNCLAIMED"

/** The ErrorInfo domain of {@link REASON_FORK_UNCLAIMED}. */
export const FORK_ERROR_DOMAIN = "gibson.harness.v1"

/** The park bound when {@link PARK_TIMEOUT_ENV} is unset. */
export const DEFAULT_PARK_TIMEOUT_MS = 10 * 60 * 1000

/** How often a parked process checks its hostname. */
export const DEFAULT_POLL_INTERVAL_MS = 500

/** The dispatch of a fork, as ClaimFork returns it. */
export interface Claim {
  /** The id that the fork claimed with. */
  sandboxId: string
  /** The capability grant of the fork. Use it for each later call. */
  grant: string
  /** These ids scope the callbacks of the fork. */
  missionId: string
  missionRunId: string
  agentRunId: string
  /** The mission node that the fork runs. */
  nodeId: string
  /** The model resolved for this dispatch. */
  model: string
  /** The task that the fork runs. */
  task: Task | undefined
}

/** Asks the daemon for the dispatch of a fork. The task harness implements it. */
export interface Claimer {
  claimFork(sandboxId: string): Promise<Claim>
}

/**
 * The error that a call returns in a fork when the agent forked its current
 * state (ORIGINATION_START_CALLER_STATE). The parent gets the normal result of
 * the call. Read the claim and run its task.
 */
export class ForkedError extends Error {
  readonly claim: Claim
  constructor(claim: Claim) {
    super(`fork: this process is the fork ${claim.sandboxId} and runs node ${JSON.stringify(claim.nodeId)}`)
    this.name = "ForkedError"
    this.claim = claim
  }
}

/** Reads the hostname. Tests replace it with {@link Watcher.withReader}. */
export function sandboxId(): string {
  return hostname().trim()
}

/**
 * Compares the sandbox id of the process with the id at the time the watcher
 * was made. Make it before a fork can happen, at process start. A fork copies
 * the memory of its parent, so its watcher holds the id of the parent.
 */
export class Watcher {
  readonly origin: string
  private readonly read: () => string

  private constructor(read: () => string) {
    this.read = read
    this.origin = read()
  }

  /** Record the sandbox id of the process. */
  static create(): Watcher {
    return new Watcher(sandboxId)
  }

  /** Record the id that read returns, and read the id with it later. */
  static withReader(read: () => string): Watcher {
    return new Watcher(read)
  }

  /** The current sandbox id, and whether it differs from the origin. */
  forked(): { sandboxId: string; forked: boolean } {
    const id = this.read()
    return { sandboxId: id, forked: id !== this.origin }
  }
}

/** In the parent it returns `undefined`. In a fork it claims the dispatch and returns it. */
export async function point(w: Watcher, c: Claimer): Promise<Claim | undefined> {
  const { sandboxId: id, forked } = w.forked()
  if (!forked) return undefined
  try {
    return await c.claimFork(id)
  } catch (error) {
    throw new Error(`fork: claim the dispatch of fork ${id}: ${error instanceof Error ? error.message : String(error)}`, { cause: error })
  }
}

/** Bounds a park. Each field is optional and takes the default. */
export interface ParkOptions {
  timeoutMs?: number
  pollIntervalMs?: number
  /** Ends the park early with an error. */
  signal?: AbortSignal
}

/**
 * Wait until the process is a fork, then claim and return the dispatch. It
 * returns `undefined` when the timeout ends with no fork: the process is the
 * parent, and it can exit with status 0. It rejects when the signal aborts.
 */
export async function park(w: Watcher, c: Claimer, opts: ParkOptions = {}): Promise<Claim | undefined> {
  const timeoutMs = opts.timeoutMs && opts.timeoutMs > 0 ? opts.timeoutMs : DEFAULT_PARK_TIMEOUT_MS
  const pollMs = opts.pollIntervalMs && opts.pollIntervalMs > 0 ? opts.pollIntervalMs : DEFAULT_POLL_INTERVAL_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const claim = await point(w, c)
    if (claim) return claim
    if (opts.signal?.aborted) throw new Error("fork: park: aborted", { cause: opts.signal.reason })
    const left = deadline - Date.now()
    if (left <= 0) return undefined
    await sleep(Math.min(pollMs, left), opts.signal)
  }
}

function sleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      clearTimeout(t)
      reject(new Error("fork: park: aborted", { cause: signal?.reason }))
    }
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, ms)
    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

/** Whether the daemon launched this process as a source that may be forked. */
export function forkable(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[FORKABLE_ENV] === "1"
}

/** The park bound from {@link PARK_TIMEOUT_ENV}, in milliseconds. */
export function parkTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const v = (env[PARK_TIMEOUT_ENV] ?? "").trim()
  if (!v) return DEFAULT_PARK_TIMEOUT_MS
  const ms = parseGoDuration(v)
  if (ms === undefined) throw new Error(`fork: ${PARK_TIMEOUT_ENV}=${JSON.stringify(v)}: not a duration`)
  if (ms <= 0) throw new Error(`fork: ${PARK_TIMEOUT_ENV}=${JSON.stringify(v)}: the timeout must be positive`)
  return ms
}

const UNIT_MS: Record<string, number> = { ns: 1e-6, us: 1e-3, "µs": 1e-3, ms: 1, s: 1e3, m: 60e3, h: 3600e3 }

/** Parse a Go duration such as "10m", "1h30m" or "500ms" into milliseconds. */
function parseGoDuration(v: string): number | undefined {
  let s = v
  let sign = 1
  if (s[0] === "-" || s[0] === "+") {
    if (s[0] === "-") sign = -1
    s = s.slice(1)
  }
  if (s === "0") return 0
  const part = /^(\d+(?:\.\d*)?|\.\d+)(ns|us|µs|ms|s|m|h)/
  let total = 0
  if (!s) return undefined
  while (s) {
    const m = part.exec(s)
    if (!m) return undefined
    total += Number(m[1]) * UNIT_MS[m[2]!]!
    s = s.slice(m[0].length)
  }
  return sign * total
}

/** Whether err is the refusal of a grant outside the sandbox it was given to. */
export function isForkUnclaimed(err: unknown): boolean {
  const ce = ConnectError.from(err)
  if (ce.code !== Code.FailedPrecondition) return false
  for (const d of ce.details) {
    if (!("type" in d) || d.type !== "google.rpc.ErrorInfo") continue
    const info = decodeErrorInfo(d.value)
    if (info.reason === REASON_FORK_UNCLAIMED && info.domain === FORK_ERROR_DOMAIN) return true
  }
  return false
}

/** Read the reason (1) and the domain (2) of a google.rpc.ErrorInfo. */
function decodeErrorInfo(bytes: Uint8Array): { reason: string; domain: string } {
  const out = { reason: "", domain: "" }
  try {
    const r = new BinaryReader(bytes)
    while (r.pos < r.len) {
      const [field, wire] = r.tag()
      if (field === 1 && wire === WireType.LengthDelimited) out.reason = r.string()
      else if (field === 2 && wire === WireType.LengthDelimited) out.domain = r.string()
      else r.skip(wire)
    }
  } catch {
    return { reason: "", domain: "" }
  }
  return out
}
