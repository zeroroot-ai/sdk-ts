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
 * Canonicalize the platform URL once, at config ingestion, so discovery and the
 * Connect transport baseUrl see one exact string no matter how the operator
 * wrote GIBSON_PLATFORM_URL (a stray trailing slash would split the base URL
 * two ways).
 *
 * As of gibson#1246 the CG-JWT `aud` is a fixed constant (AUDIENCE_GIBSON_DAEMON),
 * NOT the platform URL, and request binding lives in the `method` claim — so
 * this normalization no longer feeds the audience. It still matters for the
 * transport/discovery base URL.
 */
export function normalizePlatformURL(raw: string): string {
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    throw new Error(
      `gibson-client: platformURL ${JSON.stringify(raw)} is not a valid URL ` +
        "(expected e.g. https://api.zeroroot.ai — check GIBSON_PLATFORM_URL)",
    )
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(
      `gibson-client: platformURL ${JSON.stringify(raw)} must be http(s), got ${parsed.protocol.slice(0, -1)}`,
    )
  }
  return raw.trim().replace(/\/+$/, "")
}

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
  /** Canonical platform URL — the transport/discovery base (no longer the `aud`). */
  readonly platformURL: string

  constructor(private readonly config: CapabilityGrantConfig) {
    this.platformURL = normalizePlatformURL(config.platformURL)
    this.hostKey = loadOrGenerateHostKey(config.hostKeyPath)
  }

  async discoverPlatform(): Promise<DiscoveryDocument> {
    this.discovery = await discover(this.platformURL)
    return this.discovery
  }

  /** Register the host + agent. Returns the FGA component_scope the daemon requires. */
  async register(): Promise<{ agentID: string; componentScope: string }> {
    const doc = this.discovery ?? (await this.discoverPlatform())
    const registerURL = doc.endpoints.register
    if (!registerURL) throw new Error("gibson-client: discovery document has no register endpoint")

    // Check in once, then run unattended (ADR-0045). The daemon routes on the
    // credential type it receives: `host+jwt` means RE-registration — the caller
    // proves possession of an already-registered host key — and anything else is
    // FIRST registration, which requires the one-time, human-issued bootstrap
    // token (gibson `internal/server/daemon/capabilitygrant_register.go:134-155`).
    //
    // So the bootstrap token is used only when this host key was just generated.
    // Once the host has checked in the token is spent, and replaying it would be
    // rejected — an operator should be free to drop it from the environment
    // rather than keep a dead credential around forever.
    const bootstrap = this.hostKey.firstCheckIn
      ? (this.config.bootstrapToken ?? process.env.GIBSON_BOOTSTRAP_TOKEN)
      : undefined
    if (this.hostKey.firstCheckIn && !bootstrap) {
      throw new Error(
        "gibson-client: this host has never checked in and no bootstrap token was supplied. " +
          "Run `gibson login` then `gibson agent enroll` to obtain a one-time token, and pass it " +
          "as bootstrapToken (or GIBSON_BOOTSTRAP_TOKEN) for this first registration only.",
      )
    }
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
        // Bind the token to this exact RPC (gibson#1246). The gRPC method path
        // is "/<service.typeName>/<method.name>" — the same string ext-authz
        // reads from the request `:path`, so the verifier can require a match.
        // The audience is now a fixed constant (AUDIENCE_GIBSON_DAEMON) minted
        // inside signAgentJWT, not the platform URL.
        method: `/${req.service.typeName}/${req.method.name}`,
        componentScope: this.componentScope,
      })
      // The per-RPC agent+jwt travels in a DEDICATED header, not Authorization.
      //
      // The gateway contract (epic unified-cg-identity, "Option A") reserves
      // Authorization for Zitadel user/service tokens: Envoy's jwt_authn
      // validates those and populates x-jwt-payload for ext-authz. A CG token in
      // Authorization is not merely ignored — jwt_authn fails to validate it, no
      // x-jwt-payload is set, and ext-authz rejects the call with
      // "missing x-jwt-payload (Envoy jwt_authn must populate)". Every component
      // RPC 401s at the edge with the daemon never seeing it.
      //
      // Carrying both token types in one header was considered and rejected for
      // exactly this ambiguity. ext-authz reads x-capability-grant, fetches the
      // verifying key by kid from the daemon, verifies the EdDSA signature, then
      // runs per-method FGA.
      req.header.set("x-capability-grant", token)
      return next(req)
    }
  }
}
