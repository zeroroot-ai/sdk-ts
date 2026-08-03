import { createConnectTransport } from "@connectrpc/connect-node"
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

  const transport = createConnectTransport({
    baseUrl: config.daemonURL ?? config.platformURL,
    httpVersion: "2",
    interceptors: [cg.authInterceptor()],
  })
  const clients = createGibsonClients(transport)

  const registered = await registerAgent(clients.component, config.agent)
  const stop = startHeartbeat(clients.component, config.agent, registered)
  return { clients, componentScope, instanceId: registered.instanceId, stop }
}
