import assert from "node:assert/strict"
import test from "node:test"

import { callbackAuthInterceptor, callbackBaseUrl, connectTaskHarness } from "./callback.js"

/**
 * The task-scoped callback seam.
 *
 * The two facts worth defending here are the ones that fail silently or
 * expensively: the header NAME (the component leg uses a different one, and
 * getting it backwards 401s every call), and the endpoint FORM (gibson sends a
 * bare dial target, connect-node needs a URL).
 */

test("the task grant travels in authorization, NOT x-capability-grant", async () => {
  // Component RPCs use x-capability-grant because Envoy's jwt_authn owns
  // Authorization at the edge. The callback listener is NOT behind jwt_authn and
  // takes a bearer token — the Go CallbackClient sets exactly this
  // (serve/callback_client.go:245-254). Swapping the two 401s every call.
  const req = { header: new Headers() }
  let sawNext = false
  await callbackAuthInterceptor("tok-123")(async () => {
    sawNext = true
    return {} as never
  })(req as never)

  assert.equal(req.header.get("authorization"), "Bearer tok-123")
  assert.equal(req.header.get("x-capability-grant"), null)
  assert.ok(sawNext, "the interceptor must call through")
})

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

test("connectTaskHarness refuses an empty token instead of dialing unauthenticated", () => {
  // The whole point of this seam is to stop a dispatched run borrowing the
  // component's authority. Falling back to an unauthenticated dial — or to the
  // component grant — would reintroduce exactly that.
  assert.throws(
    () => connectTaskHarness({ endpoint: "gibson:50001", token: "" }),
    /callback token is empty/,
  )
})

test("connectTaskHarness builds a HarnessCallbackService client", () => {
  const harness = connectTaskHarness({ endpoint: "gibson:50001", token: "tok" })
  // Spot-check the surface a dispatched run actually needs: LLM, tools, delegation.
  assert.equal(typeof harness.lLMComplete, "function")
  assert.equal(typeof harness.callToolProto, "function")
  assert.equal(typeof harness.delegateToAgent, "function")
})
