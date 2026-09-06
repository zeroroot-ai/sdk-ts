// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { taskKnowledge } from "./task-knowledge.js"

/**
 * The task-scoped knowledge surface.
 *
 * What is worth defending: these calls carry NO workId and no tenant. The
 * callback service resolves both from the task context the client attaches, so
 * there is nothing here for a caller to widen. A request that started carrying
 * a tenant would be the tenant-isolation hole this design exists to make
 * unrepresentable.
 */

function fakeHarness(capture: Record<string, unknown>) {
  const rec = (name: string, ret: unknown) => async (req: unknown) => {
    capture[name] = req
    return ret
  }
  const client = {
    queryNodes: rec("queryNodes", { results: [{ node: { id: "n1", type: "host", content: "c" }, score: 0.9, distance: 0.1 }] }),
    findSimilarFindings: rec("findSimilarFindings", { results: [{ id: "f1" }] }),
    getRelatedFindings: rec("getRelatedFindings", { results: [{ id: "f2" }] }),
    findSimilarAttacks: rec("findSimilarAttacks", { results: [{ techniqueId: "T1566" }] }),
    getAttackChains: rec("getAttackChains", { results: [{ id: "c1" }] }),
    getMissionRunHistory: rec("getMissionRunHistory", { runs: [{ missionId: "m1", runNumber: 1 }] }),
    applicationFindings: rec("applicationFindings", { findings: [] }),
  }
  return {
    client,
    context: TASK_CONTEXT,
    token: () => "grant",
    expiresAt: () => 0,
    stop: () => {},
  } as never
}

const TASK_CONTEXT = { missionId: "m-1", taskId: "t-1", agentName: "zerocool" }

test("every knowledge read carries the task context the callback service resolves the harness from", async () => {
  // gibson callback_service_knowledge.go: each RPC starts with
  // getHarness(ctx, req.GetContext()), which refuses a missing mission_id.
  const seen: Record<string, unknown> = {}
  const k = taskKnowledge(fakeHarness(seen))
  await k.query({ text: "prior findings" })
  await k.similarFindings("f-1")
  await k.relatedFindings("f-1")
  await k.similarAttacks("phishing")
  await k.attackChains("T1566")
  await k.runHistory()
  for (const [name, req] of Object.entries(seen)) {
    assert.deepEqual((req as { context: unknown }).context, TASK_CONTEXT, `${name} must carry the task context`)
  }
})

test("no knowledge read carries a workId or a tenant", async () => {
  const seen: Record<string, unknown> = {}
  const k = taskKnowledge(fakeHarness(seen))
  await k.query({ text: "prior findings" })
  await k.similarFindings("f-1")
  await k.relatedFindings("f-1")
  await k.similarAttacks("phishing")
  await k.attackChains("T1566")
  await k.runHistory()

  for (const [name, req] of Object.entries(seen)) {
    const r = req as Record<string, unknown>
    assert.equal(r.workId, undefined, `${name} must not send a workId — the task context resolves it`)
    assert.equal(r.tenant, undefined, `${name} must not send a tenant — that is unrepresentable by design`)
    assert.equal(r.tenantId, undefined, `${name} must not send a tenantId`)
  }
})

test("query flattens hits so a caller never decodes proto by hand", async () => {
  const k = taskKnowledge(fakeHarness({}))
  const hits = await k.query({ text: "x" })
  assert.equal(hits.length, 1)
  assert.deepEqual(
    { id: hits[0]!.id, type: hits[0]!.type, score: hits[0]!.score },
    { id: "n1", type: "host", score: 0.9 },
  )
})

test("the four graph reads return typed results, not JSON blobs", async () => {
  // ComponentService answers these with `bytes results_json` whose schema lives
  // in a comment. The callback wire carries real messages, so there is nothing
  // to decode here and no second definition of the same shape to drift.
  const k = taskKnowledge(fakeHarness({}))
  assert.equal((await k.similarFindings("f-1"))[0]?.id, "f1")
  assert.equal((await k.relatedFindings("f-1"))[0]?.id, "f2")
  assert.equal((await k.similarAttacks("p"))[0]?.techniqueId, "T1566")
  assert.equal((await k.attackChains("T1566"))[0]?.id, "c1")
  assert.equal((await k.runHistory())[0]?.missionId, "m1")
})

test("query defaults topK rather than sending an unbounded request", async () => {
  const seen: Record<string, unknown> = {}
  const k = taskKnowledge(fakeHarness(seen))
  await k.query({ text: "x" })
  const q = (seen.queryNodes as { query: { topK: number } }).query
  assert.equal(q.topK, 10)
})

test("componentKnowledge refuses run history rather than reporting none", async () => {
  // ComponentService has the RPC but the SDK has never exposed a client for it.
  // Answering [] would tell an agent this mission has no prior runs, which it
  // cannot distinguish from "this transport cannot tell you" — the same
  // conflation ErrKnowledgeUnavailable exists to prevent on the Go side.
  const { componentKnowledge } = await import("./task-knowledge.js")
  const k = componentKnowledge({} as never)
  await assert.rejects(() => k.runHistory(), /not available over ComponentService/)
})

/**
 * ApplicationFindings — the lifecycle read (gibson#1674, sdk#537, priority
 * fields sdk#540).
 *
 * Three properties are worth defending here, and every one of them fails
 * silently if it regresses: an outage must not read as a clean Application, an
 * unranked Finding must not read as a ranked one, and the read must carry no
 * tenant.
 */

function findingsHarness(
  capture: Record<string, unknown>,
  res: { findings?: unknown[]; error?: { code: number; message: string } },
) {
  const client = {
    applicationFindings: async (req: unknown) => {
      capture.req = req
      return { findings: [], ...res }
    },
  }
  return { client, context: TASK_CONTEXT, token: () => "grant", expiresAt: () => 0, stop: () => {} } as never
}

test("applicationFindings sends the application, statuses and limit, and no tenant", async () => {
  const seen: Record<string, unknown> = {}
  const k = taskKnowledge(findingsHarness(seen, { findings: [] }))
  await k.applicationFindings({ application: "customer-portal", statuses: ["open", "fixing"], limit: 50 })
  const req = seen.req as Record<string, unknown>
  assert.equal(req.application, "customer-portal")
  assert.deepEqual(req.statuses, ["open", "fixing"])
  assert.equal(req.limit, 50)
  assert.deepEqual(req.context, TASK_CONTEXT)
  // The tenant is resolved from the task context. A field for it here would be
  // the isolation hole this surface exists to make unrepresentable.
  assert.equal("tenant" in req, false)
  assert.equal("tenantId" in req, false)
})

test("omitted statuses and limit send the server's own defaults, not a guess", async () => {
  const seen: Record<string, unknown> = {}
  const k = taskKnowledge(findingsHarness(seen, { findings: [] }))
  await k.applicationFindings({ application: "customer-portal" })
  const req = seen.req as Record<string, unknown>
  // Empty statuses means every status and 0 means the server default; the
  // server caps the limit either way. Substituting a client-side page size
  // would silently truncate a backlog the caller asked for in full.
  assert.deepEqual(req.statuses, [])
  assert.equal(req.limit, 0)
})

test("a rejected read throws rather than resolving empty", async () => {
  // The failure this prevents: a caller reads a missing Finding as "nothing
  // deploys this" and ranks it last, so answering an outage with [] reports a
  // clean Application over a live backlog — indistinguishable from health.
  const k = taskKnowledge(findingsHarness({}, { error: { code: 7, message: "graph unavailable" } }))
  await assert.rejects(() => k.applicationFindings({ application: "customer-portal" }), /ApplicationFindings rejected \(7\): graph unavailable/)
})

test("an empty application key is refused before it reaches the wire", async () => {
  const seen: Record<string, unknown> = {}
  const k = taskKnowledge(findingsHarness(seen, { findings: [] }))
  await assert.rejects(() => k.applicationFindings({ application: "" }), /requires an application key/)
  // Not sent: an empty key widens the traversal to the whole tenant graph.
  assert.equal(seen.req, undefined)
})

test("an unranked Finding comes back unranked — no default priority is invented", async () => {
  // Empty means NO PASS HAS DECIDED YET. A substituted value is
  // indistinguishable from a ranking somebody made, so a keep-previous rule
  // would preserve a decision nobody took and that Finding is never triaged.
  const k = taskKnowledge(
    findingsHarness({}, { findings: [{ findingId: "f-1", status: "open", severity: "high", priority: "", priorityRule: "", priorityReason: "" }] }),
  )
  const [f] = await k.applicationFindings({ application: "customer-portal" })
  assert.equal(f?.priority, "")
  assert.equal(f?.priorityRule, "")
  assert.equal(f?.priorityReason, "")
})

test("a ranked but unexplained Finding keeps its ranking", async () => {
  // priority and priorityReason are written by different steps — a rule table
  // decides, a model explains — so a quiet model must not read as a Finding
  // nobody ranked, or an LLM outage silently discards deterministic rankings.
  const k = taskKnowledge(
    findingsHarness({}, { findings: [{ findingId: "f-1", priority: "P1", priorityRule: "R01", priorityReason: "" }] }),
  )
  const [f] = await k.applicationFindings({ application: "customer-portal" })
  assert.equal(f?.priority, "P1")
  assert.equal(f?.priorityRule, "R01")
  assert.equal(f?.priorityReason, "")
})

test("the lifecycle context a triage rule reads survives the mapping", async () => {
  const k = taskKnowledge(
    findingsHarness({}, {
      findings: [
        {
          findingId: "brain-1",
          status: "open",
          severity: "critical",
          vulnerabilityId: "CVE-2026-0001",
          placeLabel: "Package",
          placeKey: "npm:lodash@4.17.20",
          reachable: true,
          exposed: true,
          deploymentKey: "customer-portal/prod",
          imageKey: "sha256:abc",
        },
      ],
    }),
  )
  const [f] = await k.applicationFindings({ application: "customer-portal" })
  // Checked field by field rather than by deep equality: a zero value mapped
  // from the wrong source field passes an equality check, and reachable/exposed
  // are exactly where such a mismap buries a live Finding at the bottom.
  assert.equal(f?.findingId, "brain-1")
  assert.equal(f?.status, "open")
  assert.equal(f?.severity, "critical")
  assert.equal(f?.vulnerabilityId, "CVE-2026-0001")
  assert.equal(f?.placeLabel, "Package")
  assert.equal(f?.placeKey, "npm:lodash@4.17.20")
  assert.equal(f?.reachable, true)
  assert.equal(f?.exposed, true)
  assert.equal(f?.deploymentKey, "customer-portal/prod")
  assert.equal(f?.imageKey, "sha256:abc")
})

test("componentKnowledge refuses application findings rather than reporting none", async () => {
  // ApplicationFindings exists only on HarnessCallbackService. Answering []
  // would tell an agent this Application is clean, which it cannot distinguish
  // from "this transport cannot tell you".
  const { componentKnowledge } = await import("./task-knowledge.js")
  const k = componentKnowledge({} as never)
  await assert.rejects(() => k.applicationFindings({ application: "x" }), /not available over ComponentService/)
})
