// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { DefaultAgentCardResolver } from "@a2a-js/sdk/client"
import { Role } from "@a2a-js/sdk"
import type { AgentCard, Task as A2ATask } from "@a2a-js/sdk"
import { jsonRpcClient } from "./a2a-client.js"
import { dataPart, newMessage, textPart } from "./a2a.js"
import { GATEWAY_GRANT_HEADER, gatewayFetch } from "./gateway.js"

/**
 * The client of the inbound A2A endpoint of Gibson.
 *
 * An outside program calls a published Gibson agent with A2A (JSON-RPC
 * binding). The call starts a mission from the definition that the tenant
 * published for the agent. The A2A Task shows the state and the findings of
 * that mission.
 *
 * The caller is an enrolled identity ({@link CapabilityGrantClient}). It signs
 * each request with a new Capability Grant JWT that is bound to the path of the
 * request, and it sends the token in the header `x-capability-grant`. A
 * standard A2A client cannot do this, so this client adds the signer.
 *
 * @example
 * const identity = new CapabilityGrantClient({ platformURL, agentName: "my-caller", hostKeyPath })
 * await identity.register()
 * const client = new InboundA2AClient({ baseUrl: platformURL, signer: identity })
 * const card = await client.agentCard("recon")
 * let task = await client.sendMessage("recon", "scan the staging hosts", { targets: ["target-id"] })
 * task = await client.getTask("recon", task.id)
 * task = await client.cancelTask("recon", task.id)
 */

const INBOUND_PREFIX = "/a2a/inbound/"
const CARD_SUFFIX = "/.well-known/agent-card.json"

/** A DNS label. The daemon refuses each other agent name. */
const AGENT_PATTERN = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/

/**
 * The key of the target list in the data part of a message. The list narrows
 * the targets of the published definition. The daemon reads a target from this
 * list only, and never from the text of a message.
 */
export const INBOUND_TARGETS_KEY = "targets"

/**
 * Signs the Capability Grant JWT of one request. The token is bound to the
 * path of the request. A {@link CapabilityGrantClient} is a signer.
 */
export interface PathSigner {
  signPath(path: string): string
}

export interface InboundA2AClientOptions {
  /**
   * The public API origin of the platform, for example
   * `https://api.example.com`. The scheme must be https, because each request
   * carries a credential.
   */
  baseUrl: string
  /** The enrolled identity of the caller. */
  signer: PathSigner
  /**
   * The PEM bundle of the CA of the platform edge. The client then trusts
   * exactly that bundle. With no bundle, the client uses the system roots.
   * There is no option to skip verification.
   */
  caPem?: string
}

export interface InboundCallOptions {
  /** Stops the call. */
  signal?: AbortSignal
}

export interface InboundSendOptions extends InboundCallOptions {
  /**
   * Target IDs that narrow the targets of the published definition. With no
   * target, the mission runs on all targets of the definition.
   */
  targets?: string[]
}

/**
 * The platform refused the caller before the agent saw the request. Status 401
 * reports a token that the platform does not accept, for example the token of a
 * revoked identity. Status 403 reports an identity that is not a caller
 * identity: it does not have the ceiling `mission:originate`, or it holds
 * another capability.
 *
 * A caller with no grant to the agent does not get this error. See
 * {@link InboundA2AClient.sendMessage} and {@link InboundA2AClient.agentCard}.
 */
export class InboundA2ARefusedError extends Error {
  constructor(readonly status: number) {
    super(`gibson-sdk: the platform refused the inbound A2A call with HTTP ${status}`)
    this.name = "InboundA2ARefusedError"
  }
}

export class InboundA2AClient {
  private readonly origin: string
  private readonly fetchImpl: typeof fetch

  /** Make a client. It does not contact the platform. */
  constructor(opts: InboundA2AClientOptions) {
    let url: URL
    try {
      url = new URL(opts.baseUrl)
    } catch (cause) {
      throw new Error(`gibson-sdk: the inbound base URL ${JSON.stringify(opts.baseUrl)} is not a URL`, { cause })
    }
    if (url.protocol !== "https:") {
      throw new Error("gibson-sdk: the inbound A2A client needs an https URL")
    }
    if (url.pathname !== "/" || url.search || url.hash || url.username || url.password) {
      throw new Error("gibson-sdk: the inbound base URL must be an origin with no path, no query and no user")
    }
    this.origin = url.origin
    const signer = opts.signer
    // gatewayFetch follows no redirect, so the client never signs a token for
    // a URL that the caller did not name.
    const send = gatewayFetch({
      baseUrl: this.origin,
      ...(opts.caPem ? { caPem: opts.caPem } : {}),
      // One new token for each request: a token is single use, and it is bound
      // to the path of this request.
      headers: (route) => ({ [GATEWAY_GRANT_HEADER]: signer.signPath(route) }),
    })
    this.fetchImpl = async (input, init) => {
      const res = await send(input, init)
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel()
        throw new InboundA2ARefusedError(res.status)
      }
      return res
    }
  }

  private path(agent: string): string {
    if (!AGENT_PATTERN.test(agent)) {
      throw new Error(`gibson-sdk: the agent name ${JSON.stringify(agent)} is not a DNS label`)
    }
    return INBOUND_PREFIX + agent
  }

  private rpc(agent: string) {
    return jsonRpcClient(this.origin + this.path(agent), this.fetchImpl)
  }

  /**
   * Send a text to a published agent and return the Task of the mission that
   * the message started. The Task id is the handle for {@link getTask} and
   * {@link cancelTask}.
   *
   * A refused message is a value and not an error: the Task has the state
   * rejected, its status message holds the reason, and no mission starts. The
   * platform answers this way for a target outside the definition, for an
   * agent that is not published, and for a caller with no grant to the agent.
   * The last two get the same answer, so a caller cannot tell which agents
   * exist.
   *
   * An {@link InboundA2ARefusedError} means that the platform refused the
   * caller before the agent saw the message.
   */
  async sendMessage(agent: string, text: string, opts: InboundSendOptions = {}): Promise<A2ATask> {
    const client = await this.rpc(agent)
    const parts = [textPart(text)]
    if (opts.targets && opts.targets.length > 0) parts.push(dataPart({ [INBOUND_TARGETS_KEY]: [...opts.targets] }))
    const sent = await client.sendMessage(
      { tenant: "", message: newMessage(Role.ROLE_USER, parts), configuration: undefined, metadata: undefined },
      callOptions(opts),
    )
    if (!("status" in sent)) throw new Error(`gibson-sdk: the answer of the agent ${agent} is a message and not a task`)
    return sent
  }

  /**
   * Return the Task of a mission that this caller started. The Task state is
   * the mission state. A finished Task holds the findings of the mission in its
   * artifacts.
   */
  async getTask(agent: string, id: string, opts: InboundCallOptions = {}): Promise<A2ATask> {
    const client = await this.rpc(agent)
    return await client.getTask({ tenant: "", id }, callOptions(opts))
  }

  /**
   * End a mission that this caller started, and return the Task. The caller
   * needs its grant to the agent at the time of the call. Without the grant,
   * the call throws.
   */
  async cancelTask(agent: string, id: string, opts: InboundCallOptions = {}): Promise<A2ATask> {
    const client = await this.rpc(agent)
    return await client.cancelTask({ tenant: "", id, metadata: undefined }, callOptions(opts))
  }

  /**
   * Return the Agent Card of a published agent. The platform serves a card only
   * to a caller with a grant to the agent. A caller with no grant gets the
   * error of an agent that is not published, so it cannot tell which agents
   * exist. This error is not an {@link InboundA2ARefusedError}.
   */
  async agentCard(agent: string, opts: InboundCallOptions = {}): Promise<AgentCard> {
    const path = this.path(agent) + CARD_SUFFIX
    const fetchImpl: typeof fetch = opts.signal
      ? (input, init) => this.fetchImpl(input, { ...init, signal: opts.signal ?? null })
      : this.fetchImpl
    return await new DefaultAgentCardResolver({ fetchImpl }).resolve(this.origin, path)
  }
}

function callOptions(opts: InboundCallOptions): { signal?: AbortSignal } {
  return opts.signal ? { signal: opts.signal } : {}
}
