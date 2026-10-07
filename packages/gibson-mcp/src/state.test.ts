// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { homedir } from "node:os"
import { clearLive, keyFor, stateDir, writeAmbient, writeLive, type LiveState } from "./state.js"

// The read half lives in each host's hooks (zerocool-plugins
// packages/claude-gibson/src/state.ts). These read the files the same way.
const readAmbient = (dir: string, cwd: string) => readFile(join(dir, `ambient-${keyFor(cwd)}.md`), "utf8").catch(() => "")
const readLive = (dir: string, cwd: string) =>
  readFile(join(dir, `live-${keyFor(cwd)}.json`), "utf8").then((s) => JSON.parse(s) as LiveState, () => undefined)

test("the state directory is ~/.zerocool, not a per-host subdirectory", () => {
  assert.equal(stateDir({}), join(homedir(), ".zerocool"))
  assert.equal(stateDir({ ZEROCOOL_STATE_DIR: "/x" }), "/x")
})

test("ambient and live handoffs round-trip per working directory, and a missing file reads as nothing", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gm-state-"))
  assert.equal(await readAmbient(dir, "/w"), "")
  await writeAmbient(dir, "/w", "block")
  assert.equal(await readAmbient(dir, "/w"), "block")
  assert.equal(await readAmbient(dir, "/other"), "")

  assert.equal(await readLive(dir, "/w"), undefined)
  const live = { missionId: "m", workId: "w", endpoint: "d:443", token: "t", insecure: false, writtenAt: 1 }
  await writeLive(dir, "/w", live)
  assert.deepEqual(await readLive(dir, "/w"), live)
  const mode = (await stat(join(dir, `live-${keyFor("/w")}.json`))).mode & 0o777
  assert.equal(mode, 0o600, "the grant file is private to the user")
  await clearLive(dir, "/w")
  assert.equal(await readLive(dir, "/w"), undefined)
})
