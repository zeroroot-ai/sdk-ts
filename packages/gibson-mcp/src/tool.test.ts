// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { z } from "zod"
import { defineTool, jsonSchemaOf } from "./tool.js"
import { text } from "./tools/result.js"

test("the JSON schema carries the field descriptions and the required set", () => {
  const s = jsonSchemaOf({
    query: z.string().describe("What to look for."),
    limit: z.number().int().optional().describe("Maximum hits."),
  })
  assert.equal(s.type, "object")
  assert.deepEqual(s.required, ["query"])
  const props = s.properties as Record<string, { description?: string; type?: string }>
  assert.equal(props.query?.description, "What to look for.")
  assert.equal(props.limit?.type, "integer")
  assert.equal(s.$schema, undefined, "MCP hosts reject a $schema key on a tool input schema")
})

test("bad arguments are a tool error naming the field, not a thrown fault", async () => {
  const t = defineTool({
    name: "t",
    description: "d",
    input: { query: z.string() },
    handler: async (args) => text("", args.query),
  })
  const bad = await t.handler({ query: 7 }, {})
  assert.equal(bad.isError, true)
  assert.match((bad.content as { text: string }[])[0]!.text, /query/)
  const good = await t.handler({ query: "hi" }, {})
  assert.equal((good.content as { text: string }[])[0]!.text, "hi")
})
