// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { MissionStatus } from "./gen/gibson/daemon/v1/daemon_pb.js"

/**
 * The state names of a mission. They follow the A2A task states, in the short
 * form that the status JSON of a mission uses (`getMissionStatus`,
 * `waitMission`). The names are the same as in the Go SDK (`mission` package).
 *
 *  - `submitted`: the mission is queued and does not work yet.
 *  - `working`: the mission runs.
 *  - `input_required`: the mission waits for input. It is not a terminal state.
 *  - `completed`: the mission ended with success. It is a terminal state.
 *  - `failed`: the mission ended with an error. It is a terminal state.
 *  - `canceled`: a user or an agent canceled the mission. It is a terminal state.
 *  - `paused`: the mission is suspended for now.
 *
 * The old names `pending`, `running` and `cancelled` are gone.
 */
export const MissionState = {
  Submitted: "submitted",
  Working: "working",
  InputRequired: "input_required",
  Completed: "completed",
  Failed: "failed",
  Canceled: "canceled",
  Paused: "paused",
} as const

/** The name of a mission state. */
export type MissionStateName = (typeof MissionState)[keyof typeof MissionState]

const TERMINAL: ReadonlySet<string> = new Set([MissionState.Completed, MissionState.Failed, MissionState.Canceled])

/** Whether the value is the name of a mission state. */
export function isMissionState(value: unknown): value is MissionStateName {
  return typeof value === "string" && Object.values<string>(MissionState).includes(value)
}

/** Whether the mission has ended. A mission in a terminal state does not change again. */
export function isTerminalMissionState(state: MissionStateName): boolean {
  return TERMINAL.has(state)
}

const FROM_STATUS: ReadonlyMap<MissionStatus, MissionStateName> = new Map([
  [MissionStatus.SUBMITTED, MissionState.Submitted],
  [MissionStatus.WORKING, MissionState.Working],
  [MissionStatus.INPUT_REQUIRED, MissionState.InputRequired],
  [MissionStatus.COMPLETED, MissionState.Completed],
  [MissionStatus.FAILED, MissionState.Failed],
  [MissionStatus.CANCELED, MissionState.Canceled],
  [MissionStatus.PAUSED, MissionState.Paused],
])

/**
 * Return the state name for the `MissionStatus` enum of the daemon protos. It
 * returns `undefined` for `MISSION_STATUS_UNSPECIFIED` and for a value that
 * this SDK does not know.
 */
export function missionStateOfStatus(status: MissionStatus): MissionStateName | undefined {
  return FROM_STATUS.get(status)
}
