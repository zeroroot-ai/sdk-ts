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

/** Periodic heartbeat; re-registers if the daemon drops us. Returns a stop fn. */
export function startHeartbeat(
  component: Client<typeof ComponentService>,
  reg: AgentRegistration,
  registered: RegisteredComponent,
  onError?: (e: unknown) => void,
): () => void {
  let instanceId = registered.instanceId
  let stopped = false
  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const res = await component.heartbeat({ instanceId, healthStatus: "healthy" })
      if (!res.registered) instanceId = (await registerAgent(component, reg)).instanceId
    } catch (e) {
      onError?.(e)
    }
  }
  const timer = setInterval(() => void tick(), registered.heartbeatIntervalMs)
  timer.unref?.()
  return () => { stopped = true; clearInterval(timer) }
}
