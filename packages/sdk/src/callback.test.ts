// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import { callbackBaseUrl } from "./callback.js"

/**
 * The task-scoped callback seam.
 *
 * The fact worth defending here is the endpoint FORM: gibson sends a bare dial
 * target, connect-node needs a URL. The header the grant travels in is pinned
 * in task-harness.test.ts.
 */

test("callbackBaseUrl gives a bare host:port a scheme", () => {
  // gibson's CallbackManager.CallbackEndpoint() returns "gibson:50001" /
  // "localhost:50001" — a gRPC dial target, not a URL.
  assert.equal(callbackBaseUrl("gibson:50001"), "https://gibson:50001")
  assert.equal(callbackBaseUrl("localhost:50001"), "https://localhost:50001")
})

test("callbackBaseUrl defaults to TLS and takes plaintext only on request", () => {
  // Fail secure: a daemon with a trust domain requires mTLS on this listener, so
  // defaulting to http would downgrade every deployment that did not opt out.
  assert.ok(callbackBaseUrl("gibson:50001").startsWith("https://"))
  assert.equal(callbackBaseUrl("gibson:50001", true), "http://gibson:50001")
})

test("callbackBaseUrl passes an explicit http(s) endpoint through", () => {
  assert.equal(callbackBaseUrl("https://daemon.example:8443"), "https://daemon.example:8443")
  assert.equal(callbackBaseUrl("http://localhost:8080"), "http://localhost:8080")
  assert.equal(callbackBaseUrl("https://daemon.example:8443/"), "https://daemon.example:8443")
})

test("callbackBaseUrl strips many trailing slashes in linear time", () => {
  // `replace(/\/+$/, "")` is quadratic here — the engine retries the `+` from
  // every start position — and this input arrives off the wire. CodeQL flagged
  // it as a polynomial ReDoS on the first cut of this file.
  const many = "gibson:50001" + "/".repeat(50_000)
  const started = process.hrtime.bigint()
  assert.equal(callbackBaseUrl(many), "https://gibson:50001")
  const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6
  assert.ok(elapsedMs < 250, `expected linear strip, took ${elapsedMs.toFixed(1)}ms`)
})

test("callbackBaseUrl rejects a non-http scheme rather than mangling it", () => {
  // Gluing "https://" onto "grpc://host:1" yields an unresolvable host and a
  // dial error that points nowhere near the real mistake.
  assert.throws(() => callbackBaseUrl("grpc://gibson:50001"), /must be http\(s\)/)
  assert.throws(() => callbackBaseUrl("unix:///var/run/x.sock"), /must be http\(s\)/)
})

test("callbackBaseUrl rejects an empty endpoint", () => {
  assert.throws(() => callbackBaseUrl(""), /empty/)
  assert.throws(() => callbackBaseUrl("   "), /empty/)
})
