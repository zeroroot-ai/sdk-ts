import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"

export interface HostKey { id: string; publicKey: KeyObject; privateKey: KeyObject }
export interface AgentKey { publicKey: KeyObject; privateKey: KeyObject }

/** RFC 7638 JWK thumbprint of an Ed25519 (OKP) public key. Stable host id. */
export function jwkThumbprint(publicKey: KeyObject): string {
  const jwk = publicKey.export({ format: "jwk" }) as { kty: string; crv: string; x: string }
  // Canonical members, lexicographic order: crv, kty, x.
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x })
  return createHash("sha256").update(canonical).digest().toString("base64url")
}

/** OKP public JWK for the wire (host_key_jwk / agent_key_jwk). */
export function publicKeyJWK(publicKey: KeyObject): Record<string, unknown> {
  return publicKey.export({ format: "jwk" }) as Record<string, unknown>
}

export function generateAgentKey(): AgentKey {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  return { publicKey, privateKey }
}

/** Persistent host key: generated once (0600), reused across restarts. */
export function loadOrGenerateHostKey(path: string): HostKey {
  if (existsSync(path)) {
    const privateKey = createPrivateKey(readFileSync(path, "utf8"))
    const publicKey = createPublicKey(privateKey)
    return { id: jwkThumbprint(publicKey), publicKey, privateKey }
  }
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, (privateKey.export({ type: "pkcs8", format: "pem" }) as string), { mode: 0o600 })
  return { id: jwkThumbprint(publicKey), publicKey, privateKey }
}
