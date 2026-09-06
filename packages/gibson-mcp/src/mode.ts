// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * Which posture this process runs in. Pure: decided from what the
 * environment says and whether the host key exists, so it is testable and the
 * reasons are printed once at start instead of discovered per tool call.
 *
 *  - `standalone`: no platform. Findings go to a local log, componentize works.
 *  - `component`: checked in, no live mission. Reads and findings run under the
 *    component grant. No memory writes: a memory is a World observation and
 *    the World is written under a mission (gibson ADR-0012).
 *  - `live`: checked in, and this session is a mission (gibson#1593, decision 9).
 *  - `task`: a dispatched run (gibson ADR-0016). The launch injected the
 *    per-dispatch grant; there is no check-in and no live mission to create,
 *    the mission already exists and this run is one of its nodes. Reads and
 *    writes use that grant.
 *
 * The postures are one path with fewer tools at each step down, the same
 * fail-open shape as the opencode plugin: a coding agent that cannot reach its
 * platform is still a working coding agent.
 */
export type Mode = "standalone" | "component" | "live" | "task"

export interface ModeDecision {
  mode: Mode
  /** One line a person can act on. Empty when nothing is missing. */
  reason: string
}

export interface ModeInputs {
  platformURL?: string
  bootstrapToken?: string
  hostKeyExists: boolean
  targetId?: string
}

export function decideMode(env: ModeInputs, hostKeyPath: string): ModeDecision {
  if (!env.platformURL) {
    return { mode: "standalone", reason: "GIBSON_PLATFORM_URL is not set. Call gibson_login, then gibson_connect." }
  }
  if (!env.hostKeyExists && !env.bootstrapToken) {
    return {
      mode: "standalone",
      reason:
        "GIBSON_PLATFORM_URL is set but this host has not checked in. Call gibson_login then gibson_connect, " +
        "or run `gibson login` and `gibson agent enroll` and start once with GIBSON_BOOTSTRAP_TOKEN=<one-time token>. " +
        `After that the host key at ${hostKeyPath} is enough.`,
    }
  }
  if (!env.targetId) {
    return {
      mode: "component",
      reason:
        "GIBSON_TARGET_ID is not set, so this session cannot be a live mission and cannot " +
        "write memories. Create a target once (`gibson target create`) and set GIBSON_TARGET_ID, or call gibson_connect with create_target.",
    }
  }
  return { mode: "live", reason: "" }
}
