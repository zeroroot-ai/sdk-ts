// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

/**
 * Missions (zerocool-plugins#10).
 *
 * Delegation to another agent is not here. It is `delegate` on the harness
 * and `delegateToResolvedAgent`: an A2A message through the Agent gateway
 * (gibson#1366).
 *
 * DAEMON STATE: the `missionMgr` seam is declared but never wired on some
 * daemons, so an RPC in this module can answer `Unimplemented` — gibson#1186.
 */

// ---------------------------------------------------------------------------
// Missions
// ---------------------------------------------------------------------------

/** Mission info as returned by CreateMission. JSON-encoded `mission.MissionInfo`. */
export interface MissionInfo {
  [key: string]: unknown
}

/** Create a mission from a definition, bound to a target. */
export async function createMission(
  component: Client<typeof ComponentService>,
  missionDefinition: unknown,
  targetId: string,
  opts?: Record<string, unknown>,
  workId = "",
): Promise<MissionInfo> {
  const res = await component.createMission({
    workId,
    missionDefinitionJson: encodeJSON(missionDefinition),
    targetId,
    ...(opts ? { optsJson: encodeJSON(opts) } : {}),
  })
  return decodeJSON<MissionInfo>(res.missionJson) ?? {}
}

/** Queue a mission for execution. Returns as soon as the mission is queued. */
export async function runMission(
  component: Client<typeof ComponentService>,
  missionId: string,
  opts?: Record<string, unknown>,
  workId = "",
): Promise<void> {
  await component.runMission({
    workId,
    missionId,
    ...(opts ? { optsJson: encodeJSON(opts) } : {}),
  })
}

/** Current status of a mission. JSON-encoded `mission.MissionStatusInfo`. */
export async function getMissionStatus(
  component: Client<typeof ComponentService>,
  missionId: string,
  workId = "",
): Promise<Record<string, unknown>> {
  const res = await component.getMissionStatus({ workId, missionId })
  return decodeJSON<Record<string, unknown>>(res.statusJson) ?? {}
}

/**
 * Block until a mission reaches a terminal state or the timeout expires.
 *
 * The daemon holds the RPC open for the duration, so pick a timeout the transport
 * can survive rather than an arbitrarily large one.
 */
export async function waitMission(
  component: Client<typeof ComponentService>,
  missionId: string,
  timeoutMs = 300_000,
  workId = "",
): Promise<Record<string, unknown>> {
  const res = await component.waitMission({ workId, missionId, timeoutMs: BigInt(timeoutMs) })
  return decodeJSON<Record<string, unknown>>(res.resultJson) ?? {}
}

/** Final results of a completed mission. */
export async function getMissionResults(
  component: Client<typeof ComponentService>,
  missionId: string,
  workId = "",
): Promise<Record<string, unknown>> {
  const res = await component.getMissionResults({ workId, missionId })
  return decodeJSON<Record<string, unknown>>(res.resultJson) ?? {}
}

/** Request cancellation of a running mission. */
export async function cancelMission(
  component: Client<typeof ComponentService>,
  missionId: string,
  workId = "",
): Promise<void> {
  await component.cancelMission({ workId, missionId })
}

/** List missions matching a JSON filter. */
export async function listMissions(
  component: Client<typeof ComponentService>,
  filter: Record<string, unknown> = {},
  workId = "",
): Promise<unknown[]> {
  const res = await component.listMissions({ workId, filterJson: encodeJSON(filter) })
  return decodeJSON<unknown[]>(res.missionsJson) ?? []
}

function encodeJSON(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function decodeJSON<T>(bytes: Uint8Array | undefined): T | undefined {
  if (!bytes || bytes.length === 0) return undefined
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
