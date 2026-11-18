// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { MissionState, isMissionState, isTerminalMissionState } from "./mission-state.js"

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
