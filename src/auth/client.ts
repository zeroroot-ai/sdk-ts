import type { Interceptor } from "@connectrpc/connect"
import { discover, type DiscoveryDocument } from "./discover.js"
import { generateAgentKey, loadOrGenerateHostKey, publicKeyJWK, type AgentKey, type HostKey } from "./keys.js"
import { signAgentJWT, signHostJWT } from "./jwt.js"

export interface CapabilityGrantConfig {
  /** Base HTTPS URL of the Gibson platform (dashboard). */
  platformURL: string
  agentName: string
  /** "autonomous" | "delegated". Defaults to "autonomous". */
  agentMode?: string
  /** Persistent host-key file (0600), reused across restarts. */
  hostKeyPath: string
  /** Bootstrap API key ("Gibson key"); falls back to GIBSON_BOOTSTRAP_TOKEN. */
  bootstrapToken?: string
}

interface RegistrationResponse { agent_id: string; component_scope: string; capabilities?: unknown[] }

/**
 * Client side of the Gibson Capability Grant Protocol (port of
 * sdk/capabilitygrant; ADR-0045/0036). Discover -> register a persistent host
 * key with the bootstrap API key -> mint short-lived agent+jwt per RPC.
 */
export class CapabilityGrantClient {
  private discovery?: DiscoveryDocument
  private readonly hostKey: HostKey
  private readonly agentKey: AgentKey = generateAgentKey()
  private agentID?: string
  private componentScope?: string

  constructor(private readonly config: CapabilityGrantConfig) {
    this.hostKey = loadOrGenerateHostKey(config.hostKeyPath)
  }

  async discoverPlatform(): Promise<DiscoveryDocument> {
    this.discovery = await discover(this.config.platformURL)
    return this.discovery
  }

  /** Register the host + agent. Returns the FGA component_scope the daemon requires. */
  async register(): Promise<{ agentID: string; componentScope: string }> {
    const doc = this.discovery ?? (await this.discoverPlatform())
    const registerURL = doc.endpoints.register
    if (!registerURL) throw new Error("gibson-client: discovery document has no register endpoint")

    const bootstrap = this.config.bootstrapToken ?? process.env.GIBSON_BOOTSTRAP_TOKEN
    const authHeader = bootstrap ? `Bearer ${bootstrap}` : `Bearer ${signHostJWT(this.hostKey, registerURL)}`

    const res = await fetch(registerURL, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: authHeader },
      body: JSON.stringify({
        host_id: this.hostKey.id,
        agent_name: this.config.agentName,
        agent_mode: this.config.agentMode ?? "autonomous",
        host_key_jwk: publicKeyJWK(this.hostKey.publicKey),
        agent_key_jwk: publicKeyJWK(this.agentKey.publicKey),
      }),
    })
    if (!res.ok) throw new Error(`gibson-client: registration failed: ${res.status} ${res.statusText}`)
    const out = (await res.json()) as RegistrationResponse
    if (!out.component_scope) throw new Error("gibson-client: registration returned no component_scope")

    this.agentID = out.agent_id
    this.componentScope = out.component_scope
    return { agentID: out.agent_id, componentScope: out.component_scope }
  }

  get scope(): string | undefined { return this.componentScope }

  /** Connect interceptor: attach a fresh agent+jwt Bearer to every RPC. */
  authInterceptor(): Interceptor {
    return (next) => async (req) => {
      if (!this.agentID || !this.componentScope) {
        throw new Error("gibson-client: call register() before making RPCs")
      }
      const token = signAgentJWT(this.agentKey, {
        hostID: this.hostKey.id,
        agentID: this.agentID,
        audience: this.config.platformURL,
        componentScope: this.componentScope,
      })
      req.header.set("authorization", `Bearer ${token}`)
      return next(req)
    }
  }
}
