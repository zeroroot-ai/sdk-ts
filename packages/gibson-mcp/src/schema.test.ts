// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { ScalarType } from "@bufbuild/protobuf"
import { HarnessCallbackService } from "@zeroroot-ai/sdk"
import { ComponentService } from "@zeroroot-ai/sdk/gen/gibson/component/v1/component_pb.js"
import { MAX_DEPTH, messageSchema, requestSchema, scalarSchema } from "./schema.js"

const method = (service: typeof HarnessCallbackService | typeof ComponentService, localName: string) =>
  service.methods.find((m) => m.localName === localName)!

test("a 64-bit integer is a decimal string, because that is what protojson writes", () => {
  assert.equal(scalarSchema(ScalarType.INT64).type, "string")
  assert.equal(scalarSchema(ScalarType.INT32).type, "integer")
  assert.equal(scalarSchema(ScalarType.DOUBLE).type, "number")
  assert.equal(scalarSchema(ScalarType.BOOL).type, "boolean")
  assert.equal(scalarSchema(ScalarType.BYTES).contentEncoding, "base64")
})

test("a request schema names the camelCase protojson keys", () => {
  const s = requestSchema(method(ComponentService, "callTool").input)
  const props = s.properties as Record<string, unknown>
  assert.ok(props.toolName, "the proto field tool_name is toolName in protojson")
  assert.ok(props.inputJson)
  // A 64-bit field is a string, so a model writes "5000" and not 5000.
  assert.equal((props.timeoutMs as { type: string }).type, "string")
})

test("an enum is its value names, and a repeated field is an array", () => {
  const s = requestSchema(method(HarnessCallbackService, "worldView").input)
  const props = s.properties as Record<string, { type?: string; items?: unknown }>
  const focus = props.focus
  assert.equal(focus?.type, "array")
  assert.equal((focus?.items as { type: string } | undefined)?.type, "string")
})

test("a map is an object with typed values, whatever the proto key type", () => {
  const s = messageSchema(method(HarnessCallbackService, "queryPlugin").input) as {
    properties: Record<string, { type?: string; additionalProperties?: unknown }>
  }
  const params = s.properties.params
  assert.equal(params?.type, "object")
  assert.ok(params?.additionalProperties, "a map's value schema is on additionalProperties")
})

test("TypedValue is any JSON value, not a walk of its oneof", () => {
  const s = messageSchema(method(HarnessCallbackService, "queryPlugin").input) as {
    properties: Record<string, { additionalProperties?: { description?: string; properties?: unknown } }>
  }
  const value = s.properties.params?.additionalProperties
  assert.match(value?.description ?? "", /Any JSON value/)
  assert.equal(value?.properties, undefined, "a TypedValue must not expand into its eight kinds")
})

test("the walk is bounded, so a recursive message still has a finite schema", () => {
  // Every request in the pinned protos must produce a schema, and none of
  // them may run away: an unbounded walk of a self-referential message never
  // returns, and the bigger daemon requests would each be hundreds of
  // kilobytes on every tools/list.
  let deepest = ""
  let largest = 0
  for (const service of [HarnessCallbackService, ComponentService]) {
    for (const m of service.methods) {
      const size = JSON.stringify(requestSchema(m.input)).length
      if (size > largest) {
        largest = size
        deepest = m.input.typeName
      }
    }
  }
  process.stderr.write(`[schema] largest request schema: ${deepest} at ${largest} bytes\n`)
  assert.ok(largest < 200_000, `${deepest} produced ${largest} bytes`)
  assert.ok(MAX_DEPTH >= 3, "a bound under three hides the shape of an ordinary request")
})

test("a well-known type keeps its JSON form", () => {
  const timestamp = messageSchema({ typeName: "google.protobuf.Timestamp", fields: [] } as never)
  assert.equal(timestamp.format, "date-time")
})
