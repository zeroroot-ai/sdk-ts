import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

/**
 * Gibson tools and plugins through the harness (zerocool-plugins#9).
 *
 * Every call is authz'd and metered server-side: `CallTool` discovers the tool in
 * the tenant registry (with a `_system` fallback), enqueues a work item and waits
 * for the result — gibson `internal/platform/component/service.go:1360`. A caller
 * never reaches a tool directly.
 *
 * DAEMON STATE: `CallTool` and `QueryPlugin` are wired and work today.
 * `ListTools` needs the `componentLister` seam, which the daemon never wires, so
 * discovery answers `Unimplemented` — gibson#1186. {@link listGibsonTools}
 * surfaces that as an empty list plus a reason rather than throwing, so a caller
 * degrades to "no Gibson tools" instead of failing to start.
 */

/** A tool registered in the tenant's fleet. Mirrors `ToolDescriptorProto`. */
export interface GibsonTool {
  name: string
  version: string
  description: string
  tags: string[]
  /**
   * Fully-qualified proto message type of the tool's input, e.g.
   * "gibson.tool.v1.ScanRequest". This is the ONLY schema information the
   * catalog carries — there is no JSON Schema on this path — so a caller that
   * needs to build input has to know the tool's contract or ask the tool.
   */
  inputMessageType: string
  /** Fully-qualified proto message type of the tool's output. */
  outputMessageType: string
}

export interface ToolDiscovery {
  tools: GibsonTool[]
  /** Set when discovery could not run; the tool list is empty but nothing failed. */
  unavailable?: string
}

/**
 * List the tools visible to the caller's tenant.
 *
 * Returns `{tools: [], unavailable}` when the daemon has no component lister
 * wired (gibson#1186) — that is a platform state, not a caller error, and a
 * coding agent must still start without Gibson tools.
 */
export async function listGibsonTools(
  component: Client<typeof ComponentService>,
  workId = "",
): Promise<ToolDiscovery> {
  try {
    const res = await component.listTools({ workId })
    return {
      tools: res.tools.map((t) => ({
        name: t.name,
        version: t.version,
        description: t.description,
        tags: t.tags,
        inputMessageType: t.inputMessageType,
        outputMessageType: t.outputMessageType,
      })),
    }
  } catch (e) {
    if (isUnimplemented(e)) {
      return { tools: [], unavailable: "the daemon has no component lister wired (gibson#1186)" }
    }
    throw e
  }
}

export interface CallToolOptions {
  /** Registered tool name. */
  name: string
  /** Input matching the tool's input message type; JSON-encoded on the wire. */
  input: unknown
  /** Per-call timeout. The daemon defaults to 5 minutes when this is 0. */
  timeoutMs?: number
  workId?: string
}

export interface ToolCallResult {
  /** Decoded tool output. `undefined` when the tool returned nothing. */
  output: unknown
  /** Structured error from the tool or the harness; absent on success. */
  error?: { code: string; message: string; retryable: boolean }
}

/**
 * Invoke a Gibson tool through the harness.
 *
 * A tool that fails returns a populated `error` rather than throwing — the
 * harness reports tool failure in-band (`CallToolResponse.error`), and an agent
 * loop wants to read that as a result, not catch it.
 */
export async function callGibsonTool(
  component: Client<typeof ComponentService>,
  opts: CallToolOptions,
): Promise<ToolCallResult> {
  const res = await component.callTool({
    workId: opts.workId ?? "",
    toolName: opts.name,
    inputJson: JSON.stringify(opts.input ?? {}),
    timeoutMs: BigInt(opts.timeoutMs ?? 0),
  })
  return {
    output: parseMaybeJSON(res.outputJson),
    ...(res.error
      ? { error: { code: res.error.code, message: res.error.message, retryable: res.error.retryable } }
      : {}),
  }
}

export interface QueryPluginOptions {
  /** Registered plugin name. */
  plugin: string
  /** Plugin method to invoke. */
  method: string
  /** Method parameters; JSON-encoded on the wire. */
  params?: unknown
  timeoutMs?: number
  workId?: string
}

/** Invoke a method on an enabled Gibson plugin through the harness. */
export async function queryGibsonPlugin(
  component: Client<typeof ComponentService>,
  opts: QueryPluginOptions,
): Promise<ToolCallResult> {
  const res = await component.queryPlugin({
    workId: opts.workId ?? "",
    pluginName: opts.plugin,
    method: opts.method,
    paramsJson: JSON.stringify(opts.params ?? {}),
    timeoutMs: BigInt(opts.timeoutMs ?? 0),
  })
  return {
    output: parseMaybeJSON(res.resultJson),
    ...(res.error
      ? { error: { code: res.error.code, message: res.error.message, retryable: res.error.retryable } }
      : {}),
  }
}

/** A plugin in the tenant's catalog, with its enablement state. */
export interface GibsonPlugin {
  name: string
  version: string
  description: string
  methods: string[]
  /** JSON Schema for the plugin's configuration surface, when it declares one. */
  configSchemaJson: string
  enabled: boolean
  configured: boolean
  healthStatus: string
}

/** List every plugin in the catalog, annotated with this tenant's enablement. */
export async function listGibsonPlugins(
  component: Client<typeof ComponentService>,
): Promise<GibsonPlugin[]> {
  const res = await component.listAvailablePlugins({})
  return res.plugins.map((p) => ({
    name: p.name,
    version: p.version,
    description: p.description,
    methods: p.methods,
    configSchemaJson: p.configSchemaJson,
    enabled: p.enabled,
    configured: p.configured,
    healthStatus: p.healthStatus,
  }))
}

/**
 * Decode a `*_json` string field. Tools are free to return a bare string, so a
 * parse failure yields the raw text rather than an error.
 */
export function parseMaybeJSON(raw: string): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return raw
  }
}

/** True when a ConnectRPC error carries gRPC status `unimplemented` (code 12). */
export function isUnimplemented(e: unknown): boolean {
  const code = (e as { code?: unknown } | undefined)?.code
  return code === "unimplemented" || code === 12
}
