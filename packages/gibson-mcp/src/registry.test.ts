// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { ToolRegistry } from "./registry.js"
import { text } from "./tools/result.js"

const def = (name: string) => ({ name, description: `the ${name} tool`, inputSchema: { type: "object" as const }, handler: async () => text("", name) })

test("a listing is sorted, and a duplicate or an unnamed tool is refused", () => {
  const r = new ToolRegistry()
  r.register(def("b_tool"))
  r.register(def("a_tool"))
  assert.deepEqual(r.list().map((t) => t.name), ["a_tool", "b_tool"])
  assert.throws(() => r.register(def("a_tool")), /already registered/)
  assert.throws(() => r.register({ ...def("bad name"), name: "bad name" }), /A-Za-z0-9_-/)
  assert.throws(() => r.register({ ...def("x"), description: " " }), /no description/)
})

test("every change notifies, and a batch coalesces into one notification", () => {
  const r = new ToolRegistry()
  let n = 0
  r.onChange(() => (n += 1))
  r.register(def("a"))
  assert.equal(n, 1)
  r.batch(() => {
    r.register(def("b"))
    r.register(def("c"))
    r.remove("a")
  })
  assert.equal(n, 2, "three changes in one batch is one notification")
  r.batch(() => {})
  assert.equal(n, 2, "a batch that changes nothing notifies nothing")
})

test("a group drops exactly what it registered", () => {
  const r = new ToolRegistry()
  r.register(def("keep"))
  const g = r.group()
  g.register(def("posture_one"))
  g.register(def("posture_two"))
  assert.equal(r.size(), 3)
  g.clear()
  assert.deepEqual(r.list().map((t) => t.name), ["keep"])
})

test("an unknown tool and a throwing handler both answer as tool errors, never as transport faults", async () => {
  const r = new ToolRegistry()
  r.register({ ...def("boom"), handler: async () => { throw new Error("it broke") } })
  const missing = await r.call("nope", {}, {})
  assert.equal(missing.isError, true)
  assert.match((missing.content as { text: string }[])[0]!.text, /No tool named nope/)
  const failed = await r.call("boom", {}, {})
  assert.equal(failed.isError, true)
  assert.match((failed.content as { text: string }[])[0]!.text, /it broke/)
})
