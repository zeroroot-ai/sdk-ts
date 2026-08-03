import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

export interface AgentRegistration {
  name: string
  version: string
  capabilities?: string[]
  metadata?: Record<string, string>
}

export interface RegisteredComponent { instanceId: string; heartbeatIntervalMs: number }

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
