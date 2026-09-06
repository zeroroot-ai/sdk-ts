// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { callGibsonTool, listGibsonPlugins, listGibsonTools, queryGibsonPlugin, type GibsonPlugin, type GibsonSession, type GibsonTool } from "@zeroroot-ai/sdk"
import { z } from "zod"
import { formatToolResult } from "./helpers/tools.js"
import { TAG, type Log } from "./log.js"
import type { ToolDefinition, ToolGroup } from "./registry.js"
import { defineTool } from "./tool.js"

/**
 * Checked-in platform tools and plugins, discovered at runtime.
 *
 * The fleet changes while a session runs: a tool a person enrols now should
 * be callable in the same session. So discovery repeats, and the registry's
 * `tools/list_changed` notification is what tells every attached host to
 * ask again.
 *
 * Each discovered tool registers on its own, named `gibson_<tool>`, so the
 * model sees its description rather than one opaque dispatcher. The catalog
 * carries no JSON Schema, only a proto message type name, so the wrapper
 * takes one free-form `input` object and names the type it must match.
 * `gibson_call_tool` stays registered either way: discovery answers
 * `Unimplemented` on some daemons (gibson#1186).
 */
export const DISCOVERY_INTERVAL_MS = 60_000

/** `gibson_<tool>`, with anything not legal in an MCP tool name replaced. */
export function toolKey(name: string): string {
  return `gibson_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`
}

export function pluginKey(name: string): string {
  return `gibson_plugin_${name.replace(/[^A-Za-z0-9_-]/g, "_")}`
}

export function discoveredTool(session: GibsonSession, t: GibsonTool): ToolDefinition {
  const schemaNote = t.inputMessageType ? ` Input must match the Gibson message type ${t.inputMessageType}.` : ""
  return defineTool({
    name: toolKey(t.name),
    description: `${t.description || `Gibson tool "${t.name}"`}${schemaNote} Runs through the Gibson harness, authorized and metered.`,
    input: {
      input: z.record(z.string(), z.unknown()).describe(`Input object for the ${t.name} tool.`),
      timeout_ms: z.number().int().min(1).optional().describe("Per-call timeout in milliseconds."),
    },
    handler: async (args) =>
      formatToolResult(
        t.name,
        await callGibsonTool(session.clients.component, { name: t.name, input: args.input, ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}) }),
      ),
  })
}

export function discoveredPlugin(session: GibsonSession, p: GibsonPlugin): ToolDefinition {
  const methods = p.methods.length > 0 ? ` Methods: ${p.methods.join(", ")}.` : ""
  return defineTool({
    name: pluginKey(p.name),
    description: `${p.description || `Gibson plugin "${p.name}"`}${methods} Runs through the Gibson harness, authorized and metered.`,
    input: {
      method: z.string().describe(`Method to call on the ${p.name} plugin.`),
      params: z.record(z.string(), z.unknown()).optional().describe("Method parameters."),
    },
    handler: async (args) =>
      formatToolResult(`${p.name}.${args.method}`, await queryGibsonPlugin(session.clients.component, { plugin: p.name, method: args.method, params: args.params ?? {} })),
  })
}

export interface DiscoveryOutcome {
  tools: number
  plugins: number
  /** Set when discovery could not run. The set is unchanged, and nothing failed. */
  note?: string
  /** True when this pass added or removed something. */
  changed: boolean
}

export interface DiscoveryOptions {
  /**
   * Where discovered tools are registered. A group, not the registry, so
   * they leave with the posture that discovered them.
   */
  group: ToolGroup
  session: GibsonSession
  log: Log
  /** How often to look again. `0` runs one pass and stops. */
  intervalMs?: number
}

export interface Discovery {
  /** Run one pass now. */
  refresh(): Promise<DiscoveryOutcome>
  /** Stop polling. Registered tools stay. */
  stop(): void
}

/**
 * Poll the catalog and keep the registered set equal to it.
 *
 * A pass that cannot reach the catalog leaves the set alone. Dropping every
 * discovered tool because one poll failed would take working tools away from
 * a session mid-task over a transient fault.
 */
export function startDiscovery(opts: DiscoveryOptions): Discovery {
  const { group, session, log } = opts
  const interval = opts.intervalMs ?? DISCOVERY_INTERVAL_MS
  const registered = new Map<string, ToolDefinition>()
  let stopped = false
  let timer: ReturnType<typeof setInterval> | undefined

  const refresh = async (): Promise<DiscoveryOutcome> => {
    const [discovery, plugins] = await Promise.all([
      listGibsonTools(session.clients.component),
      listGibsonPlugins(session.clients.component).catch(() => [] as GibsonPlugin[]),
    ])
    if (discovery.unavailable && plugins.length === 0) {
      return { tools: 0, plugins: 0, note: discovery.unavailable, changed: false }
    }
    const wanted = new Map<string, ToolDefinition>()
    for (const t of discovery.tools) wanted.set(toolKey(t.name), discoveredTool(session, t))
    for (const p of plugins) wanted.set(pluginKey(p.name), discoveredPlugin(session, p))

    // Collected before anything is removed: the map is mutated below, and
    // deleting from it mid-iteration skips entries.
    const gone: string[] = []
    for (const name of registered.keys()) {
      if (!wanted.has(name)) gone.push(name)
    }

    let changed = false
    group.batch(() => {
      for (const name of gone) {
        group.remove(name)
        registered.delete(name)
        changed = true
      }
      for (const [name, def] of wanted) {
        if (registered.has(name)) continue
        // A helper or a generated tool already owns this name: leave it be.
        if (group.has(name)) continue
        group.register(def)
        registered.set(name, def)
        changed = true
      }
    })
    return { tools: discovery.tools.length, plugins: plugins.length, ...(discovery.unavailable ? { note: discovery.unavailable } : {}), changed }
  }

  const tick = async (): Promise<void> => {
    if (stopped) return
    try {
      const outcome = await refresh()
      if (outcome.changed) log(`${TAG} discovery: ${outcome.tools} tool(s), ${outcome.plugins} plugin(s) registered`)
    } catch (e) {
      // Keep what is registered: a transient fault must not take working
      // tools away from a session mid-task.
      log(`${TAG} discovery failed, keeping the current set: ${(e as Error).message}`)
    }
  }

  if (interval > 0) {
    timer = setInterval(() => void tick(), interval)
    timer.unref?.()
  }

  return {
    refresh,
    stop: () => {
      stopped = true
      if (timer) clearInterval(timer)
    },
  }
}
