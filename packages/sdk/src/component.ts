// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

/**
 * One A2A `AgentSkill`: a capability entry of the Agent Card of an agent. It
 * is NOT an Agent Skill in the SKILL.md format.
 */
export interface CardSkillInput {
  id: string
  name: string
  description?: string
  tags?: string[]
  examples?: string[]
  inputModes?: string[]
  outputModes?: string[]
}

/** The media types of a card when the agent names none. */
export const DEFAULT_CARD_MODES: readonly string[] = ["text/plain", "application/json"]

export interface AgentRegistration {
  name: string
  version: string
  capabilities?: string[]
  metadata?: Record<string, string>
  /** What the Agent Card says about the agent. The fields below apply to `kind` `agent` only. */
  description?: string
  targetTypes?: string[]
  techniqueTypes?: string[]
  /**
   * The skills of the Agent Card. When it is empty, the SDK builds one card
   * skill for each capability: the id and the name are the capability, the
   * description is the description of the agent, and the tags are the target
   * types and the technique types. With no capability, it builds one card skill
   * named after the agent.
   */
  cardSkills?: CardSkillInput[]
  /** The default media types of the card. They default to `text/plain` and `application/json`. */
  defaultInputModes?: string[]
  defaultOutputModes?: string[]
}

/** What the Agent Card of an agent needs at registration. */
export function agentCardOf(reg: AgentRegistration): {
  cardSkills: Required<CardSkillInput>[]
  defaultInputModes: string[]
  defaultOutputModes: string[]
} {
  const tags = [...(reg.targetTypes ?? []), ...(reg.techniqueTypes ?? [])]
  const description = reg.description ?? ""
  const skills: CardSkillInput[] =
    reg.cardSkills && reg.cardSkills.length > 0
      ? reg.cardSkills
      : (reg.capabilities && reg.capabilities.length > 0 ? reg.capabilities : [reg.name]).map((c) => ({
          id: c,
          name: c,
          description,
          tags,
        }))
  return {
    cardSkills: skills.map((k) => ({
      id: k.id,
      name: k.name,
      description: k.description ?? "",
      tags: k.tags ?? [],
      examples: k.examples ?? [],
      inputModes: k.inputModes ?? [],
      outputModes: k.outputModes ?? [],
    })),
    defaultInputModes: reg.defaultInputModes && reg.defaultInputModes.length > 0 ? reg.defaultInputModes : [...DEFAULT_CARD_MODES],
    defaultOutputModes: reg.defaultOutputModes && reg.defaultOutputModes.length > 0 ? reg.defaultOutputModes : [...DEFAULT_CARD_MODES],
  }
}

export interface RegisteredComponent { instanceId: string; heartbeatIntervalMs: number }

/**
 * RegisterComponent under an explicit kind.
 *
 * Kind is not cosmetic — it decides whether the daemon will ever send this
 * component work. For `agent` the registration also sends the fields of the
 * A2A Agent Card: `card_skills` and the default modes.
 */
export async function registerComponentAs(
  component: Client<typeof ComponentService>,
  kind: string,
  reg: AgentRegistration,
): Promise<RegisteredComponent> {
  const res = await component.registerComponent({
    kind,
    name: reg.name,
    version: reg.version,
    capabilities: reg.capabilities ?? [],
    metadata: reg.metadata ?? {},
    ...(kind === "agent" ? agentCardOf(reg) : {}),
  })
  return {
    instanceId: res.instanceId,
    heartbeatIntervalMs: res.heartbeatIntervalMs > 0 ? res.heartbeatIntervalMs : 15_000,
  }
}

/**
 * One process, one component instance.
 *
 * The heartbeat and the work loop are separate timers over the SAME registered
 * instance. When they each held their own id, a re-registration by one left the
 * other pointing at a dead instance: the worker polled instance A while the
 * heartbeat kept instance B alive, so A expired on the daemon's 30s TTL, PollWork
 * answered NotFound, the worker re-registered, and the process spun forever —
 * looking healthy, registered, and invisible to the fleet.
 *
 * InstanceRef is the single identity both share. Renewal is single-flight, so a
 * heartbeat and a poll discovering the loss at the same moment produce one new
 * registration rather than two.
 */
export interface InstanceRef {
  /** The instance id to use right now. */
  current(): string
  /** How often the daemon wants a heartbeat. */
  heartbeatIntervalMs(): number
  /** Re-register and adopt the new id. Concurrent callers share one attempt. */
  renew(): Promise<string>
}

/**
 * Register a component and return the shared identity for it.
 *
 * The kind is captured here and reused on every renewal — re-registering under a
 * different kind than the process serves would silently move it to a queue
 * nothing dispatches to.
 */
export async function registerInstance(
  component: Client<typeof ComponentService>,
  kind: string,
  reg: AgentRegistration,
): Promise<InstanceRef> {
  let registered = await registerComponentAs(component, kind, reg)
  let inFlight: Promise<string> | null = null

  return {
    current: () => registered.instanceId,
    heartbeatIntervalMs: () => registered.heartbeatIntervalMs,
    renew: async () => {
      if (inFlight) return inFlight
      inFlight = (async () => {
        try {
          registered = await registerComponentAs(component, kind, reg)
          return registered.instanceId
        } finally {
          inFlight = null
        }
      })()
      return inFlight
    },
  }
}

/**
 * Periodic heartbeat over the shared instance. Returns a stop fn.
 *
 * A heartbeat the daemon answers with registered=false means the instance is
 * gone; renewing through the shared ref is what keeps the work loop pointing at
 * the same live instance.
 */
export function startHeartbeat(
  component: Client<typeof ComponentService>,
  ref: InstanceRef,
  onError?: (e: unknown) => void,
): () => void {
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const res = await component.heartbeat({ instanceId: ref.current(), healthStatus: "healthy" })
      if (!res.registered) await ref.renew()
    } catch (e) {
      onError?.(e)
    }
  }
  const timer = setInterval(() => void tick(), ref.heartbeatIntervalMs())
  timer.unref?.()
  return () => {
    stopped = true
    clearInterval(timer)
  }
}
