import { test } from "node:test"
import assert from "node:assert/strict"
import { generateAgentKey } from "./keys.js"
import { AUDIENCE_GIBSON_DAEMON, signAgentJWT } from "./jwt.js"

/**
 * Request binding (gibson#1246).
 *
 * A component agent+jwt must name the exact gRPC method it may be presented at
 * and a FIXED audience, so ext-authz can reject a token replayed against any
 * other RPC and pin the audience to one constant. These mirror the Go SDK's
 * capabilitygrant/jwt_test.go — the two implementations share one wire format.
 */

function payloadOf(token: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString()) as Record<string, unknown>
}

test("signAgentJWT binds the method and mints the stable daemon audience", () => {
  const key = generateAgentKey()
  const method = "/gibson.daemon.v1.DaemonService/Execute"
  const token = signAgentJWT(key, {
    hostID: "host-1",
    agentID: "agent-1",
    method,
    componentScope: "component:demo",
  })

  const header = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString()) as Record<string, unknown>
  assert.equal(header.typ, "agent+jwt")
  assert.equal(header.alg, "EdDSA")
  assert.equal(header.kid, "agent-1", "kid must be the agentID for key resolution")

  const p = payloadOf(token)
  assert.equal(p.iss, "host-1")
  assert.equal(p.sub, "agent-1")
  assert.equal(p.aud, AUDIENCE_GIBSON_DAEMON)
  assert.equal(p.aud, "zeroroot.ai/gibson-daemon", "aud is the stable daemon constant")
  assert.equal(p.method, method, "method binds the token to a single RPC")
  assert.equal(p.component_scope, "component:demo")
  assert.ok(typeof p.jti === "string" && p.jti.length > 0, "jti must be present for replay prevention")
  assert.ok(typeof p.exp === "number" && typeof p.iat === "number")
  assert.ok((p.exp as number) - (p.iat as number) <= 60, "lifetime stays under the 60s server cap")
})

test("signAgentJWT mints a fresh jti each call", () => {
  const key = generateAgentKey()
  const args = { hostID: "h", agentID: "a", method: "/pkg.Svc/M", componentScope: "component:c" }
  const j1 = payloadOf(signAgentJWT(key, args)).jti
  const j2 = payloadOf(signAgentJWT(key, args)).jti
  assert.notEqual(j1, j2, "each token must carry a unique jti")
})

test("signAgentJWT rejects a missing method", () => {
  const key = generateAgentKey()
  assert.throws(
    () => signAgentJWT(key, { hostID: "h", agentID: "a", method: "", componentScope: "component:c" }),
    /method is required/,
  )
})

test("signAgentJWT rejects a missing componentScope", () => {
  const key = generateAgentKey()
  assert.throws(
    () => signAgentJWT(key, { hostID: "h", agentID: "a", method: "/pkg.Svc/M", componentScope: "" }),
    /componentScope is required/,
  )
})
