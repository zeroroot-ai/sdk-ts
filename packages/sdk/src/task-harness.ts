// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { request } from "node:http"
import { hostname } from "node:os"
import { Code, ConnectError, createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect"
import { createGrpcTransport } from "@connectrpc/connect-node"
import { callbackBaseUrl, type TaskHarnessConfig } from "./callback.js"
import { HarnessCallbackService } from "./clients.js"
import { DaemonService } from "./gen/gibson/daemon/v1/daemon_pb.js"
import type { ContextInfo } from "./gen/gibson/harness/v1/harness_callback_pb.js"

/**
 * The task harness: everything a dispatched run needs to speak to
 * HarnessCallbackService under its task grant (zeroroot-ai/sdk-ts#33).
 *
 * Three things a bare HarnessCallbackService client does not carry:
 *
 *  - **Context.** Every callback RPC resolves the harness from
 *    `ContextInfo{mission_id, agent_name}` (gibson
 *    `internal/engine/harness/callback_service.go:496-516`). A request without
 *    it is refused before authorization runs. The grant already names the
 *    mission and task, so the context is derived from its claims once, here,
 *    and no caller has to know the field exists. The daemon identifies the
 *    calling member of a mission run by `mission_run_id`. The grant does not
 *    carry the run, the launch does (`GIBSON_MISSION_RUN_ID`), so the caller
 *    that read the launch passes it in and the harness sends it on every
 *    request.
 *  - **Renewal.** A task grant lives 30 minutes. `DaemonService.RenewCapabilityGrant`
 *    mints a fresh one for the same subject, mission and task (gibson
 *    `internal/server/daemon/api/server_capabilitygrant_renew.go`). A live
 *    session runs for hours, so the harness renews on its own and the
 *    interceptor always sends the current token.
 *  - **The header.** Off-cluster callers reach the daemon through Envoy, and
 *    ext-authz authenticates a component by the `x-capability-grant` header
 *    with no `Authorization` at all (gibson
 *    `internal/server/extauthz/server/envoy_extauthz.go:135`, ADR-0045). A
 *    `Bearer` token on that route is handed to jwt_authn as if it were a
 *    Zitadel token, which it is not.
 *  - **The sandbox identity.** Each call also carries a new setec identity
 *    token in `x-gibson-sandbox-identity` (zeroroot-ai/sdk#251). The daemon
 *    takes the sandbox of the caller only from it.
 */

/** The claims this SDK reads off a task grant. Addressing only, never trust. */
export interface GrantClaims {
  /** `component:<kind>:<name>` — the dispatched component. */
  sub: string
  tenant: string
  missionId: string
  taskId: string
  /** Expiry, Unix seconds. `0` when the token carries none. */
  exp: number
}

/** The header ext-authz reads a capability-grant JWT from. */
export const CAPABILITY_GRANT_HEADER = "x-capability-grant"

/**
 * Decode the payload of a CG-JWT without verifying it. The daemon verifies; the
 * client only needs the addressing claims to fill `ContextInfo` and to know
 * when to renew.
 */
export function decodeGrantClaims(token: string): GrantClaims {
  const parts = token.split(".")
  if (parts.length !== 3) {
    throw new Error("gibson-sdk: task grant is not a JWT (expected three dot-separated segments)")
  }
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>
  } catch {
    throw new Error("gibson-sdk: task grant payload is not base64url JSON")
  }
  const str = (k: string): string => (typeof payload[k] === "string" ? (payload[k] as string) : "")
  const exp = typeof payload.exp === "number" ? (payload.exp as number) : 0
  return { sub: str("sub"), tenant: str("tenant"), missionId: str("mission_id"), taskId: str("task_id"), exp }
}

/**
 * The `ContextInfo` a task grant implies. `agent_name` is the component name
 * the grant was minted for: the daemon mints `sub = component:<kind>:<name>`
 * (gibson `internal/engine/harness/implementation.go:2636`) and registers the
 * harness under that same name.
 */
export function contextFromGrant(claims: GrantClaims): TaskContext {
  const m = /^component:[^:]+:(.+)$/.exec(claims.sub)
  if (!m) {
    throw new Error(
      `gibson-sdk: task grant subject ${JSON.stringify(claims.sub)} is not component:<kind>:<name>; ` +
        "cannot derive the agent_name every callback RPC needs",
    )
  }
  if (!claims.missionId) {
    throw new Error("gibson-sdk: task grant carries no mission_id; callback RPCs would be refused")
  }
  return { missionId: claims.missionId, taskId: claims.taskId, agentName: m[1] }
}

/**
 * The subset of `ContextInfo` a dispatch fixes. Spread into every request.
 * `missionRunId` is set when the launch named the run, and absent otherwise,
 * so a request from a run that has none carries the proto default.
 */
export type TaskContext = Pick<ContextInfo, "missionId" | "taskId" | "agentName"> & Partial<Pick<ContextInfo, "missionRunId">>

export interface TaskHarness {
  /**
   * The transport the client rides, under the current task grant. Exposed so
   * a caller can create a client for another service on the same callback
   * endpoint and the same grant.
   */
  transport: Transport
  /** HarnessCallbackService under the current task grant. */
  client: Client<typeof HarnessCallbackService>
  /** The callback endpoint this harness dials, as the daemon sent it. */
  endpoint: string
  /** Pass as `context` on every callback request. */
  context: TaskContext
  /** The grant currently in use. Changes after a renewal. */
  token(): string
  /** Expiry of the current grant, Unix milliseconds. `0` when unknown. */
  expiresAt(): number
  /** Stop renewing. The client keeps working until the grant expires. */
  stop(): void
}

export interface OpenTaskHarnessOptions extends TaskHarnessConfig {
  /**
   * The mission run this dispatch belongs to, as the launch named it. The
   * grant does not carry it. When set, every request carries it as
   * `ContextInfo.mission_run_id`.
   */
  missionRunId?: string
  /** Renew the grant before it expires. Default `true`. */
  renew?: boolean
  /** Test seams. */
  clock?: () => number
  timers?: Pick<typeof globalThis, "setTimeout" | "clearTimeout">
  transport?: Transport
  /** Called after each renewal, or with the error when one fails. */
  onRenew?: (result: { token: string; expiresAt: number } | { error: unknown }) => void
}

/** Renew when this fraction of the grant's remaining life has elapsed. */
const RENEW_AT_FRACTION = 0.8
/** Never spin on a grant that is already nearly dead. */
const MIN_RENEW_DELAY_MS = 10_000
/** Node's setTimeout ceiling; a larger delay fires at once. */
const MAX_TIMER_DELAY_MS = 2_147_483_647

/** Interceptor that reads the token on every call, so a renewal takes effect. */
export function grantInterceptor(token: () => string): Interceptor {
  return (next) => async (req) => {
    req.header.set(CAPABILITY_GRANT_HEADER, token())
    return await next(req)
  }
}

/**
 * The metadata key that carries the setec identity token of the caller on each
 * callback (zeroroot-ai/sdk#251). The daemon takes the sandbox of the caller
 * only from this token, so a fork from a snapshot cannot act as its parent.
 */
export const SANDBOX_IDENTITY_HEADER = "x-gibson-sandbox-identity"

/**
 * The metadata key that carries the hostname of the caller. It is a hint, not
 * a proof: the daemon refuses a call whose hostname names another sandbox than
 * the identity token.
 */
export const SANDBOX_ID_HEADER = "x-gibson-sandbox-id"

/** The audience of the identity token that a callback sends. */
export const SANDBOX_IDENTITY_AUDIENCE = "gibson-harness-callback"

/**
 * The environment variable that names the Unix socket of setec that gives the
 * identity tokens of the sandbox. setec sets it in each process of a sandbox.
 */
export const IDENTITY_SOCKET_ENV = "SETEC_IDENTITY_SOCKET"

/** One request for a token ends after this time. */
const IDENTITY_TIMEOUT_MS = 5_000

/** The error of a process with no identity socket: it does not run in a setec sandbox. */
export class NoSandboxIdentityError extends Error {
  constructor() {
    super(`gibson-sdk: this process has no sandbox identity: ${IDENTITY_SOCKET_ENV} is not set`)
    this.name = "NoSandboxIdentityError"
  }
}

/** The path of the setec identity socket, or `""` when the process has none. */
export function identitySocket(env: NodeJS.ProcessEnv = process.env): string {
  return (env[IDENTITY_SOCKET_ENV] ?? "").trim()
}

/**
 * Get a new identity token of the sandbox from the setec identity socket, for
 * {@link SANDBOX_IDENTITY_AUDIENCE}. It reads the environment and asks the
 * socket on each call, and it keeps no copy. So a fork, which gets a new
 * identity generation, never sends the token of its parent. It throws
 * {@link NoSandboxIdentityError} when the process has no socket.
 */
export async function sandboxIdentityToken(env: NodeJS.ProcessEnv = process.env): Promise<string> {
  const socket = identitySocket(env)
  if (!socket) throw new NoSandboxIdentityError()
  const path = `/v1/token?audience=${encodeURIComponent(SANDBOX_IDENTITY_AUDIENCE)}`
  const { status, body } = await new Promise<{ status: number; body: string }>((resolve, reject) => {
    const req = request({ socketPath: socket, path, method: "GET", timeout: IDENTITY_TIMEOUT_MS }, (res) => {
      let data = ""
      res.setEncoding("utf8")
      res.on("data", (chunk: string) => {
        data += chunk
      })
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: data }))
      res.on("error", reject)
    })
    req.on("timeout", () => req.destroy(new Error(`no answer in ${IDENTITY_TIMEOUT_MS} ms`)))
    req.on("error", reject)
    req.end()
  }).catch((error: unknown) => {
    throw new Error(`gibson-sdk: get the sandbox identity token from ${socket}: ${String(error)}`, { cause: error })
  })
  let answer: { token?: unknown; error?: unknown }
  try {
    answer = JSON.parse(body) as { token?: unknown; error?: unknown }
  } catch {
    throw new Error(`gibson-sdk: the identity socket ${socket} answered ${status} with no JSON`)
  }
  if (status !== 200) {
    throw new Error(`gibson-sdk: the identity socket ${socket} refused the token: ${status}: ${String(answer.error ?? "")}`)
  }
  if (typeof answer.token !== "string" || !answer.token) {
    throw new Error(`gibson-sdk: the identity socket ${socket} answered no token`)
  }
  return answer.token
}

/**
 * Interceptor that sends a new identity token and the hostname on each call.
 * A process with no identity socket sends no token, and the daemon decides. A
 * process with a socket that gives no token sends no call: the daemon would
 * refuse it. Install it on each transport that calls HarnessCallbackService.
 */
export function sandboxIdentityInterceptor(env: NodeJS.ProcessEnv = process.env): Interceptor {
  return (next) => async (req) => {
    let token = ""
    try {
      token = await sandboxIdentityToken(env)
    } catch (error) {
      if (!(error instanceof NoSandboxIdentityError)) {
        throw new ConnectError(error instanceof Error ? error.message : String(error), Code.Unauthenticated, undefined, undefined, error)
      }
    }
    if (token) req.header.set(SANDBOX_IDENTITY_HEADER, token)
    const host = hostname().trim()
    if (host) req.header.set(SANDBOX_ID_HEADER, host)
    return await next(req)
  }
}

/** Open the task harness for a dispatched run. */
export function openTaskHarness(opts: OpenTaskHarnessOptions): TaskHarness {
  if (!opts.token) {
    throw new Error(
      "gibson-sdk: callback token is empty — refusing to dial the harness unauthenticated " +
        "(a dispatch without a task grant must fail, not fall back to the component's own)",
    )
  }
  let current = opts.token
  let claims = decodeGrantClaims(current)
  const context: TaskContext = { ...contextFromGrant(claims), ...(opts.missionRunId ? { missionRunId: opts.missionRunId } : {}) }
  const clock = opts.clock ?? (() => Date.now())
  const timers = opts.timers ?? globalThis

  const transport =
    opts.transport ??
    createGrpcTransport({
      baseUrl: callbackBaseUrl(opts.endpoint, opts.insecure),
      interceptors: [grantInterceptor(() => current), sandboxIdentityInterceptor()],
    })
  const client = createClient(HarnessCallbackService, transport)
  const daemon = createClient(DaemonService, transport)

  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false

  const schedule = (): void => {
    if (stopped || opts.renew === false || !claims.exp) return
    const remaining = claims.exp * 1000 - clock()
    // Node clamps a delay above 2^31-1 ms to 1 ms, which would renew in a hot
    // loop; a grant that far out is renewed at the cap instead.
    const delay = Math.min(MAX_TIMER_DELAY_MS, Math.max(MIN_RENEW_DELAY_MS, Math.floor(remaining * RENEW_AT_FRACTION)))
    timer = timers.setTimeout(() => void renew(), delay)
    // A pending renewal must not keep a process alive on its own: the stdio
    // or the sandbox run decides the lifetime, not this timer.
    ;(timer as { unref?: () => void }).unref?.()
  }

  const renew = async (): Promise<void> => {
    if (stopped) return
    try {
      const res = await daemon.renewCapabilityGrant({
        agentId: claims.sub,
        missionId: claims.missionId,
        taskId: claims.taskId,
      })
      if (!res.capabilityGrant) throw new Error("gibson-sdk: RenewCapabilityGrant returned an empty grant")
      current = res.capabilityGrant
      claims = decodeGrantClaims(current)
      if (!claims.exp && res.expiresAtUnix) claims.exp = Number(res.expiresAtUnix)
      opts.onRenew?.({ token: current, expiresAt: claims.exp * 1000 })
    } catch (error) {
      // Keep the old grant and try again on the same cadence: the daemon may
      // be mid-rollout, and the current token is still good until its exp.
      opts.onRenew?.({ error })
    }
    schedule()
  }

  schedule()

  return {
    transport,
    client,
    endpoint: opts.endpoint,
    context,
    token: () => current,
    expiresAt: () => claims.exp * 1000,
    stop: () => {
      stopped = true
      if (timer !== undefined) timers.clearTimeout(timer)
    },
  }
}
