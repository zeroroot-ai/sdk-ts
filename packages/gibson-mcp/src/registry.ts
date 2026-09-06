// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { failure } from "./tools/result.js"

/** A JSON Schema object for a tool's input. MCP requires `type: "object"` at the top. */
export interface JsonSchema {
  type: "object"
  [key: string]: unknown
}

/** What a tool call carries besides its arguments. */
export interface ToolContext {
  /** Request headers of the transport, when it has any (the HTTP transport). */
  headers?: Record<string, string | string[] | undefined>
  signal?: AbortSignal
  /** Per-call deadline, when the caller set one. `gibson_api_call` does. */
  timeoutMs?: number
}

export type ToolHandler = (args: Record<string, unknown>, ctx: ToolContext) => Promise<CallToolResult>

/**
 * Wraps every tool call. The per-turn grant uses one: it reads the request's
 * headers and runs the call under that turn's credential, so a tool built
 * once needs no knowledge of which grant is in force.
 */
export type ToolMiddleware = (ctx: ToolContext, next: () => Promise<CallToolResult>) => Promise<CallToolResult>

export interface ToolAnnotations {
  title?: string
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: JsonSchema
  handler: ToolHandler
  annotations?: ToolAnnotations
}

/**
 * A set of tools that leaves together: one posture, discovery included. A
 * tool registered through a group is dropped by `clear()`, so an upgrade
 * cannot leave a tool behind that points at the previous connection.
 */
export interface ToolGroup {
  register(def: ToolDefinition): void
  /** Remove one tool this group registered. */
  remove(name: string): boolean
  /** Whether ANY tool holds this name, in this group or not. */
  has(name: string): boolean
  /** Coalesce the changes inside `fn` into one notification. */
  batch<T>(fn: () => T): T
  /** Remove every tool this group registered. */
  clear(): void
  names(): string[]
}

/** MCP tool names: letters, digits, underscore, hyphen, at most 64 characters. */
export const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

/**
 * The one tool table every attached MCP server reads. A transport session
 * gets its own protocol `Server`, and all of them list and call the same
 * tools, so a posture change or a discovery pass reaches every session at
 * once through `tools/list_changed`.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, ToolDefinition>()
  private readonly listeners = new Set<() => void>()
  private readonly middleware: ToolMiddleware[] = []
  private batching = 0
  private dirty = false

  register(def: ToolDefinition): void {
    if (!TOOL_NAME.test(def.name)) throw new Error(`tool name ${JSON.stringify(def.name)} is not [A-Za-z0-9_-]{1,64}`)
    if (this.tools.has(def.name)) throw new Error(`tool ${def.name} is already registered`)
    if (!def.description.trim()) throw new Error(`tool ${def.name} has no description`)
    this.tools.set(def.name, def)
    this.changed()
  }

  remove(name: string): boolean {
    const had = this.tools.delete(name)
    if (had) this.changed()
    return had
  }

  has(name: string): boolean {
    return this.tools.has(name)
  }

  get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  /** Every tool, sorted by name so a listing is stable. */
  list(): ToolDefinition[] {
    return [...this.tools.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  }

  size(): number {
    return this.tools.size
  }

  /** Add a wrapper around every tool call. Applied in the order added. */
  use(fn: ToolMiddleware): void {
    this.middleware.push(fn)
  }

  async call(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<CallToolResult> {
    const def = this.tools.get(name)
    if (!def) return failure("unknown tool", `No tool named ${name}. Call tools/list for the current set.`)
    let run = () => def.handler(args, ctx)
    for (let i = this.middleware.length - 1; i >= 0; i -= 1) {
      const fn = this.middleware[i]!
      const inner = run
      run = () => fn(ctx, inner)
    }
    try {
      return await run()
    } catch (e) {
      return failure(`${name} failed`, (e as Error).message)
    }
  }

  group(): ToolGroup {
    const names = new Set<string>()
    return {
      register: (def) => {
        this.register(def)
        names.add(def.name)
      },
      remove: (name) => {
        if (!names.delete(name)) return false
        return this.remove(name)
      },
      has: (name) => this.has(name),
      batch: (fn) => this.batch(fn),
      clear: () => {
        this.batch(() => {
          for (const n of names) this.remove(n)
          names.clear()
        })
      },
      names: () => [...names],
    }
  }

  /** Coalesce every change inside `fn` into one notification. */
  batch<T>(fn: () => T): T {
    this.batching += 1
    try {
      return fn()
    } finally {
      this.batching -= 1
      if (this.batching === 0 && this.dirty) {
        this.dirty = false
        this.notify()
      }
    }
  }

  /** Same as {@link batch}, for async work. */
  async batchAsync<T>(fn: () => Promise<T>): Promise<T> {
    this.batching += 1
    try {
      return await fn()
    } finally {
      this.batching -= 1
      if (this.batching === 0 && this.dirty) {
        this.dirty = false
        this.notify()
      }
    }
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private changed(): void {
    if (this.batching > 0) {
      this.dirty = true
      return
    }
    this.notify()
  }

  private notify(): void {
    for (const fn of this.listeners) fn()
  }
}
