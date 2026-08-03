import { test } from "node:test"
import assert from "node:assert/strict"
import {
  decodeValue,
  findSimilarFindings,
  formatKnowledgeForPrompt,
  queryKnowledge,
  type KnowledgeHit,
} from "./knowledge.js"

/** Build a `gibson.graphrag.v1.Value` oneof as connect-es materialises it. */
const val = (kind: string, value: unknown) => ({ kind: { case: kind, value } }) as never

test("queryKnowledge maps GraphQuery options onto the proto field names", async () => {
  let captured: { workId: string; query: Record<string, unknown> } | undefined
  const component = {
    queryNodes: async (req: { workId: string; query: Record<string, unknown> }) => {
      captured = req
      return { results: [] }
    },
  }

  await queryKnowledge(component as never, {
    text: "prior auth findings",
    topK: 3,
    nodeTypes: ["finding"],
    minScore: 0.5,
  })

  // The proto field is `text`/`top_k`, not `query`/`limit`.
  assert.equal(captured?.query.text, "prior auth findings")
  assert.equal(captured?.query.topK, 3)
  assert.deepEqual(captured?.query.nodeTypes, ["finding"])
  assert.equal(captured?.query.minScore, 0.5)
})

test("minScore and filters are omitted when unset", async () => {
  let captured: { query: Record<string, unknown> } | undefined
  const component = {
    queryNodes: async (req: { query: Record<string, unknown> }) => {
      captured = req
      return { results: [] }
    },
  }
  await queryKnowledge(component as never, { text: "x" })
  assert.ok(!("minScore" in captured!.query))
  assert.ok(!("filters" in captured!.query))
  assert.equal(captured?.query.topK, 10, "topK defaults to 10")
})

test("queryKnowledge flattens QueryResult and its nested GraphNode", async () => {
  const component = {
    queryNodes: async () => ({
      results: [
        {
          score: 0.91,
          distance: 2,
          node: {
            id: "finding-1",
            type: "finding",
            content: "SQL injection in /login",
            properties: {
              title: val("stringValue", "SQLi in /login"),
              severity: val("stringValue", "high"),
              confirmed: val("boolValue", true),
              hits: val("intValue", 7n),
            },
          },
        },
      ],
    }),
  }

  const hits = await queryKnowledge(component as never, { text: "sqli" })

  assert.equal(hits.length, 1)
  assert.equal(hits[0].id, "finding-1")
  assert.equal(hits[0].type, "finding")
  assert.equal(hits[0].score, 0.91)
  assert.equal(hits[0].distance, 2)
  assert.equal(hits[0].content, "SQL injection in /login")
  assert.equal(hits[0].properties.title, "SQLi in /login")
  assert.equal(hits[0].properties.confirmed, true)
  assert.equal(hits[0].properties.hits, 7, "int64 widens from bigint to number")
})

test("a result with no node degrades to empty strings rather than throwing", async () => {
  const component = { queryNodes: async () => ({ results: [{ score: 0.1, distance: 0 }] }) }
  const hits = await queryKnowledge(component as never, { text: "x" })
  assert.equal(hits[0].id, "")
  assert.deepEqual(hits[0].properties, {})
})

test("decodeValue handles every arm of the Value union", () => {
  assert.equal(decodeValue(val("stringValue", "s")), "s")
  assert.equal(decodeValue(val("boolValue", false)), false)
  assert.equal(decodeValue(val("doubleValue", 1.5)), 1.5)
  assert.equal(decodeValue(val("intValue", 42n)), 42)
  assert.equal(decodeValue(val("timestampValue", 1000n)), 1000)
  assert.equal(decodeValue(val("bytesValue", new TextEncoder().encode("raw"))), "raw")
  assert.deepEqual(
    decodeValue(val("listValue", { values: [val("stringValue", "a"), val("intValue", 2n)] })),
    ["a", 2],
  )
  assert.deepEqual(
    decodeValue(val("mapValue", { fields: { k: val("stringValue", "v") } })),
    { k: "v" },
  )
  assert.equal(decodeValue(undefined), undefined)
})

test("decoded properties survive JSON serialisation", () => {
  // A raw bigint would make JSON.stringify throw, which would break every
  // caller that puts recalled context into a prompt.
  const decoded = decodeValue(val("intValue", 9007199254740n))
  assert.doesNotThrow(() => JSON.stringify({ decoded }))
})

test("findSimilarFindings decodes the JSON bytes payload", async () => {
  const component = {
    findSimilarFindings: async () => ({
      resultsJson: new TextEncoder().encode(JSON.stringify([{ id: "f1" }, { id: "f2" }])),
    }),
  }
  const results = await findSimilarFindings(component as never, "f0", 2)
  assert.equal(results.length, 2)
  assert.equal(results[0].id, "f1")
})

test("an empty JSON payload decodes to an empty list, not undefined", async () => {
  const component = { findSimilarFindings: async () => ({ resultsJson: new Uint8Array() }) }
  assert.deepEqual(await findSimilarFindings(component as never, "f0"), [])
})

test("formatKnowledgeForPrompt renders a compact context block", () => {
  const hits: KnowledgeHit[] = [
    {
      id: "f1",
      type: "finding",
      score: 1,
      content: "",
      distance: 0,
      properties: { title: "SQLi in /login", description: "unescaped id parameter" },
    },
    { id: "h1", type: "host", score: 1, content: "10.0.0.1", distance: 1, properties: {} },
  ]
  const block = formatKnowledgeForPrompt(hits)
  assert.match(block, /Prior knowledge/)
  assert.match(block, /\[finding\] SQLi in \/login — unescaped id parameter/)
  assert.match(block, /\[host\] h1 — 10\.0\.0\.1/)
})

test("formatKnowledgeForPrompt returns empty for no hits so nothing is injected", () => {
  assert.equal(formatKnowledgeForPrompt([]), "")
})
