// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"
import { HarnessCallbackService, type TaskHarness } from "@zeroroot-ai/sdk"
import { apiTools, closest, DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT, search, services, similarity, terms } from "./api.js"
import { GENERATED_SERVICES } from "./generated/tools.js"
import { rpcCatalog } from "./rpc.js"

const anyTransport = () => createRouterTransport(() => {})
const catalog = () => rpcCatalog({ channels: { session: anyTransport() }, streamLimit: 10 })

function tool(name: string) {
  return apiTools({ catalog: catalog() }).find((t) => t.name === name)!
}

function body(res: { content: unknown }): string {
  return (res.content as { text: string }[])[0]!.text
}

test("coverage and exposure are different things, and only exposure changed", () => {
  // The distinction this slice turns on. The catalog is still one entry per
  // RPC of every service in the descriptors: that is coverage, and the drift
  // guard in rpc.test.ts is what proves it. Exposure is which of them reach
  // tools/list, and that is decided in build.ts, not here.
  const built = catalog()
  const fromDescriptors = GENERATED_SERVICES.flatMap((e) => e.service.methods.map((m) => `${e.service.typeName}.${m.localName}`))
  assert.equal(built.length, fromDescriptors.length, "every RPC is still built")
  assert.deepEqual(
    built.map((e) => `${e.service.typeName}.${e.method.localName}`).sort(),
    [...fromDescriptors].sort(),
    "the built set is still 1:1 with the descriptors; hiding a tool must never drop one",
  )
})

test("a search names the tool, the service and the whole input schema, so one call is enough to invoke it", async () => {
  const res = await tool("gibson_api_search").handler({ query: "submit a finding" }, {})
  const out = JSON.parse(body(res)) as { matches: { name: string; service: string; input_schema: { type: string; properties?: unknown } }[]; of: number }
  assert.equal(out.of, catalog().length)
  const first = out.matches[0]!
  assert.match(first.name, /submit_finding$/)
  assert.match(first.service, /^gibson\./)
  assert.equal(first.input_schema.type, "object")
  assert.ok(first.input_schema.properties, "the schema is the full one, not a stub the caller has to go and fetch")
})

test("representative queries land on the right RPC, so ranking cannot silently rot", () => {
  const c = catalog()
  const top3 = (query: string) => search(c, query, 3).map((h) => h.name)
  const pins: [string, string][] = [
    ["submit a finding", "submit_finding"],
    ["open a job on a bank", "job_service_open_job"],
    ["list the members of a bank", "bank_service_list_members"],
    ["close a job with a verdict", "close_job"],
    ["world view", "harness_callback_service_world_view"],
    ["create a mission", "create_mission"],
    ["list the tools in this tenant", "list_tools"],
    ["renew my capability grant", "daemon_service_renew_capability_grant"],
    ["subscribe to input for this member", "harness_callback_service_subscribe_input"],
  ]
  for (const [query, expected] of pins) {
    const hits = top3(query)
    assert.ok(
      hits.some((name) => name.includes(expected)),
      `${JSON.stringify(query)} should put ${expected} in the top three, got ${hits.join(", ")}`,
    )
  }
})

test("an empty query lists the services with a count each, because an agent orienting itself has not failed a search", async () => {
  const res = await tool("gibson_api_search").handler({ query: "   " }, {})
  const out = JSON.parse(body(res)) as { services: { service: string; tools: number; example: string }[]; rpcs: number }
  assert.equal(out.services.length, 12)
  assert.equal(out.rpcs, catalog().length)
  assert.equal(
    out.services.reduce((n, s) => n + s.tools, 0),
    catalog().length,
    "the counts must add up to the catalog, or an agent reads a smaller API than exists",
  )
  for (const s of out.services) {
    assert.ok(s.tools > 0)
    assert.ok(s.example.length > 0, "each service names one tool, so the next search has something to copy")
  }
})

test("both meta-tool descriptions say the whole API is there, and name examples", () => {
  for (const name of ["gibson_api_search", "gibson_api_call"]) {
    const d = tool(name).description
    assert.match(d, /whole API is reachable/, `${name} must say the door exists`)
    assert.match(d, /\d+ RPCs across \d+ services/, `${name} must say how much is behind it`)
    // A model that never reads the 188 entries learns the vocabulary here or
    // nowhere, so the examples are load-bearing.
    for (const example of ["CreateBank", "OpenJob", "CreateMission", "QueryNodes"]) {
      assert.ok(d.includes(example), `${name} should name ${example} as an example`)
    }
    assert.match(d, /not in your tool list/, `${name} must explain why they are absent`)
  }
})

test("the limit defaults, and the cap holds", async () => {
  const c = catalog()
  assert.equal(search(c, "job", DEFAULT_SEARCH_LIMIT).length, DEFAULT_SEARCH_LIMIT)
  const capped = await tool("gibson_api_search").handler({ query: "get", limit: MAX_SEARCH_LIMIT }, {})
  const out = JSON.parse(body(capped)) as { matches: unknown[] }
  assert.ok(out.matches.length <= MAX_SEARCH_LIMIT)
  // The schema refuses a limit past the cap rather than quietly clamping a
  // number the model chose on purpose.
  const refused = await tool("gibson_api_search").handler({ query: "get", limit: 500 }, {})
  assert.equal(refused.isError, true)
})

test("a search that matches nothing says what to do next instead of answering with silence", async () => {
  const res = await tool("gibson_api_search").handler({ query: "zzzzqqqq" }, {})
  const out = JSON.parse(body(res)) as { matches: unknown[]; services: string[]; next: string }
  assert.deepEqual(out.matches, [])
  assert.equal(out.services.length, 12)
  assert.match(out.next, /empty query/)
})

test("gibson_api_call reaches a generated tool, and the flat path returns exactly the same thing", async () => {
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, {
      worldView: () => ({ entities: [{ handle: "h-1", kind: 1, label: "api.example.com", attributes: {} }], truncated: false }),
    })
  })
  const task = { transport, context: { missionId: "m-1", taskId: "t-1", agentName: "claude" } } as TaskHarness
  const c = rpcCatalog({ channels: { task }, streamLimit: 10 })
  const flat = c.find((e) => e.tool.name === "harness_callback_service_world_view")!.tool
  const call = apiTools({ catalog: c }).find((t) => t.name === "gibson_api_call")!

  const direct = await flat.handler({ focus: [] }, {})
  const viaApi = await call.handler({ name: "harness_callback_service_world_view", input: { focus: [] } }, {})
  assert.notEqual(viaApi.isError, true, body(viaApi))
  assert.deepEqual(viaApi.content, direct.content, "the two paths run one handler; if this ever differs, there are two of them")
})

test("an unknown name comes back with the closest ones, so a near miss costs one call", async () => {
  const res = await tool("gibson_api_call").handler({ name: "harness_callback_service_word_view", input: {} }, {})
  assert.equal(res.isError, true)
  const text = body(res)
  assert.match(text, /no RPC named harness_callback_service_word_view/)
  assert.match(text, /harness_callback_service_world_view/, "the name that was meant must be among the suggestions")
  assert.equal(text.split("\n").filter((l) => l.startsWith("- ")).length, 3)
})

test("with no platform both meta-tools say so rather than dialling nothing", async () => {
  const [searchTool, callTool] = apiTools({ catalog: [] })
  for (const t of [searchTool!, callTool!]) {
    const res = await t.handler({ query: "anything", name: "x" }, {})
    assert.equal(res.isError, true)
    assert.match(body(res), /gibson_status/)
  }
})

test("the scorer prefers the method, then the service, then the prose", () => {
  const c = catalog()
  // "bank" as a whole word in a method name must outrank "bank" appearing in
  // a sentence somewhere else.
  const hits = search(c, "delete a bank", 3).map((h) => h.name)
  assert.equal(hits[0], "bank_service_delete_bank")
  assert.deepEqual(terms("Submit a Finding, please!"), ["submit", "finding"])
  assert.deepEqual(terms("the a an of"), [], "stopwords alone leave nothing to search on")
})

test("similarity survives a typo, which an equality test does not", () => {
  assert.ok(similarity("world_view", "world_view") === 1)
  assert.ok(similarity("word_view", "world_view") > 0.7)
  assert.ok(similarity("word_view", "create_bank") < 0.3)
  assert.equal(closest(catalog(), "bank_service_lst_members", 1)[0], "bank_service_list_members")
})

test("a ranking is deterministic, so the same query always answers the same way", () => {
  const c = catalog()
  assert.deepEqual(search(c, "job", 10).map((h) => h.name), search(c, "job", 10).map((h) => h.name))
  assert.equal(services(c).length, services(c).length)
  const names = services(c).map((s) => s.service)
  assert.deepEqual(names, names.slice().sort(), "the service list is sorted, so it reads the same every time")
})
