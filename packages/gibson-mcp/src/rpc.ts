// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { create, fromJson, toJson, type DescMessage, type DescMethod, type DescService, type JsonValue } from "@bufbuild/protobuf"
import { createClient, type Transport } from "@connectrpc/connect"
import type { TaskHarness } from "@zeroroot-ai/sdk"
import { GENERATED_SERVICES } from "./generated/tools.js"
import type { JsonSchema, ToolContext, ToolDefinition } from "./registry.js"
import { requestSchema } from "./schema.js"
import { failure, json } from "./tools/result.js"

/**
 * One tool per RPC of every service the SDK produces (gibson#1706, decision
 * 2). No curated subset and no hand-written list: the table comes from the
 * descriptors, so an SDK bump moves the tool set.
 *
 * Naming is `<service>_<method>` in snake case, e.g.
 * `harness_callback_service_world_view`. The service prefix is what keeps
 * these apart from the helper tools, which are named after the helper
 * (`world_view`, `remember`, `submit_finding`).
 *
 * COVERAGE IS NOT EXPOSURE. Every one of these is built, and the drift guard
 * proves the set is 1:1 with the descriptors. Whether they appear in
 * `tools/list` is a separate decision, taken in build.ts: by default they sit
 * behind `gibson_api_search` and `gibson_api_call` (sdk-ts#70), because 188
 * descriptions on every turn bury the tools an agent reaches for.
 * `--expose-all-rpcs` puts them in front as well.
 */

/** Where an RPC is reached. */
export interface RpcChannels {
  /**
   * The component's own transport, from the check-in. Absent in a dispatched
   * run, which holds only a task grant.
   */
  session?: Transport
  /** The task-scoped callback harness. Absent in the component posture. */
  task?: TaskHarness
}

/** The fully-qualified name of the context message every callback RPC carries. */
export const CONTEXT_INFO = "gibson.harness.v1.ContextInfo"

/** The proto package whose services are served on the callback endpoint. */
const CALLBACK_PACKAGE = "gibson.harness.v1."

/**
 * `LLMCompleteWithTools` -> `llm_complete_with_tools`. An acronym run stays
 * one word, so `LLMComplete` is not `l_l_m_complete`.
 */
export function snake(name: string): string {
  return name
    .replace(/([A-Za-z0-9])([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
}

export function toolNameFor(service: DescService, method: DescMethod): string {
  return `${snake(service.name)}_${snake(method.name)}`
}

/**
 * Which transport an RPC rides.
 *
 * A `gibson.harness.v1` RPC is a callback: it belongs on the task harness,
 * under the grant of the dispatch it serves. Everything else is the daemon's
 * own surface and rides the component transport. Either one may be absent,
 * so each falls back to the other rather than losing the tool: a dispatched
 * run has no component transport, and the callback endpoint is the same
 * daemon.
 */
export function transportFor(service: DescService, channels: RpcChannels): Transport | undefined {
  const callback = service.typeName.startsWith(CALLBACK_PACKAGE)
  const preferred = callback ? channels.task?.transport : channels.session
  return preferred ?? (callback ? channels.session : channels.task?.transport)
}

/** The `context` field a callback request carries, when it has one. */
function contextField(input: DescMessage): string | undefined {
  const field = input.fields.find((f) => f.fieldKind === "message" && f.message.typeName === CONTEXT_INFO)
  return field?.jsonName
}

function describe(service: DescService, method: DescMethod, comment: string, streamLimit: number): string {
  const head = `${service.name}.${method.name}`
  const body = comment || `No comment in the proto for this RPC of ${service.typeName}.`
  const tail =
    method.methodKind === "server_streaming"
      ? ` Server-streaming: returns up to ${streamLimit} messages as a JSON array, with truncated: true when the limit was reached.`
      : method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming"
        ? " Takes an array of request messages in `requests`."
        : ""
  return `${head}: ${body}${tail}`
}

/** The input schema, which for a streaming-request RPC wraps the messages in an array. */
function inputSchemaFor(method: DescMethod): JsonSchema {
  const body = requestSchema(method.input)
  if (method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming") {
    return {
      type: "object",
      properties: { requests: { type: "array", items: body, description: `Request messages of type ${method.input.typeName}.` } },
      required: ["requests"],
    }
  }
  return body
}

async function collect(stream: AsyncIterable<unknown>, output: DescMessage, limit: number): Promise<{ messages: JsonValue[]; truncated: boolean }> {
  const messages: JsonValue[] = []
  for await (const message of stream) {
    if (messages.length >= limit) return { messages, truncated: true }
    messages.push(toJson(output, message as never))
  }
  return { messages, truncated: false }
}

export interface RpcToolOptions {
  channels: RpcChannels
  /** Messages a server-streaming RPC returns before it truncates. */
  streamLimit: number
}

/** One built RPC tool, with the descriptor facts a search can rank on. */
export interface RpcEntry {
  tool: ToolDefinition
  service: DescService
  method: DescMethod
  /** The RPC's proto comment, or "" when it carries none. */
  comment: string
}

/**
 * Build every RPC tool that has a transport to ride.
 *
 * A posture with neither transport (standalone) gets none: an RPC tool with
 * no daemon behind it would answer every call with a dial error, which reads
 * to a model like a broken platform rather than an unconnected session.
 */
export function rpcCatalog(opts: RpcToolOptions): RpcEntry[] {
  const out: RpcEntry[] = []
  for (const entry of GENERATED_SERVICES) {
    const service = entry.service as DescService
    const transport = transportFor(service, opts.channels)
    if (!transport) continue
    const comments = new Map(entry.methods.map((m) => [m.method, m.description]))
    // The descriptor is the source of truth for what exists; the generated
    // table only supplies the prose. A method the table has not seen still
    // becomes a tool, and the drift test is what says the table is stale.
    const client = createClient(service, transport) as unknown as Record<string, (...args: unknown[]) => unknown>
    for (const method of service.methods) {
      const comment = comments.get(method.localName) ?? ""
      out.push({ tool: rpcTool(service, method, client, comment, opts), service, method, comment })
    }
  }
  return out
}

/** The same set as {@link rpcCatalog}, as bare tool definitions. */
export function rpcTools(opts: RpcToolOptions): ToolDefinition[] {
  return rpcCatalog(opts).map((e) => e.tool)
}

function rpcTool(
  service: DescService,
  method: DescMethod,
  client: Record<string, (...args: unknown[]) => unknown>,
  comment: string,
  opts: RpcToolOptions,
): ToolDefinition {
  const contextKey = contextField(method.input)
  const streaming = method.methodKind === "client_streaming" || method.methodKind === "bidi_streaming"
  return {
    name: toolNameFor(service, method),
    description: describe(service, method, comment, opts.streamLimit),
    inputSchema: inputSchemaFor(method),
    handler: async (args, ctx) => decode(service, method, client, contextKey, streaming, args, ctx, opts),
  }
}

async function decode(
  service: DescService,
  method: DescMethod,
  client: Record<string, (...args: unknown[]) => unknown>,
  contextKey: string | undefined,
  streaming: boolean,
  args: Record<string, unknown>,
  ctx: ToolContext,
  opts: RpcToolOptions,
) {
  const fill = (raw: Record<string, unknown>): Record<string, unknown> => {
    // Every callback RPC resolves the harness from ContextInfo and refuses a
    // request without one. The grant already names the mission and the task,
    // so the server fills it when the caller left it out; a caller that sets
    // it keeps what it wrote.
    if (!contextKey || raw[contextKey] || !opts.channels.task) return raw
    return { ...raw, [contextKey]: { ...opts.channels.task.context } }
  }
  let messages: unknown[]
  try {
    if (streaming) {
      const list = args.requests
      if (!Array.isArray(list)) return failure(`${method.name} needs requests`, "This RPC takes a stream of requests. Pass them as an array in `requests`.")
      messages = list.map((raw) => fromJson(method.input, fill(raw as Record<string, unknown>) as JsonValue))
    } else {
      messages = [fromJson(method.input, fill(args) as JsonValue)]
    }
  } catch (e) {
    return failure(`${method.name}: invalid request`, `${(e as Error).message}\n\nThe request must be canonical protojson for ${method.input.typeName}.`)
  }

  const call = client[method.localName]
  if (!call) return failure(`${method.name} is unavailable`, `The generated client for ${service.typeName} has no ${method.localName}.`)
  const options = { signal: ctx.signal, ...(ctx.timeoutMs ? { timeoutMs: ctx.timeoutMs } : {}) }
  if (method.methodKind === "unary") {
    const res = await call(messages[0], options)
    return json(toJson(method.output, res as never))
  }
  if (method.methodKind === "server_streaming") {
    const { messages: out, truncated } = await collect(call(messages[0], options) as AsyncIterable<unknown>, method.output, opts.streamLimit)
    return json({ messages: out, truncated })
  }
  // Client-streaming and bidi both take the requests as an async iterable.
  const source = (async function* () {
    for (const m of messages) yield m
  })()
  if (method.methodKind === "client_streaming") {
    const res = await call(source, options)
    return json(toJson(method.output, res as never))
  }
  const { messages: out, truncated } = await collect(call(source, options) as AsyncIterable<unknown>, method.output, opts.streamLimit)
  return json({ messages: out, truncated })
}

/** An empty request message, for a test that needs one. */
export function emptyRequest(method: DescMethod): unknown {
  return create(method.input)
}

/** What the generated table says about one service. */
export interface ServiceDoc {
  service: DescService
  methods: { method: string; description: string }[]
}

/** What a drift comparison found. Empty on both sides means no drift. */
export interface Drift {
  /** RPCs the descriptors have and the table does not. */
  missing: string[]
  /** Entries the table has and the descriptors do not. */
  extra: string[]
}

/**
 * Compare a generated table against the descriptors it claims to describe.
 *
 * The guard and its test both call this, so what CI enforces and what the
 * test proves are one function rather than two spellings of one intention.
 */
export function driftBetween(table: ServiceDoc[]): Drift {
  const missing: string[] = []
  const extra: string[] = []
  for (const entry of table) {
    const declared = new Set(entry.methods.map((m) => m.method))
    const real = new Set(entry.service.methods.map((m) => m.localName))
    for (const name of real) {
      if (!declared.has(name)) missing.push(`${entry.service.typeName}.${name}`)
    }
    for (const name of declared) {
      if (!real.has(name)) extra.push(`${entry.service.typeName}.${name}`)
    }
  }
  return { missing: missing.sort(), extra: extra.sort() }
}
