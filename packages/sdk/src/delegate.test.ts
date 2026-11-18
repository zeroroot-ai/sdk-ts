// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createMission,
  runMission,
  waitMission,
} from "./delegate.js"

/** Tests for the mission calls. Delegation has its own tests in agent-gateway.test.ts. */

test("createMission encodes the definition and opts as JSON bytes", async () => {
  let captured: { missionDefinitionJson: Uint8Array; targetId: string; optsJson?: Uint8Array } | undefined
  const component = {
    createMission: async (req: {
      missionDefinitionJson: Uint8Array
      targetId: string
      optsJson?: Uint8Array
    }) => {
      captured = req
      return { missionJson: new TextEncoder().encode(JSON.stringify({ id: "mission-1" })) }
    },
  }

  const info = await createMission(component as never, { name: "recon" }, "target-7", { dryRun: true })

  assert.equal(info.id, "mission-1")
  assert.equal(captured?.targetId, "target-7")
  assert.deepEqual(JSON.parse(new TextDecoder().decode(captured!.missionDefinitionJson)), { name: "recon" })
  assert.deepEqual(JSON.parse(new TextDecoder().decode(captured!.optsJson!)), { dryRun: true })
})

test("createMission omits optsJson entirely when no opts are given", async () => {
  let captured: Record<string, unknown> | undefined
  const component = {
    createMission: async (req: Record<string, unknown>) => {
      captured = req
      return { missionJson: new Uint8Array() }
    },
  }
  await createMission(component as never, { name: "recon" }, "target-7")
  assert.ok(!("optsJson" in captured!), "an absent opts must not become an empty JSON object")
})

test("runMission passes the mission id through", async () => {
  let captured: { missionId: string } | undefined
  const component = {
    runMission: async (req: { missionId: string }) => {
      captured = req
      return {}
    },
  }
  await runMission(component as never, "mission-1")
  assert.equal(captured?.missionId, "mission-1")
})

test("waitMission converts the timeout to the proto's int64", async () => {
  let captured: { timeoutMs: bigint } | undefined
  const component = {
    waitMission: async (req: { missionId: string; timeoutMs: bigint }) => {
      captured = req
      return { resultJson: new TextEncoder().encode(JSON.stringify({ Status: "success" })) }
    },
  }
  const result = await waitMission(component as never, "mission-1", 60_000)
  assert.equal(captured?.timeoutMs, 60_000n)
  assert.equal(result.Status, "success")
})
