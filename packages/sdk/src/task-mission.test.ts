// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { buildCreateMissionRequest, createTaskMission } from "./task-mission.js"

/**
 * Originating a checked-in catalog mission over the task harness.
 *
 * What is worth defending here is the SHAPE ON THE WIRE. The daemon refuses a
 * request carrying both a graph and a catalog name, so a builder that emits a
 * stray graph turns "you passed a null definition" into "the catalog path does
 * not work" — a false verdict on a working feature. The refusals below exist so
 * the error names the argument to drop instead.
 */

const TASK_CONTEXT = { missionId: "m-1", taskId: "t-1", agentName: "zerocool" }

/** The seven parameters the Scan mission declares (gibson#1688). No host among them. */
const SCAN_PARAMS: Record<string, string> = {
  application: "customer-portal",
  repositoryUrl: "https://gitlab.com/examplebank/customer-portal",
  ref: "refs/heads/main",
  commit: "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c",
  pipelineId: "4711",
  pipelineUrl: "https://gitlab.com/examplebank/customer-portal/-/pipelines/4711",
  imageRef: "registry.gitlab.com/examplebank/customer-portal@sha256:abc",
}

// The response is passed as a whole object, never as a defaulted `mission`
// argument: `fakeHarness(seen, undefined)` would silently take the default and
// the "no mission" test would assert nothing.
function fakeHarness(capture: Record<string, unknown>, res: { mission?: unknown } = { mission: { id: "mission-1" } }) {
  return {
    client: {
      createMission: async (req: unknown) => {
        capture.createMission = req
        return res
      },
    },
    context: TASK_CONTEXT,
    token: () => "grant",
    expiresAt: () => 0,
    stop: () => {},
  } as never
}

test("a named catalog mission puts NO graph on the wire", () => {
  const wire = buildCreateMissionRequest({
    catalogMission: "scan",
    catalogParams: SCAN_PARAMS,
    targetId: "target-7",
  })
  assert.equal(wire.catalogMission, "scan")
  assert.equal(
    wire.missionDefinitionJson.length,
    0,
    `mission_definition_json must be empty when a catalog mission is named, got ${JSON.stringify(
      new TextDecoder().decode(wire.missionDefinitionJson),
    )}`,
  )
})

test("an explicitly null definition is still no graph, because \"null\" is four bytes", () => {
  // MUTATION GUARD, and the only test that catches this. Dropping the `null`
  // half of the normalisation makes this the single failure: `undefined`
  // encodes to zero bytes so it survives a naive builder, but `null` encodes to
  // the four-byte string "null" — a non-empty graph beside the catalog name,
  // which the daemon refuses as InvalidArgument. The bug would read as "the
  // catalog path does not work" rather than "you passed a null definition".
  const wire = buildCreateMissionRequest({
    missionDefinition: null,
    catalogMission: "scan",
    targetId: "target-7",
  })
  assert.equal(
    wire.missionDefinitionJson.length,
    0,
    `mission_definition_json must be empty when a catalog mission is named, got ${JSON.stringify(
      new TextDecoder().decode(wire.missionDefinitionJson),
    )}`,
  )
  assert.equal(wire.catalogMission, "scan")
})

test("all seven scan parameters are carried, each checked by name", () => {
  // By name, never by object equality: a value mapped from the wrong source key
  // still satisfies a deepEqual against a fixture built the same wrong way.
  const wire = buildCreateMissionRequest({
    catalogMission: "scan",
    catalogParams: SCAN_PARAMS,
    targetId: "target-7",
  })
  for (const [key, want] of Object.entries(SCAN_PARAMS)) {
    assert.equal(wire.catalogParams[key], want, `catalog_params.${key}`)
  }
  assert.equal(Object.keys(wire.catalogParams).length, 7)
})

test("no parameter names the runtime target, so it cannot be smuggled past target_id", () => {
  // Fails the day something target-shaped joins the declared set. The daemon
  // refuses unknown keys and `Params` has no target or host field, so target_id
  // stays the only source of the runtime target — that refusal is the whole of
  // the smuggling defence, which is why it is worth a test on this side too.
  for (const key of Object.keys(SCAN_PARAMS)) {
    assert.ok(!/^(host|target|targetId|endpoint|baseUrl)$/i.test(key), `parameter names the runtime target: ${key}`)
  }
})

test("a graph and a catalog mission together are refused, naming the argument to drop", () => {
  assert.throws(
    () =>
      buildCreateMissionRequest({
        missionDefinition: { name: "scan" },
        catalogMission: "scan",
        targetId: "target-7",
      }),
    /not both/,
  )
})

test("neither input is refused rather than originating nothing", () => {
  assert.throws(() => buildCreateMissionRequest({ targetId: "target-7" }), /needs either/)
})

test("params alone do not imply a catalog mission", () => {
  // Inventing a name from the presence of parameters would mask the daemon's
  // "neither input" refusal and originate something the caller never named.
  assert.throws(
    () => buildCreateMissionRequest({ catalogParams: SCAN_PARAMS, targetId: "target-7" }),
    /do not name a mission/,
  )
})

test("the existing graph path is unchanged", () => {
  const definition = { name: "recon", nodes: {} }
  const wire = buildCreateMissionRequest({ missionDefinition: definition, targetId: "target-7", name: "run-1" })
  assert.equal(wire.catalogMission, "")
  assert.deepEqual(wire.catalogParams, {})
  assert.equal(new TextDecoder().decode(wire.missionDefinitionJson), JSON.stringify(definition))
  assert.equal(wire.targetId, "target-7")
  assert.equal(wire.name, "run-1")
})

test("the request carries the task context the callback service resolves the harness from", async () => {
  const seen: Record<string, unknown> = {}
  await createTaskMission(fakeHarness(seen), {
    catalogMission: "scan",
    catalogParams: SCAN_PARAMS,
    targetId: "target-7",
  })
  const req = seen.createMission as { context: unknown; catalogMission: string; targetId: string }
  assert.deepEqual(req.context, TASK_CONTEXT)
  assert.equal(req.catalogMission, "scan")
  assert.equal(req.targetId, "target-7")
})

test("a response with no mission is an error, not an empty mission", async () => {
  // An empty object would let a caller run a mission that does not exist and
  // report success for work that never started.
  await assert.rejects(
    createTaskMission(fakeHarness({}, {}), { catalogMission: "scan", targetId: "target-7" }),
    /returned no mission/,
  )
})
