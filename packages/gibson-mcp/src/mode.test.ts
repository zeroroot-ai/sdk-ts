// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { decideMode } from "./mode.js"

const KEY = "/home/u/.zerocool/host.key"

test("no platform URL is standalone, and names the way in", () => {
  const d = decideMode({ hostKeyExists: true, targetId: "t" }, KEY)
  assert.equal(d.mode, "standalone")
  assert.match(d.reason, /gibson_login/)
})

test("a platform URL with neither host key nor bootstrap token is standalone, with the enrollment hint", () => {
  const d = decideMode({ platformURL: "https://p", hostKeyExists: false }, KEY)
  assert.equal(d.mode, "standalone")
  assert.match(d.reason, /gibson agent enroll/)
  assert.match(d.reason, new RegExp(KEY))
})

test("checked in without a target is the component posture", () => {
  const d = decideMode({ platformURL: "https://p", hostKeyExists: true }, KEY)
  assert.equal(d.mode, "component")
  assert.match(d.reason, /GIBSON_TARGET_ID/)
})

test("a first start with a bootstrap token and a target is live", () => {
  const d = decideMode({ platformURL: "https://p", hostKeyExists: false, bootstrapToken: "one-time", targetId: "tgt" }, KEY)
  assert.equal(d.mode, "live")
  assert.equal(d.reason, "")
})
