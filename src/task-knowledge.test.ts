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
  return {
    queryNodes: rec("queryNodes", { results: [{ node: { id: "n1", type: "host", content: "c" }, score: 0.9, distance: 0.1 }] }),
    findSimilarFindings: rec("findSimilarFindings", { results: [{ id: "f1" }] }),
    getRelatedFindings: rec("getRelatedFindings", { results: [{ id: "f2" }] }),
    findSimilarAttacks: rec("findSimilarAttacks", { results: [{ techniqueId: "T1566" }] }),
    getAttackChains: rec("getAttackChains", { results: [{ id: "c1" }] }),
    getMissionRunHistory: rec("getMissionRunHistory", { runs: [{ missionId: "m1", runNumber: 1 }] }),
  } as never
}

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
