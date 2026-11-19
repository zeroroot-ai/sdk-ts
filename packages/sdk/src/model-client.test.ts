// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createServer, type IncomingHttpHeaders } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"

import {
  EventType,
  ModelAPIError,
  ModelClient,
  modelClientFrom,
  type ModelClientOptions,
} from "./model-client.js"
import {
  assistantMessage,
  functionCallOutput,
  parseItem,
  responseFunctionCalls,
  responseText,
  serializeItem,
  toolChoiceFunction,
  buildRequestBody,
  userMessage,
  isMessage,
  type Item,
  type ResponsesRequest,
  type Usage,
} from "./openresponses.js"
import { makeTestCa, startTlsServer } from "./tls-fixture.test.js"

/**
 * The golden files are copies of the files in the Go SDK
 * (`openresponses/testdata`). Both SDKs must send equal request bodies, so a
 * change to a golden file is a change to the contract.
 */
function golden(name: string): unknown {
  return JSON.parse(readFileSync(new URL(`../src/testdata/openresponses/${name}`, import.meta.url), "utf8"))
}

interface Capture {
  body: unknown
  headers: IncomingHttpHeaders
  path: string
}

async function gateway(status: number, contentType: string, reply: string) {
  const cap: Capture = { body: undefined, headers: {}, path: "" }
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      cap.body = JSON.parse(Buffer.concat(chunks).toString("utf8"))
      cap.headers = req.headers
      cap.path = req.url ?? ""
      res.writeHead(status, { "content-type": contentType })
      res.end(reply)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return { url, cap, close: () => server.close() }
}

function client(url: string, extra: Partial<ModelClientOptions> = {}): ModelClient {
  return new ModelClient({
    baseUrl: `${url}/`,
    model: "claude-test-1",
    routeHeaders: { "x-gibson-tenant": "t1", "x-gibson-provider": "p1" },
    headers: (route) => ({ "x-capability-grant": `grant-for-${route}` }),
    ...extra,
  })
}

const plainReply = `{"id":"resp_1","object":"response","status":"completed","model":"claude-test-1",
"output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed",
"content":[{"type":"output_text","text":"hello","annotations":[]}]}],
"usage":{"input_tokens":10,"output_tokens":3,"total_tokens":13,
"input_tokens_details":{"cached_tokens":4},"output_tokens_details":{"reasoning_tokens":1}}}`

test("a plain call sends the golden body, the route headers and the grant", async () => {
  const gw = await gateway(200, "application/json", plainReply)
  try {
    const resp = await client(gw.url).create({
      instructions: "Be brief.",
      input: [userMessage("say hello")],
      temperature: 0.2,
      max_output_tokens: 100,
    })
    assert.equal(responseText(resp), "hello")
    assert.equal(resp.usage?.totalTokens, 13)
    assert.equal(resp.usage?.cachedTokens, 4)
    assert.equal(resp.usage?.reasoningTokens, 1)
    assert.equal(gw.cap.path, "/v1/responses")
    assert.equal(gw.cap.headers["x-capability-grant"], "grant-for-/v1/responses")
    assert.equal(gw.cap.headers["x-gibson-tenant"], "t1")
    assert.equal(gw.cap.headers["x-gibson-provider"], "p1")
    assert.equal(gw.cap.headers.accept, "application/json")
    assert.deepEqual(gw.cap.body, golden("request_plain.json"))
  } finally {
    gw.close()
  }
})

test("a tool call round trip sends equal bodies on both turns", async () => {
  const reply = `{"id":"resp_2","status":"completed","model":"claude-test-1","output":[
{"type":"reasoning","id":"rs_1","summary":[{"type":"summary_text","text":"I need the weather."}],"encrypted_content":"abc"},
{"type":"function_call","id":"fc_1","call_id":"call_1","name":"get_weather","arguments":"{\\"city\\":\\"Oslo\\"}","status":"completed"}]}`
  const gw = await gateway(200, "application/json", reply)
  try {
    const cl = client(gw.url)
    const req: ResponsesRequest = {
      input: [userMessage("weather in Oslo?")],
      tools: [
        {
          name: "get_weather",
          description: "Get the weather.",
          parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"] },
        },
      ],
      tool_choice: "auto",
    }
    const resp = await cl.create(req)
    const calls = responseFunctionCalls(resp)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.name, "get_weather")
    assert.deepEqual(gw.cap.body, golden("request_tools_first.json"))

    // The agent sends all items back, with the tool result.
    const second: ResponsesRequest = {
      ...req,
      input: [...req.input, ...resp.output, functionCallOutput(calls[0]?.call_id ?? "", '{"temp_c":3}')],
    }
    await cl.create(second)
    assert.deepEqual(gw.cap.body, golden("request_tools_second.json"))
  } finally {
    gw.close()
  }
})

test("a structured call sets text.format and decodes the reply", async () => {
  const reply = `{"id":"resp_3","status":"completed","model":"claude-test-1","output":[
{"type":"message","id":"m","role":"assistant","status":"completed",
"content":[{"type":"output_text","text":"{\\"name\\":\\"Ada\\",\\"age\\":36}","annotations":[]}]}]}`
  const gw = await gateway(200, "application/json", reply)
  try {
    const schema = {
      type: "object",
      additionalProperties: false,
      properties: { name: { type: "string" }, age: { type: "integer" } },
      required: ["name", "age"],
    }
    const { value } = await client(gw.url).createStructured<{ name: string; age: number }>(
      { input: [userMessage("who?")] },
      "person",
      schema,
    )
    assert.deepEqual(value, { name: "Ada", age: 36 })
    assert.deepEqual(gw.cap.body, golden("request_structured.json"))
  } finally {
    gw.close()
  }
})

test("a structured reply that is not JSON is an error", async () => {
  const reply = `{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"nope"}]}]}`
  const gw = await gateway(200, "application/json", reply)
  try {
    await assert.rejects(
      client(gw.url).createStructured({ input: [userMessage("x")] }, "n", { type: "object" }),
      /decode structured reply/,
    )
  } finally {
    gw.close()
  }
})

const streamReply = `event: response.created
data: {"type":"response.created","sequence_number":0,"response":{"id":"resp_4","status":"in_progress","output":[]}}

event: response.output_item.added
data: {"type":"response.output_item.added","sequence_number":1,"output_index":0,"item":{"type":"message","id":"msg_1","role":"assistant","status":"in_progress","content":[]}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":2,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"Hel"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","sequence_number":3,"item_id":"msg_1","output_index":0,"content_index":0,"delta":"lo"}

event: response.completed
data: {"type":"response.completed","sequence_number":4,"response":{"id":"resp_4","status":"completed","output":[{"type":"message","id":"msg_1","role":"assistant","status":"completed","content":[{"type":"output_text","text":"Hello","annotations":[]}]}],"usage":{"input_tokens":5,"output_tokens":2,"total_tokens":7}}}

`

test("a streamed call sends the golden body and collects the deltas", async () => {
  const gw = await gateway(200, "text/event-stream", streamReply)
  try {
    const s = await client(gw.url).stream({ input: [userMessage("hi")] })
    const deltas: string[] = []
    const resp = await s.collect((d) => deltas.push(d))
    assert.deepEqual(deltas, ["Hel", "lo"])
    assert.equal(responseText(resp), "Hello")
    assert.equal(resp.usage?.totalTokens, 7)
    assert.equal(gw.cap.headers.accept, "text/event-stream")
    assert.deepEqual(gw.cap.body, golden("request_stream.json"))
  } finally {
    gw.close()
  }
})

test("a stream yields each event in order", async () => {
  const gw = await gateway(200, "text/event-stream", streamReply)
  try {
    const s = await client(gw.url).stream({ input: [userMessage("hi")] })
    const types: string[] = []
    for await (const ev of s) types.push(ev.type)
    assert.deepEqual(types, [
      EventType.Created,
      EventType.OutputItemAdded,
      EventType.OutputTextDelta,
      EventType.OutputTextDelta,
      EventType.Completed,
    ])
  } finally {
    gw.close()
  }
})

test("a stream reads function call arguments", async () => {
  const reply = `event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","sequence_number":1,"item_id":"fc_1","output_index":0,"delta":"{\\"a\\":"}

event: response.function_call_arguments.done
data: {"type":"response.function_call_arguments.done","sequence_number":2,"item_id":"fc_1","output_index":0,"arguments":"{\\"a\\":1}"}

event: response.completed
data: {"type":"response.completed","sequence_number":3,"response":{"status":"completed","output":[{"type":"function_call","call_id":"c1","name":"f","arguments":"{\\"a\\":1}"}]}}

`
  const gw = await gateway(200, "text/event-stream", reply)
  try {
    const s = await client(gw.url).stream({ input: [userMessage("x")] })
    const resp = await s.collect()
    assert.equal(responseFunctionCalls(resp)[0]?.arguments, '{"a":1}')
  } finally {
    gw.close()
  }
})

test("a stream with CRLF line ends and no final blank line still ends", async () => {
  const reply =
    'event: response.completed\r\ndata: {"type":"response.completed","response":{"status":"completed","output":[]}}'
  const gw = await gateway(200, "text/event-stream", reply)
  try {
    const s = await client(gw.url).stream({ input: [userMessage("x")] })
    assert.equal((await s.collect()).status, "completed")
  } finally {
    gw.close()
  }
})

test("a failed stream throws and says why", async () => {
  const reply =
    "event: response.failed\n" +
    `data: {"type":"response.failed","sequence_number":1,"response":{"status":"failed","error":{"code":"server_error","message":"boom"}}}` +
    "\n\n"
  const gw = await gateway(200, "text/event-stream", reply)
  try {
    const s = await client(gw.url).stream({ input: [userMessage("x")] })
    await assert.rejects(s.collect(), /boom/)
  } finally {
    gw.close()
  }
})

test("an error reply of the gateway is a ModelAPIError", async () => {
  const gw = await gateway(
    403,
    "application/json",
    `{"error":{"type":"invalid_request","code":"model_forbidden","message":"model not allowed","param":"model"}}`,
  )
  try {
    await assert.rejects(client(gw.url).create({ input: [userMessage("x")] }), (e: unknown) => {
      assert.ok(e instanceof ModelAPIError)
      assert.equal(e.statusCode, 403)
      assert.equal(e.code, "model_forbidden")
      assert.equal(e.param, "model")
      return true
    })
  } finally {
    gw.close()
  }
})

test("an error reply with a plain body keeps the text", async () => {
  const gw = await gateway(502, "text/plain", "bad gateway")
  try {
    await assert.rejects(client(gw.url).create({ input: [userMessage("x")] }), (e: unknown) => {
      assert.ok(e instanceof ModelAPIError)
      assert.match(e.message, /bad gateway/)
      return true
    })
  } finally {
    gw.close()
  }
})

test("a response with the status failed is an error", async () => {
  const gw = await gateway(200, "application/json", `{"status":"failed","error":{"code":"model_error","message":"overloaded"}}`)
  try {
    await assert.rejects(client(gw.url).create({ input: [userMessage("x")] }), /overloaded/)
  } finally {
    gw.close()
  }
})

test("a request needs a model and a URL", async () => {
  assert.throws(() => new ModelClient({ baseUrl: "" }), /no base URL/)
  await assert.rejects(new ModelClient({ baseUrl: "http://127.0.0.1:1" }).create({ input: [] }), /no model/)
})

test("a failing header function stops the call", async () => {
  const gw = await gateway(200, "application/json", plainReply)
  try {
    const cl = client(gw.url, {
      headers: () => {
        throw new Error("no grant")
      },
    })
    await assert.rejects(cl.create({ input: [userMessage("x")] }), /no grant/)
  } finally {
    gw.close()
  }
})

test("onUsage reports a plain call and a streamed call", async () => {
  const got: Usage[] = []
  const gw = await gateway(200, "application/json", plainReply)
  const sgw = await gateway(200, "text/event-stream", streamReply)
  try {
    await client(gw.url, { onUsage: (u) => got.push(u) }).create({ input: [userMessage("x")] })
    const s = await client(sgw.url, { onUsage: (u) => got.push(u) }).stream({ input: [userMessage("x")] })
    await s.collect()
    assert.deepEqual(got.map((u) => u.totalTokens), [13, 7])
  } finally {
    gw.close()
    sgw.close()
  }
})

test("items round trip, and an unknown item type keeps its JSON", () => {
  const items = [
    `{"type":"message","role":"user","content":[{"type":"input_text","text":"a"}]}`,
    `{"type":"message","id":"m","role":"assistant","status":"completed","content":[{"type":"output_text","text":"b","annotations":[]},{"type":"refusal","refusal":"no"},{"type":"input_image","image_url":"u"}]}`,
    `{"type":"function_call","id":"f","status":"completed","call_id":"c","name":"n","arguments":"{}"}`,
    `{"type":"function_call_output","call_id":"c","output":"ok"}`,
    `{"type":"reasoning","id":"r","status":"completed","summary":[{"type":"summary_text","text":"s"}],"content":[{"type":"output_text","text":"c"}],"encrypted_content":"e"}`,
    `{"type":"web_search_call","id":"w","status":"completed","extra":{"nested":[1,2]}}`,
  ]
  for (const raw of items) {
    assert.deepEqual(serializeItem(parseItem(JSON.parse(raw))), JSON.parse(raw), raw)
  }
})

test("a message with a string as content becomes one text part", () => {
  const item = parseItem({ type: "message", role: "user", content: "plain" })
  assert.ok(isMessage(item))
  assert.deepEqual(item.content, [{ type: "input_text", text: "plain" }])
})

test("a function call output that is not a string becomes JSON text", () => {
  const item = parseItem({ type: "function_call_output", call_id: "c", output: { a: 1 } })
  assert.deepEqual(item, { type: "function_call_output", call_id: "c", output: '{"a":1}' })
})

test("a reasoning record keeps encrypted_content unchanged", () => {
  const item: Item = { type: "reasoning", summary: [], encrypted_content: "opaque==" }
  assert.deepEqual(serializeItem(item), { type: "reasoning", summary: [], encrypted_content: "opaque==" })
})

test("an assistant message gets an empty annotations list", () => {
  assert.deepEqual(serializeItem(assistantMessage("x")), {
    type: "message",
    role: "assistant",
    content: [{ type: "output_text", text: "x", annotations: [] }],
  })
})

test("toolChoiceFunction names the function", () => {
  const body = buildRequestBody({ model: "m", input: [], tool_choice: toolChoiceFunction("f") })
  assert.deepEqual(body.tool_choice, { type: "function", name: "f" })
})

test("a client trusts exactly the CA bundle of the gateway", async () => {
  const ca = makeTestCa()
  const other = makeTestCa("other-ca")
  const gw = await startTlsServer(ca, (_req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(plainReply)
  })
  try {
    const req: ResponsesRequest = { input: [userMessage("x")] }
    const good = new ModelClient({ baseUrl: gw.url, model: "m", caPem: ca.caPem })
    assert.equal(responseText(await good.create(req)), "hello")
    // No bundle: the system roots do not trust the test CA.
    await assert.rejects(new ModelClient({ baseUrl: gw.url, model: "m" }).create(req), /call gateway/)
    // Another bundle: the call fails.
    await assert.rejects(new ModelClient({ baseUrl: gw.url, model: "m", caPem: other.caPem }).create(req), /call gateway/)
    // A stream trusts the same bundle.
    const s = await good.stream(req)
    await assert.rejects(s.collect(), /no terminal event/)
  } finally {
    await gw.close()
    ca.cleanup()
    other.cleanup()
  }
})

test("a bundle needs an https URL, holds a certificate, and does not mix with fetch", () => {
  const ca = makeTestCa()
  try {
    assert.throws(() => new ModelClient({ baseUrl: "http://gateway.example", model: "m", caPem: ca.caPem }), /https/)
    assert.throws(() => new ModelClient({ baseUrl: "https://gateway.example", model: "m", caPem: "not pem" }), /no certificate/)
    assert.throws(
      () => new ModelClient({ baseUrl: "https://gateway.example", model: "m", caPem: ca.caPem, fetch }),
      /not both/,
    )
  } finally {
    ca.cleanup()
  }
})

test("modelClientFrom builds a client from the answer of ResolveModel", async () => {
  const ca = makeTestCa()
  const gw = await startTlsServer(ca, (req, res) => {
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({ status: "completed", output: [], model: String(req.headers["x-gibson-provider"]) }))
  })
  try {
    const cl = modelClientFrom(
      {
        model: "claude-x",
        provider: "anthropic-main",
        gatewayUrl: gw.url,
        routeHeaders: { "x-gibson-provider": "anthropic-main", "x-gibson-tenant": "t" },
        contextWindow: 200000,
        maxOutputTokens: 8192,
        gatewayCaPem: ca.caPem,
      },
      { headers: () => ({ "x-capability-grant": "g" }) },
    )
    assert.equal(cl.provider, "anthropic-main")
    assert.equal(cl.contextWindow, 200000)
    const resp = await cl.create({ input: [] })
    assert.equal(resp.model, "anthropic-main")
  } finally {
    await gw.close()
    ca.cleanup()
  }
})
