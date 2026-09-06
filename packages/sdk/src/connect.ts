// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Transport } from "@connectrpc/connect"
import { createGrpcTransport } from "@connectrpc/connect-node"
import { CapabilityGrantClient, normalizePlatformURL, type CapabilityGrantConfig } from "./auth/client.js"
import { createGibsonClients, type GibsonClients } from "./clients.js"
import { registerInstance, startHeartbeat, type AgentRegistration, type InstanceRef } from "./component.js"

export interface ConnectGibsonConfig extends CapabilityGrantConfig {
  /** Agent identity for RegisterComponent. */
  agent: AgentRegistration
  /** ConnectRPC base URL for the daemon (Envoy edge). Defaults to platformURL. */
  daemonURL?: string
}

export interface GibsonSession {
  /**
   * The authenticated transport the clients ride. Exposed so a caller can
   * create a client for a service this SDK ships no helper for: the
   * generated bindings under `@zeroroot-ai/sdk/gen/*` are the full daemon
   * surface, and `createClient(SomeService, session.transport)` reaches any
   * of them under the same component grant.
   */
  transport: Transport
  clients: GibsonClients
  componentScope: string
  /**
   * The session's agent instance. Prefer this over the snapshot below: it stays
   * correct across a re-registration, which a copied id does not.
   */
  instance: InstanceRef
  /** The instance id at session start. A snapshot — see `instance`. */
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
    // Normalized with the same function that mints the CG-JWT `aud` claim, so
    // the transport target and the token audience can never disagree on the
    // exact string ext-authz pins (issue #7). With no daemonURL override the
    // baseUrl IS the client's canonical platformURL.
    baseUrl: config.daemonURL ? normalizePlatformURL(config.daemonURL) : cg.platformURL,
    interceptors: [cg.authInterceptor()],
  })
  const clients = createGibsonClients(transport)

  // The session's own identity is an agent instance; a process that also serves
  // work registers that kind separately (see registerInstance).
  const instance = await registerInstance(clients.component, "agent", config.agent)
  const stop = startHeartbeat(clients.component, instance)
  return { transport, clients, componentScope, instance, instanceId: instance.current(), stop }
}
