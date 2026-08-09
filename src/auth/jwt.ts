import { sign, type KeyObject } from "node:crypto"

// agent+jwt / host+jwt are short-lived (matches the Go client: iat + 55s).
const JWT_TTL_SECONDS = 55

/**
 * Stable audience every component agent+jwt names, and that ext-authz pins via
 * ComponentConfig.ExpectedAudiences (gibson#1246).
 *
 * It is a FIXED logical identifier for the daemon — NOT the dialled endpoint.
 * Per-call request binding lives in the `method` claim instead, so the audience
 * no longer varies per call. This mirrors the Go SDK's
 * capabilitygrant.AudienceGibsonDaemon; the two are one wire contract and must
 * never diverge.
 */
export const AUDIENCE_GIBSON_DAEMON = "zeroroot.ai/gibson-daemon"

function b64urlJSON(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64url")
}

/** Compact Ed25519 JWT (EdDSA), stdlib only — mirrors sdk/capabilitygrant signJWT. */
function signJWT(privateKey: KeyObject, header: Record<string, string>, payload: Record<string, unknown>): string {
  const signingInput = `${b64urlJSON(header)}.${b64urlJSON(payload)}`
  const sig = sign(null, Buffer.from(signingInput), privateKey).toString("base64url")
  return `${signingInput}.${sig}`
}

export function signHostJWT(host: { id: string; privateKey: KeyObject }, audience: string): string {
  const now = Math.floor(Date.now() / 1000)
  return signJWT(host.privateKey, { typ: "host+jwt", alg: "EdDSA" }, {
    iss: host.id, aud: audience, iat: now, exp: now + JWT_TTL_SECONDS, jti: crypto.randomUUID(),
  })
}

export interface AgentJWTParams {
  hostID: string
  agentID: string
  /**
   * The full gRPC method the token is bound to, in "/<package.Service>/<Method>"
   * form — exactly the value ext-authz reads from the request `:path`. Required;
   * the verifier rejects a token whose method claim is absent or does not match
   * the request (gibson#1246).
   */
  method: string
  componentScope: string
}

export function signAgentJWT(agent: { privateKey: KeyObject }, p: AgentJWTParams): string {
  if (!p.componentScope) throw new Error("gibson-client: componentScope is required (obtain from register())")
  if (!p.method) throw new Error("gibson-client: method is required (the full gRPC method the token is bound to)")
  const now = Math.floor(Date.now() / 1000)
  return signJWT(agent.privateKey, { typ: "agent+jwt", alg: "EdDSA", kid: p.agentID }, {
    iss: p.hostID, sub: p.agentID, aud: AUDIENCE_GIBSON_DAEMON,
    iat: now, exp: now + JWT_TTL_SECONDS, jti: crypto.randomUUID(), method: p.method, component_scope: p.componentScope,
  })
}
