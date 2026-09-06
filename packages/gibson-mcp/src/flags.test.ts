// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { DEFAULT_STREAM_LIMIT, parseFlags, parseListen } from "./flags.js"

test("stdio is the default transport", () => {
  const f = parseFlags([])
  assert.equal(f.transport, "stdio")
  assert.equal(f.streamLimit, DEFAULT_STREAM_LIMIT)
  assert.deepEqual(f.listen, { host: "127.0.0.1", port: 7788 })
})

test("the flat RPC tier is off by default and --expose-all-rpcs turns it on", () => {
  assert.equal(parseFlags([]).exposeAllRpcs, false)
  assert.equal(parseFlags(["--expose-all-rpcs"]).exposeAllRpcs, true)
  assert.equal(parseFlags(["--transport", "http", "--expose-all-rpcs"]).exposeAllRpcs, true)
})

test("--listen takes host:port, [v6]:port, or a bare port", () => {
  assert.deepEqual(parseListen("127.0.0.1:9000"), { host: "127.0.0.1", port: 9000 })
  assert.deepEqual(parseListen("[::1]:9000"), { host: "::1", port: 9000 })
  assert.deepEqual(parseListen("0"), { host: "127.0.0.1", port: 0 })
  assert.deepEqual(parseListen("localhost:1"), { host: "localhost", port: 1 })
})

test("--listen refuses a non-loopback address: the control endpoint swaps credentials", () => {
  assert.throws(() => parseListen("0.0.0.0:9000"), /loopback/)
  assert.throws(() => parseListen("10.0.0.5:9000"), /loopback/)
  assert.throws(() => parseListen("9000000"), /valid port/)
})

test("an unknown transport and a bad stream limit are refused", () => {
  assert.throws(() => parseFlags(["--transport", "sse"]), /stdio or http/)
  assert.throws(() => parseFlags(["--stream-limit", "0"]), /positive integer/)
  assert.deepEqual(parseFlags(["--transport", "http", "--listen", "127.0.0.1:0"]).listen, { host: "127.0.0.1", port: 0 })
})
