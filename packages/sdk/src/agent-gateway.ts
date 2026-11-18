// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { ClientFactory, ClientFactoryOptions, JsonRpcTransportFactory } from "@a2a-js/sdk/client"
import { Role, TaskState } from "@a2a-js/sdk"
import type { AgentCard, Message as A2AMessage, Task as A2ATask } from "@a2a-js/sdk"
import { gatewayFetch, type HeaderFunc } from "./gateway.js"

/**
 * Delegation to another agent through the Agent gateway, over A2A.
 *
 * The agent resolves the other agent by name with `ResolveAgent`. The daemon
 * answers with the JSON-RPC interface URL of the agent on the Agent gateway.
 * The SDK then sends one A2A message and waits for the task to end.
 */

/**
 * What the daemon tells the agent about another agent. It is the shape of
 * `ResolveAgentResponse`.
 */
export interface ResolvedAgent {
  /** The JSON-RPC interface URL of the agent on the Agent gateway. */
  gatewayUrl: string
  /** The client sends each one unchanged. */
  routeHeaders: Record<string, string>
  /** The PEM bundle of the private CA of the Agent gateway. Same rule as the model gateway. */
  gatewayCaPem: string
  /** The Agent Card of the agent on the gateway. */
  agentCardUrl: string
}

export interface DelegateOptions {
  /** Adds the headers of each call. The task grant goes in `x-capability-grant`. */
  headers?: HeaderFunc
  /** The time between two `GetTask` calls while the task runs. Default 1000 ms. */
  pollIntervalMs?: number
  /** Stops the wait. */
  signal?: AbortSignal
}

/** The default time between two `GetTask` calls. */
export const DELEGATE_POLL_INTERVAL_MS = 1000

/**
 * Whether the caller has nothing more to wait for. A task is settled when it
 * is in a terminal state, or when it needs input or authorization from the
 * caller.
 */
export function isSettled(state: TaskState): boolean {
  switch (state) {
    case TaskState.TASK_STATE_COMPLETED:
    case TaskState.TASK_STATE_FAILED:
    case TaskState.TASK_STATE_CANCELED:
    case TaskState.TASK_STATE_REJECTED:
    case TaskState.TASK_STATE_INPUT_REQUIRED:
    case TaskState.TASK_STATE_AUTH_REQUIRED:
      return true
    default:
      return false
  }
}

function cardOf(url: string): AgentCard {
  return {
    name: "gibson-delegate",
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

/** Wrap the plain reply of an agent that made no task. */
function taskOfMessage(m: A2AMessage): A2ATask {
  return {
    id: m.taskId || crypto.randomUUID(),
    contextId: m.contextId || crypto.randomUUID(),
    status: { state: TaskState.TASK_STATE_COMPLETED, message: m, timestamp: new Date().toISOString() },
    artifacts: [],
    history: [],
    metadata: undefined,
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason)
    const t = setTimeout(resolve, ms)
    signal?.addEventListener("abort", () => {
      clearTimeout(t)
      reject(signal.reason)
    }, { once: true })
  })
}

/**
 * Send one A2A message to an agent through the Agent gateway (JSON-RPC
 * binding) and wait for the task to end. It returns the A2A Task.
 *
 * The call sends the route headers unchanged and the grant of the agent in
 * `x-capability-grant`. It trusts exactly the CA bundle of the gateway, as the
 * model client does.
 *
 * The wait ends when the task is in a terminal state, or when it needs input
 * or authorization from the caller (input-required, auth-required). An agent
 * that answers with a plain message and no task gets a Task in the completed
 * state that holds the message as its status message. A failed, rejected or
 * canceled Task is a Task. It is not a thrown error.
 *
 * The SDK sets `messageId` and `role` when the caller leaves them empty. The
 * caller sets `taskId` to continue a task.
 */
export async function delegateToResolvedAgent(
  agent: ResolvedAgent,
  msg: A2AMessage,
  opts: DelegateOptions = {},
): Promise<A2ATask> {
  if (!agent.gatewayUrl) throw new Error("delegate: the daemon returned no gateway URL for the agent")
  const fetchImpl = gatewayFetch({
    baseUrl: agent.gatewayUrl,
    caPem: agent.gatewayCaPem,
    fixedHeaders: agent.routeHeaders,
    ...(opts.headers ? { headers: opts.headers } : {}),
  })
  const factory = new ClientFactory(
    ClientFactoryOptions.createFrom(ClientFactoryOptions.default, {
      transports: [new JsonRpcTransportFactory({ fetchImpl })],
      preferredTransports: ["JSONRPC"],
    }),
  )
  const client = await factory.createFromAgentCard(cardOf(agent.gatewayUrl))
  const message: A2AMessage = {
    ...msg,
    messageId: msg.messageId || crypto.randomUUID(),
    role: msg.role === Role.ROLE_UNSPECIFIED ? Role.ROLE_USER : msg.role,
  }
  const reqOpts = opts.signal ? { signal: opts.signal } : {}
  const sent = await client.sendMessage({ tenant: "", message, configuration: undefined, metadata: undefined }, reqOpts)
  if (!("status" in sent)) return taskOfMessage(sent)
  let task: A2ATask = sent
  while (!isSettled(task.status?.state ?? TaskState.TASK_STATE_UNSPECIFIED)) {
    await sleep(opts.pollIntervalMs ?? DELEGATE_POLL_INTERVAL_MS, opts.signal)
    task = await client.getTask({ tenant: "", id: task.id }, reqOpts)
  }
  return task
}
