import { sign, type KeyObject } from "node:crypto"

// agent+jwt / host+jwt are short-lived (matches the Go client: iat + 55s).
const JWT_TTL_SECONDS = 55

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

export interface AgentJWTParams { hostID: string; agentID: string; audience: string; componentScope: string }

export function signAgentJWT(agent: { privateKey: KeyObject }, p: AgentJWTParams): string {
  if (!p.componentScope) throw new Error("gibson-client: componentScope is required (obtain from register())")
  const now = Math.floor(Date.now() / 1000)
  return signJWT(agent.privateKey, { typ: "agent+jwt", alg: "EdDSA", kid: p.agentID }, {
    iss: p.hostID, sub: p.agentID, aud: p.audience,
    iat: now, exp: now + JWT_TTL_SECONDS, jti: crypto.randomUUID(), component_scope: p.componentScope,
  })
}
