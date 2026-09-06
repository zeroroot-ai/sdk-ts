// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { AsyncLocalStorage } from "node:async_hooks"
import { createGrpcTransport } from "@connectrpc/connect-node"
import type { Transport } from "@connectrpc/connect"
import { callbackBaseUrl, grantInterceptor, type TaskHarness } from "@zeroroot-ai/sdk"
import { TAG, type Log } from "./log.js"

/**
 * Per-turn grants (gibson#1706, decision 14).
 *
 * A member sandbox is long-lived: one Claude Code process serves many
 * dispatches over its life, and each input message carries the task grant of
 * its own dispatch. Every tool call made while working that message must run
 * under that grant, not under the grant the sandbox started with. A stdio
 * server the host spawns cannot do this, which is why the sandbox runs the
 * HTTP transport.
 *
 * Two credentials, and they never mix:
 *
 *  - the **base grant**, from the launch. It is the member's own identity
 *    and it is used for the lifetime RPCs only: the inbox subscription,
 *    reading repository credentials, and the checkpoint writes.
 *  - the **turn grant**, set by the driver before it feeds Claude a message.
 *    Every tool call in that turn uses it.
 *
 * The turn is set two ways. `POST /turn` sets it for everything that
 * follows, which is what the driver does between turns. A single request may
 * also carry `x-gibson-turn-grant`, which applies to that request alone;
 * that is how a driver runs two turns at once without one turn's grant
 * leaking into the other. The per-request header wins.
 *
 * Between turns there is no turn grant, and a tool call falls back to the
 * base grant. That is deliberate: the alternative is holding the last turn's
 * grant after its dispatch is over, which would attribute work to a job that
 * has already been answered.
 */
export const TURN_GRANT_HEADER = "x-gibson-turn-grant"

export interface Turn {
  jobId: string
  grant: string
  /** The callback endpoint this turn's grant is good for. */
  endpoint: string
  /** Dial the endpoint without TLS. Local daemons only. */
  insecure: boolean
}

export interface TurnControllerOptions {
  /** The harness the launch opened. Its grant and endpoint are the base. */
  base: TaskHarness
  insecure?: boolean
  log?: Log
  /** Test seam: build a transport for an endpoint and a grant source. */
  makeTransport?: (baseUrl: string, token: () => string) => Transport
}

export interface TurnController {
  /** The turn in force right now, if any. */
  current(): Turn | undefined
  /** Set the turn every later call runs under, until it is cleared. */
  set(turn: Turn): void
  /** Drop the turn. Later calls fall back to the base grant. */
  clear(): void
  /** Run `fn` under one grant, for this request only. */
  withGrant<T>(grant: string | undefined, fn: () => T): T
  /** The grant a call made right here would carry. */
  activeGrant(): string
  /**
   * The transport for tool calls. One object for the life of the process:
   * the clients are built once, and the swap happens inside.
   */
  transport(): Transport
  /** The base transport, for the lifetime RPCs. Never swapped. */
  lifetimeTransport(): Transport
  close(): void
}

/**
 * A transport that resolves its target at call time, so a client built once
 * keeps working across a grant swap and an endpoint change.
 */
export function dynamicTransport(pick: () => Transport): Transport {
  return {
    unary: (method, signal, timeoutMs, header, input, contextValues) => pick().unary(method, signal, timeoutMs, header, input, contextValues),
    stream: (method, signal, timeoutMs, header, input, contextValues) => pick().stream(method, signal, timeoutMs, header, input, contextValues),
  }
}

export function createTurnController(opts: TurnControllerOptions): TurnController {
  const { base } = opts
  const insecure = opts.insecure ?? false
  const perRequest = new AsyncLocalStorage<string>()
  const make = opts.makeTransport ?? ((baseUrl, token) => createGrpcTransport({ baseUrl, interceptors: [grantInterceptor(token)] }))
  let turn: Turn | undefined
  // One transport per endpoint. A turn usually reuses the member's own
  // callback endpoint, so this is one entry in practice; a driver that
  // points a turn somewhere else gets a second rather than a rebuild per
  // turn.
  const byEndpoint = new Map<string, Transport>()

  const activeGrant = (): string => perRequest.getStore() ?? turn?.grant ?? base.token()

  const transportFor = (endpoint: string, endpointInsecure: boolean): Transport => {
    const baseUrl = callbackBaseUrl(endpoint, endpointInsecure)
    const existing = byEndpoint.get(baseUrl)
    if (existing) return existing
    const built = make(baseUrl, activeGrant)
    byEndpoint.set(baseUrl, built)
    return built
  }

  const pick = (): Transport => {
    const t = turn
    // The base harness already carries the base grant, so between turns the
    // call goes over the transport the launch opened.
    if (!t && !perRequest.getStore()) return base.transport
    return transportFor(t?.endpoint || base.endpoint, t ? t.insecure : insecure)
  }

  const tools = dynamicTransport(pick)

  return {
    current: () => turn,
    set: (next) => {
      turn = next
      opts.log?.(`${TAG} turn ${next.jobId}: tool calls now run under that dispatch's grant`)
    },
    clear: () => {
      if (turn) opts.log?.(`${TAG} turn ${turn.jobId} ended; tool calls fall back to the base grant`)
      turn = undefined
    },
    withGrant: (grant, fn) => (grant ? perRequest.run(grant, fn) : fn()),
    activeGrant,
    transport: () => tools,
    lifetimeTransport: () => base.transport,
    close: () => {
      turn = undefined
      byEndpoint.clear()
    },
  }
}
