// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { MissionStatus } from "./gen/gibson/daemon/v1/daemon_pb.js"
import { MissionState, missionStateOfStatus, isMissionState, isTerminalMissionState } from "./mission-state.js"

test("the mission state names are the seven names of the contract", () => {
  assert.deepEqual(Object.values(MissionState).sort(), [
    "canceled",
    "completed",
    "failed",
    "input_required",
    "paused",
    "submitted",
    "working",
  ])
})

test("the old state names are not mission states", () => {
  for (const old of ["pending", "running", "cancelled", "success", "partial", "timeout"]) {
    assert.equal(isMissionState(old), false, old)
  }
  assert.equal(isMissionState(undefined), false)
})

test("only completed, failed and canceled are terminal", () => {
  const terminal = Object.values(MissionState).filter((s) => isTerminalMissionState(s))
  assert.deepEqual(terminal.sort(), ["canceled", "completed", "failed"])
})

test("the enum numbers of the protos are the ones of the contract, and each maps to its name", () => {
  assert.equal(MissionStatus.INPUT_REQUIRED, 7)
  assert.equal(MissionStatus.SUBMITTED, 8)
  assert.equal(MissionStatus.WORKING, 9)
  assert.equal(MissionStatus.CANCELED, 10)
  assert.equal(missionStateOfStatus(MissionStatus.SUBMITTED), "submitted")
  assert.equal(missionStateOfStatus(MissionStatus.WORKING), "working")
  assert.equal(missionStateOfStatus(MissionStatus.INPUT_REQUIRED), "input_required")
  assert.equal(missionStateOfStatus(MissionStatus.COMPLETED), "completed")
  assert.equal(missionStateOfStatus(MissionStatus.FAILED), "failed")
  assert.equal(missionStateOfStatus(MissionStatus.CANCELED), "canceled")
  assert.equal(missionStateOfStatus(MissionStatus.PAUSED), "paused")
  assert.equal(missionStateOfStatus(MissionStatus.UNSPECIFIED), undefined)
})
