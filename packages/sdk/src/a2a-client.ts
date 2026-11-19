// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory, type Client } from "@a2a-js/sdk/client"
import type { AgentCard } from "@a2a-js/sdk"

/**
 * The one place that makes an A2A client for a JSON-RPC interface URL. The
 * delegation client and the inbound client share it. The index does not export
 * this file.
 */

function cardOf(url: string): AgentCard {
  return {
    name: "gibson-a2a",
    description: "",
    supportedInterfaces: [{ url, protocolBinding: "JSONRPC", protocolVersion: "1.0", tenant: "" }],
    provider: undefined,
    version: "",
    capabilities: undefined,
    securitySchemes: {},
    securityRequirements: [],
    defaultInputModes: [],
    defaultOutputModes: [],
    skills: [],
    signatures: [],
  }
}

/** Make an A2A client that sends each JSON-RPC call to `url` with `fetchImpl`. */
export function jsonRpcClient(url: string, fetchImpl: typeof fetch): Promise<Client> {
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      preferredTransports: ["JSONRPC"],
    }),
  )
  return factory.createFromAgentCard(cardOf(url))
}
