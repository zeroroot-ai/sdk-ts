// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { A2AMessage, A2ATask } from "./a2a.js"
import { delegateToResolvedAgent, type DelegateOptions, type ResolvedAgent } from "./agent-gateway.js"
import type { HeaderFunc } from "./gateway.js"
import { modelClientFrom, type ModelClient, type ResolvedModel } from "./model-client.js"
import type { Usage } from "./openresponses.js"

/**
 * The model and agent calls that both harnesses share: the harness of a
 * dispatched run (callback mode) and the harness of an agent that polls for
 * work (pull mode). The two modes differ in two things only. The RPC that
 * resolves a slot or an agent is on another service, and the grant comes from
 * another place. This file holds the rest once.
 */

/** The two daemon calls. A harness gives its own RPC for each. */
export interface GatewayResolver {
  resolveModel(slot: string): Promise<ResolvedModel>
  resolveAgent(name: string, bankId?: string): Promise<ResolvedAgent>
}

/** The options of `delegate` and `resolveAgent`. */
export interface AgentCallOptions extends DelegateOptions {
  /**
   * Names a bank of always-on agents. The route is then the route of a member
   * of that bank, and `name` is the agent that the bank runs. Unset means an
   * ephemeral agent.
   */
  bankId?: string
}

/** What a harness offers for the model and for delegation. */
export interface GatewayCalls {
  /** Ask the daemon for the model of a slot. It returns the answer as it is. */
  resolveModel(slot: string): Promise<ResolvedModel>
  /** Ask the daemon for the Agent gateway route of an agent. */
  resolveAgent(name: string, opts?: { bankId?: string }): Promise<ResolvedAgent>
  /**
   * Resolve a slot and return the one model client for it. The client sends the
   * grant of the harness on each call and trusts the CA bundle that the daemon
   * sent. The daemon is called one time for each call of `model`. The agent
   * keeps the client for the run.
   */
  model(slot: string, onUsage?: (usage: Usage) => void): Promise<ModelClient>
  /**
   * Send an A2A message to another agent through the Agent gateway and wait for
   * the task to end. It returns the A2A Task. A failed, rejected or canceled
   * Task is a Task, not a thrown error.
   */
  delegate(name: string, msg: A2AMessage, opts?: AgentCallOptions): Promise<A2ATask>
}

/** Build the shared calls from a resolver and a grant source. */
export function gatewayCalls(resolver: GatewayResolver, grantHeaders: HeaderFunc): GatewayCalls {
  return {
    resolveModel: (slot) => resolver.resolveModel(slot),
    resolveAgent: (name, opts) => resolver.resolveAgent(name, opts?.bankId),
    model: async (slot, onUsage) => {
      const resolved = await resolver.resolveModel(slot)
      if (!resolved.model) throw new Error(`resolve model for slot "${slot}": the daemon returned no model`)
      if (!resolved.gatewayUrl) throw new Error(`resolve model for slot "${slot}": the daemon returned no gateway URL`)
      return modelClientFrom(resolved, { headers: grantHeaders, ...(onUsage ? { onUsage } : {}) })
    },
    delegate: async (name, msg, opts = {}) => {
      const { bankId, ...rest } = opts
      const agent = await resolver.resolveAgent(name, bankId)
      return await delegateToResolvedAgent(agent, msg, { headers: grantHeaders, ...rest })
    },
  }
}

/** The fields of a `ResolveModelResponse` of either service. */
export interface ModelReply {
  model: string
  provider: string
  gatewayUrl: string
  routeHeaders: { [key: string]: string }
  contextWindow: number
  maxOutputTokens: number
  gatewayCaPem: string
}

/** The fields of a `ResolveAgentResponse` of either service. */
export interface AgentReply {
  gatewayUrl: string
  routeHeaders: { [key: string]: string }
  gatewayCaPem: string
  agentCardUrl: string
}

/** Copy the reply of `ResolveModel` into the plain shape. The route headers are kept as they are. */
export function resolvedModelOf(r: ModelReply): ResolvedModel {
  return {
    model: r.model,
    provider: r.provider,
    gatewayUrl: r.gatewayUrl,
    routeHeaders: { ...r.routeHeaders },
    contextWindow: r.contextWindow,
    maxOutputTokens: r.maxOutputTokens,
    gatewayCaPem: r.gatewayCaPem,
  }
}

/** Copy the reply of `ResolveAgent` into the plain shape. */
export function resolvedAgentOf(r: AgentReply): ResolvedAgent {
  return {
    gatewayUrl: r.gatewayUrl,
    routeHeaders: { ...r.routeHeaders },
    gatewayCaPem: r.gatewayCaPem,
    agentCardUrl: r.agentCardUrl,
  }
}
