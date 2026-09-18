// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

export interface DiscoveryDocument {
  protocol_version: string
  provider_name: string
  issuer: string
  default_location: string
  supported_modes: string[]
  endpoints: { register: string; execute: string; list: string; status: string; revoke: string; introspect: string }
  jwks_uri: string
}

/**
 * GET {platformURL}/.well-known/agent-configuration.
 *
 * The document is unauthenticated, and `register()` POSTs the one-time
 * bootstrap token to `endpoints.register`. So every endpoint in it must sit on
 * the platform origin. A document that names another host is rejected before
 * any credential can travel to it (GHSA-84gm-35rm-x5m4).
 */
export async function discover(platformURL: string): Promise<DiscoveryDocument> {
  const url = new URL("/.well-known/agent-configuration", platformURL)
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`gibson-client: discovery failed: ${res.status} ${res.statusText}`)
  const doc = (await res.json()) as DiscoveryDocument
  assertEndpointsOnPlatform(doc, platformURL)
  return doc
}

/**
 * Reject any endpoint whose origin (scheme, host, port) differs from the
 * platform URL. Empty endpoints are skipped: the daemon leaves the ones it does
 * not serve blank.
 */
export function assertEndpointsOnPlatform(doc: DiscoveryDocument, platformURL: string): void {
  const platformOrigin = new URL(platformURL).origin
  if (!doc.endpoints) return
  for (const [name, endpoint] of Object.entries(doc.endpoints)) {
    if (!endpoint) continue
    let origin: string
    try {
      origin = new URL(endpoint).origin
    } catch {
      throw new Error(
        `gibson-client: discovery endpoint ${name} ${JSON.stringify(endpoint)} is not a valid URL`,
      )
    }
    if (origin !== platformOrigin) {
      throw new Error(
        `gibson-client: discovery endpoint ${name} ${JSON.stringify(endpoint)} is not on the platform ` +
          `origin ${platformOrigin}. Refusing to send credentials to another host.`,
      )
    }
  }
}
