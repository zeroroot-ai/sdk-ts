import { createGrpcTransport } from "@connectrpc/connect-node"
import { CapabilityGrantClient, type CapabilityGrantConfig } from "./auth/client.js"
import { createGibsonClients, type GibsonClients } from "./clients.js"
import { registerAgent, startHeartbeat, type AgentRegistration } from "./component.js"

export interface ConnectGibsonConfig extends CapabilityGrantConfig {
  /** Agent identity for RegisterComponent. */
  agent: AgentRegistration
  /** ConnectRPC base URL for the daemon (Envoy edge). Defaults to platformURL. */
  daemonURL?: string
}

export interface GibsonSession {
  clients: GibsonClients
  componentScope: string
  instanceId: string
  stop(): void
}

/**
 * Depth-1 wiring (zerocool#4/#5): Capability Grant auth -> Connect transport ->
 * RegisterComponent -> heartbeat. The agent keeps its own loop; this only makes
 * it a registered Gibson component that can call the harness.
 */
export async function connectGibson(config: ConnectGibsonConfig): Promise<GibsonSession> {
  const cg = new CapabilityGrantClient(config)
  const { componentScope } = await cg.register()

  // NATIVE gRPC, not the Connect protocol.
  //
  // The daemon's public surface is a gRPC server behind Envoy, and Envoy carries
  // no grpc_web filter — so a Connect-protocol request reaches the upstream and
  // comes back 415 Unsupported Media Type, after passing auth. That is a
  // confusing place to fail: the credential was accepted and the RPC still died,
  // which reads like a server fault rather than a client protocol choice.
  const transport = createGrpcTransport({
    baseUrl: config.daemonURL ?? config.platformURL,
    interceptors: [cg.authInterceptor()],
  })
  const clients = createGibsonClients(transport)

  const registered = await registerAgent(clients.component, config.agent)
  const stop = startHeartbeat(clients.component, config.agent, registered)
  return { clients, componentScope, instanceId: registered.instanceId, stop }
}
