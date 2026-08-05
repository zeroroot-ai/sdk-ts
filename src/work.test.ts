import assert from "node:assert/strict"
import test from "node:test"

import { decodeToolInput, encodeToolError, encodeToolOutput } from "./work.js"

const enc = new TextEncoder()
const dec = new TextDecoder()

test("decodeToolInput parses the protojson envelope's inner JSON string", () => {
  // The harness sends protojson of ExecuteRequest, whose input_json is itself a
  // JSON *string* — a double encoding that is easy to get wrong in both
  // directions.
  const payload = enc.encode(JSON.stringify({ inputJson: JSON.stringify({ url: "https://google.com" }) }))
  assert.deepEqual(decodeToolInput(payload), { url: "https://google.com" })
})

test("decodeToolInput accepts the snake_case field name too", () => {
  // protojson emits lowerCamelCase, but a hand-built or differently-configured
  // marshaller may emit the proto field name. Accepting both costs nothing and
  // avoids a silent empty-input execution.
  const payload = enc.encode(JSON.stringify({ input_json: JSON.stringify({ url: "https://example.com" }) }))
  assert.deepEqual(decodeToolInput(payload), { url: "https://example.com" })
})

test("decodeToolInput treats absent or empty input as no parameters", () => {
  assert.deepEqual(decodeToolInput(new Uint8Array()), {})
  assert.deepEqual(decodeToolInput(enc.encode("{}")), {})
  assert.deepEqual(decodeToolInput(enc.encode(JSON.stringify({ inputJson: "" }))), {})
})

test("decodeToolInput wraps a non-object input rather than dropping it", () => {
  const payload = enc.encode(JSON.stringify({ inputJson: JSON.stringify("plain string") }))
  assert.deepEqual(decodeToolInput(payload), { value: "plain string" })
})

test("encodeToolOutput double-encodes into ExecuteResponse.output_json", () => {
  const out = JSON.parse(dec.decode(encodeToolOutput({ status: 200 }))) as { outputJson: string }
  assert.equal(typeof out.outputJson, "string", "output_json must be a JSON string, not an object")
  assert.deepEqual(JSON.parse(out.outputJson), { status: 200 })
})

test("encodeToolOutput represents an absent result as JSON null", () => {
  const out = JSON.parse(dec.decode(encodeToolOutput(undefined))) as { outputJson: string }
  assert.equal(out.outputJson, "null")
})

test("encodeToolError reports the failure instead of leaving the node to time out", () => {
  const out = JSON.parse(dec.decode(encodeToolError("boom"))) as {
    outputJson: string
    error: { message: string }
  }
  assert.equal(out.error.message, "boom")
  assert.equal(out.outputJson, "")
})

test("a round trip survives the double encoding", () => {
  const original = { url: "https://google.com", method: "GET" }
  const request = enc.encode(JSON.stringify({ inputJson: JSON.stringify(original) }))
  const input = decodeToolInput(request)
  const response = JSON.parse(dec.decode(encodeToolOutput(input))) as { outputJson: string }
  assert.deepEqual(JSON.parse(response.outputJson), original)
})
