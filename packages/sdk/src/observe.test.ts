// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"

import { HarnessCallbackService } from "./clients.js"
import { ErrorCode } from "./gen/gibson/common/v1/gibson_common_pb.js"
import type { ObserveRequest } from "./gen/gibson/harness/v1/harness_callback_pb.js"
import { observe, remember } from "./observe.js"
import { openTaskHarness } from "./task-harness.js"

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA" })}.${b64(payload)}.sig`
}
const GRANT = fakeJwt({ sub: "component:agent:zerocool-claude", mission_id: "m-1", task_id: "run-1" })

function harnessWith(handler: (req: ObserveRequest) => { error?: { code: ErrorCode; message: string } }) {
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, { observe: async (req) => handler(req) })
  })
  return openTaskHarness({ endpoint: "d:443", token: GRANT, transport, renew: false })
}

test("remember emits a memory observation under the task context", async () => {
  const seen: ObserveRequest[] = []
  const h = harnessWith((req) => {
    seen.push(req)
    return {}
  })
  await remember(h, { text: "Traffic goes through Envoy and ext-authz.", kind: "convention", tags: ["dashboard"], sourceRef: "CLAUDE.md" })
  assert.equal(seen.length, 1)
  const req = seen[0]!
  assert.deepEqual(
    { missionId: req.context?.missionId, taskId: req.context?.taskId, agentName: req.context?.agentName },
    { missionId: "m-1", taskId: "run-1", agentName: "zerocool-claude" },
  )
  assert.equal(req.observation.case, "memory")
  const m = req.observation.case === "memory" ? req.observation.value : undefined
  assert.equal(m?.text, "Traffic goes through Envoy and ext-authz.")
  assert.equal(m?.kind, "convention")
  assert.deepEqual(m?.tags, ["dashboard"])
  assert.equal(m?.sourceRef, "CLAUDE.md")
})

test("an observation carries no scope and no tenant — there is no field for them", async () => {
  const seen: ObserveRequest[] = []
  const h = harnessWith((req) => {
    seen.push(req)
    return {}
  })
  await observe(h, { host: { address: "10.0.0.5" } })
  const raw = seen[0] as unknown as Record<string, unknown>
  assert.equal(raw.scope, undefined)
  assert.equal(raw.tenant, undefined)
  assert.equal(seen[0]!.observation.case, "host")
})

test("a daemon refusal surfaces as an error, not a silent no-op", async () => {
  const h = harnessWith(() => ({ error: { code: ErrorCode.RESOURCE_EXHAUSTED, message: "emit bounds" } }))
  await assert.rejects(remember(h, { text: "x" }), /Observe rejected .*emit bounds/)
})

test("observe refuses an ambiguous or empty observation and remember refuses empty text", async () => {
  const h = harnessWith(() => ({}))
  await assert.rejects(observe(h, {} as never), /exactly one shape/)
  await assert.rejects(observe(h, { host: { address: "a" }, memory: { text: "b" } } as never), /exactly one shape/)
  await assert.rejects(remember(h, { text: "   " }), /needs text/)
})

/**
 * The lifecycle entity observation (gibson#1656 taxonomy, gibson#1683 ingest).
 *
 * The property that matters: an edge names its target by LABEL and IDENTITY.
 * An emitter does not know node ids and must not be able to guess them, so
 * there is no field here for one.
 */

test("a lifecycle entity travels with its identity, properties and edges", async () => {
  const seen: ObserveRequest[] = []
  const h = harnessWith((req) => {
    seen.push(req)
    return {}
  })
  await observe(h, {
    lifecycleEntity: {
      label: "Finding",
      idProperties: { brain_id: "brain-1" },
      properties: { priority: "P1", priority_rule: "R01" },
      edges: [{ type: "TOUCHES", targetLabel: "Control", targetIdProperties: { key: "PCI-DSS-4.0/6.3.3" } }],
    },
  })
  assert.equal(seen.length, 1)
  const req = seen[0]!
  assert.equal(req.observation.case, "lifecycleEntity")
  const e = req.observation.case === "lifecycleEntity" ? req.observation.value : undefined
  assert.equal(e?.label, "Finding")
  // Named by brain_id, so the write lands on the Finding a scan already raised
  // rather than creating a second node beside it.
  assert.deepEqual(e?.idProperties, { brain_id: "brain-1" })
  assert.deepEqual(e?.properties, { priority: "P1", priority_rule: "R01" })
  assert.equal(e?.edges.length, 1)
  assert.equal(e?.edges[0]?.type, "TOUCHES")
  assert.equal(e?.edges[0]?.targetLabel, "Control")
  assert.deepEqual(e?.edges[0]?.targetIdProperties, { key: "PCI-DSS-4.0/6.3.3" })
})

test("an edge carries no node id — there is no field for one", async () => {
  const seen: ObserveRequest[] = []
  const h = harnessWith((req) => {
    seen.push(req)
    return {}
  })
  await observe(h, {
    lifecycleEntity: {
      label: "Package",
      idProperties: { key: "npm:lodash@4.17.20" },
      edges: [{ type: "CONTAINS", targetLabel: "Image", targetIdProperties: { key: "sha256:abc" } }],
    },
  })
  const req = seen[0]!
  const edge = req.observation.case === "lifecycleEntity" ? req.observation.value.edges[0] : undefined
  const fields = Object.keys(edge ?? {}).filter((k) => !k.startsWith("$"))
  assert.deepEqual(fields.sort(), ["targetIdProperties", "targetLabel", "type"])
})

test("an entity with no identity property is refused before it reaches the wire", async () => {
  // The daemon records nothing for it — there would be no stable node to
  // project — so sending it is a write that reports success and changes
  // nothing. Refused here so that cannot be reached by accident.
  const seen: ObserveRequest[] = []
  const h = harnessWith((req) => {
    seen.push(req)
    return {}
  })
  await assert.rejects(
    () => observe(h, { lifecycleEntity: { label: "Finding", idProperties: {} } }),
    /at least one identity property/,
  )
  assert.equal(seen.length, 0)
})

test("an entity with no label is refused before it reaches the wire", async () => {
  const seen: ObserveRequest[] = []
  const h = harnessWith((req) => {
    seen.push(req)
    return {}
  })
  await assert.rejects(
    () => observe(h, { lifecycleEntity: { label: "", idProperties: { brain_id: "b" } } }),
    /carries a Taxonomy label/,
  )
  assert.equal(seen.length, 0)
})

test("a rejected lifecycle write throws rather than resolving quietly", async () => {
  const h = harnessWith(() => ({ error: { code: ErrorCode.INTERNAL, message: "taxonomy gate refused it" } }))
  await assert.rejects(
    () =>
      observe(h, { lifecycleEntity: { label: "Finding", idProperties: { brain_id: "b" }, properties: { priority: "P1" } } }),
    /Observe rejected/,
  )
})
