// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { createClient, type Client, type Interceptor, type Transport } from "@connectrpc/connect"
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
 *    and no caller has to know the field exists.
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

/** The subset of `ContextInfo` a task grant fixes. Spread into every request. */
export type TaskContext = Pick<ContextInfo, "missionId" | "taskId" | "agentName">

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
  const context = contextFromGrant(claims)
  const clock = opts.clock ?? (() => Date.now())
  const timers = opts.timers ?? globalThis

  const transport =
    opts.transport ??
    createGrpcTransport({
      baseUrl: callbackBaseUrl(opts.endpoint, opts.insecure),
      interceptors: [grantInterceptor(() => current)],
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
