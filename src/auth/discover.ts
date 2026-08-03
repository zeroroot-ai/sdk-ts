export interface DiscoveryDocument {
  protocol_version: string
  provider_name: string
  issuer: string
  default_location: string
  supported_modes: string[]
  endpoints: { register: string; execute: string; list: string; status: string; revoke: string; introspect: string }
  jwks_uri: string
}

/** GET {platformURL}/.well-known/agent-configuration */
export async function discover(platformURL: string): Promise<DiscoveryDocument> {
  const url = new URL("/.well-known/agent-configuration", platformURL)
  const res = await fetch(url, { headers: { accept: "application/json" } })
  if (!res.ok) throw new Error(`gibson-client: discovery failed: ${res.status} ${res.statusText}`)
  return (await res.json()) as DiscoveryDocument
}
