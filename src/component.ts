import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

export interface AgentRegistration {
  name: string
  version: string
  capabilities?: string[]
  metadata?: Record<string, string>
}

export interface RegisteredComponent { instanceId: string; heartbeatIntervalMs: number }

/**
 * RegisterComponent under an explicit kind.
 *
 * Kind is not cosmetic — it decides whether the daemon will ever send this
 * component work. The harness enqueues for `tool` and `plugin`; agent mission
 * nodes resolve against an in-process registry and never reach the work queue
 * (gibson#1197). Register as `tool` to serve mission nodes.
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
  })
  return {
    instanceId: res.instanceId,
    heartbeatIntervalMs: res.heartbeatIntervalMs > 0 ? res.heartbeatIntervalMs : 15_000,
  }
}

/** RegisterComponent as kind="agent". */
export async function registerAgent(
  component: Client<typeof ComponentService>,
  reg: AgentRegistration,
): Promise<RegisteredComponent> {
  const res = await component.registerComponent({
    kind: "agent",
    name: reg.name,
    version: reg.version,
    capabilities: reg.capabilities ?? [],
    metadata: reg.metadata ?? {},
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
