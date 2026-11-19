// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * The Open Responses items and the request and response shapes.
 *
 * Open Responses is the open specification at https://www.openresponses.org.
 * The conversation of an agent is a list of items. An item is a message, a
 * function call, the output of a function call, or a reasoning record. The
 * agent holds these items from the first message to the last tool result and
 * sends them as they are.
 *
 * The types use the field names of the specification, for example `call_id`
 * and `encrypted_content`. The request body that this module builds is equal
 * to the body that the Go SDK builds (`openresponses` package). The golden
 * files in `src/testdata/openresponses` pin that.
 *
 * There is no code for a model provider here. The gateway does the conversion
 * to the provider.
 */

/** Item type names of the specification. */
export const ItemType = {
  Message: "message",
  FunctionCall: "function_call",
  FunctionCallOutput: "function_call_output",
  Reasoning: "reasoning",
} as const

/** Content part type names of the specification. */
export const PartType = {
  InputText: "input_text",
  OutputText: "output_text",
  Refusal: "refusal",
} as const

/** Role names of a message. */
export type MessageRole = "user" | "assistant" | "system" | "developer"

/** Status names of an item and of a response. */
export type Status = "in_progress" | "incomplete" | "completed" | "failed"

/** A text part of an input message. */
export interface InputTextPart {
  type: "input_text"
  text: string
}

/** A text part of a message of the model. */
export interface OutputTextPart {
  type: "output_text"
  text: string
  /** The annotations of the model, unchanged. */
  annotations?: unknown[]
}

/** A part in which the model refuses to answer. */
export interface RefusalPart {
  type: "refusal"
  refusal: string
}

/**
 * A part of a type that this module has no interface for, for example an
 * image. It keeps its JSON as it came, so a round trip loses nothing.
 */
export interface RawPart {
  type: string
  [key: string]: unknown
}

/** One part of a message. */
export type ContentPart = InputTextPart | OutputTextPart | RefusalPart | RawPart

/** A message of a user, the system, or the model. */
export interface MessageItem {
  type: "message"
  /** Set on a message of the model. Absent on an input message. */
  id?: string
  role: MessageRole
  status?: Status
  content: ContentPart[]
}

/** A request of the model to run a function. */
export interface FunctionCallItem {
  type: "function_call"
  id?: string
  status?: Status
  /** Links the call to its function_call_output. */
  call_id: string
  name: string
  /** A JSON string. */
  arguments: string
}

/** The result of a function call. The agent sends it back to the model. */
export interface FunctionCallOutputItem {
  type: "function_call_output"
  id?: string
  call_id: string
  /** A string. A structured result is JSON text. */
  output: string
}

/** A text part of a reasoning summary or of reasoning content. */
export interface ReasoningTextPart {
  type: string
  text: string
}

/** A reasoning record of the model. */
export interface ReasoningItem {
  type: "reasoning"
  id?: string
  status?: Status
  summary: ReasoningTextPart[]
  content?: ReasoningTextPart[]
  /** Opaque. The agent sends it back unchanged. */
  encrypted_content?: string
}

/**
 * An item of a type that this module has no interface for. It keeps its JSON
 * as it came.
 */
export interface RawItem {
  type: string
  [key: string]: unknown
}

/** One element of the conversation. */
export type Item = MessageItem | FunctionCallItem | FunctionCallOutputItem | ReasoningItem | RawItem

/** Whether the item is a message. */
export function isMessage(item: Item): item is MessageItem {
  return item.type === ItemType.Message
}

/** Whether the item is a function call. */
export function isFunctionCall(item: Item): item is FunctionCallItem {
  return item.type === ItemType.FunctionCall
}

/** Whether the item is the output of a function call. */
export function isFunctionCallOutput(item: Item): item is FunctionCallOutputItem {
  return item.type === ItemType.FunctionCallOutput
}

/** Whether the item is a reasoning record. */
export function isReasoning(item: Item): item is ReasoningItem {
  return item.type === ItemType.Reasoning
}

/** Make a user message with one text part. */
export function userMessage(text: string): MessageItem {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] }
}

/** Make a system message with one text part. */
export function systemMessage(text: string): MessageItem {
  return { type: "message", role: "system", content: [{ type: "input_text", text }] }
}

/** Make a message of the model with one text part. */
export function assistantMessage(text: string): MessageItem {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text, annotations: [] }] }
}

/** Make the output item for a function call. */
export function functionCallOutput(callId: string, output: string): FunctionCallOutputItem {
  return { type: "function_call_output", call_id: callId, output }
}

/** Return the text of each text part of a message, joined in order. */
export function messageText(message: MessageItem): string {
  let out = ""
  for (const part of message.content) {
    if (part.type === PartType.InputText || part.type === PartType.OutputText) {
      out += String((part as { text?: unknown }).text ?? "")
    }
  }
  return out
}

function omitUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}

function serializePart(part: ContentPart): ContentPart {
  if (part.type === PartType.OutputText) {
    const p = part as OutputTextPart
    return { type: "output_text", text: p.text, annotations: p.annotations ?? [] }
  }
  return part
}

/**
 * Return the JSON form of an item for a request. It adds the fields that the
 * specification requires and that the Go SDK always writes: `annotations` on
 * an output text part and `summary` on a reasoning record. An item of an
 * unknown type goes out as it came.
 */
export function serializeItem(item: Item): Item {
  switch (item.type) {
    case ItemType.Message: {
      const m = item as MessageItem
      return omitUndefined({
        type: "message",
        id: m.id || undefined,
        role: m.role,
        status: m.status || undefined,
        content: (m.content ?? []).map(serializePart),
      })
    }
    case ItemType.FunctionCall: {
      const f = item as FunctionCallItem
      return omitUndefined({
        type: "function_call",
        id: f.id || undefined,
        status: f.status || undefined,
        call_id: f.call_id,
        name: f.name,
        arguments: f.arguments,
      })
    }
    case ItemType.FunctionCallOutput: {
      const o = item as FunctionCallOutputItem
      return omitUndefined({
        type: "function_call_output",
        id: o.id || undefined,
        call_id: o.call_id,
        output: o.output,
      })
    }
    case ItemType.Reasoning: {
      const r = item as ReasoningItem
      return omitUndefined({
        type: "reasoning",
        id: r.id || undefined,
        status: r.status || undefined,
        summary: r.summary ?? [],
        content: r.content && r.content.length > 0 ? r.content : undefined,
        encrypted_content: r.encrypted_content || undefined,
      })
    }
    default:
      return item
  }
}

/**
 * Decode one item of a response or of a stream event. An item of an unknown
 * type is returned as it came. A plain string as the content of a message
 * becomes one text part. A function call output that is not a string becomes
 * its JSON text.
 */
export function parseItem(raw: unknown): Item {
  if (raw === null || typeof raw !== "object" || typeof (raw as { type?: unknown }).type !== "string") {
    throw new Error("openresponses: decode item: the item has no type")
  }
  const item = raw as RawItem
  switch (item.type) {
    case ItemType.Message: {
      const content = item.content
      let parts: ContentPart[] = []
      if (typeof content === "string") {
        parts = [item.role === "assistant" ? { type: "output_text", text: content } : { type: "input_text", text: content }]
      } else if (Array.isArray(content)) {
        parts = content as ContentPart[]
      }
      return { ...(item as unknown as MessageItem), content: parts }
    }
    case ItemType.FunctionCallOutput: {
      const output = item.output
      return {
        ...(item as unknown as FunctionCallOutputItem),
        output: typeof output === "string" ? output : JSON.stringify(output ?? null),
      }
    }
    case ItemType.Reasoning:
      return { ...(item as unknown as ReasoningItem), summary: (item.summary as ReasoningTextPart[] | undefined) ?? [] }
    default:
      return item
  }
}

/** A function that the model may call. */
export interface Tool {
  /** The name of the function. */
  name: string
  description?: string
  /** The JSON Schema of the arguments. */
  parameters?: unknown
  strict?: boolean
}

/** Tool choice values of the specification. */
export type ToolChoice = "auto" | "required" | "none" | { type: "function"; name: string }

/** Force the model to call the function with this name. */
export function toolChoiceFunction(name: string): ToolChoice {
  return { type: "function", name }
}

/** The text.format field. It asks for output that matches a JSON schema. */
export interface TextFormat {
  name: string
  description?: string
  /** The JSON Schema of the output. */
  schema: unknown
  strict?: boolean
}

/** The body of `POST /v1/responses`. */
export interface ResponsesRequest {
  /** The exact model name. The client fills it when it is empty. */
  model?: string
  input: Item[]
  instructions?: string
  tools?: Tool[]
  tool_choice?: ToolChoice
  text?: { format?: TextFormat }
  stream?: boolean
  max_output_tokens?: number
  temperature?: number
  top_p?: number
  /** Continues an earlier response on the server. */
  previous_response_id?: string
}

/**
 * Build the request body. A field with no value is left out. The result is a
 * plain object, so `JSON.stringify` gives the body.
 */
export function buildRequestBody(req: ResponsesRequest): Record<string, unknown> {
  const tools = req.tools && req.tools.length > 0 ? req.tools.map(serializeTool) : undefined
  const format = req.text?.format
  return omitUndefined({
    model: req.model,
    input: (req.input ?? []).map(serializeItem),
    instructions: req.instructions || undefined,
    tools,
    tool_choice: req.tool_choice,
    text: format ? { format: serializeFormat(format) } : undefined,
    stream: req.stream ? true : undefined,
    max_output_tokens: req.max_output_tokens,
    temperature: req.temperature,
    top_p: req.top_p,
    previous_response_id: req.previous_response_id || undefined,
  })
}

function serializeTool(t: Tool): Record<string, unknown> {
  return omitUndefined({
    type: "function",
    name: t.name,
    description: t.description || undefined,
    parameters: t.parameters,
    strict: t.strict ? true : undefined,
  })
}

function serializeFormat(f: TextFormat): Record<string, unknown> {
  return omitUndefined({
    type: "json_schema",
    name: f.name,
    description: f.description || undefined,
    schema: f.schema,
    strict: f.strict ? true : undefined,
  })
}

/** The token counts of a response. */
export interface Usage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  /** `input_tokens_details.cached_tokens`. */
  cachedTokens: number
  /** `output_tokens_details.reasoning_tokens`. */
  reasoningTokens: number
}

/** The error object of a failed response. */
export interface ResponseError {
  code: string
  message: string
}

/** The response object of `POST /v1/responses`. */
export interface ResponsesResponse {
  id: string
  status: string
  model: string
  output: Item[]
  usage?: Usage
  incomplete_details?: { reason: string }
  error?: ResponseError
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0
}

function parseUsage(raw: unknown): Usage | undefined {
  if (raw === null || typeof raw !== "object") return undefined
  const u = raw as Record<string, unknown>
  const inDetail = (u.input_tokens_details ?? {}) as Record<string, unknown>
  const outDetail = (u.output_tokens_details ?? {}) as Record<string, unknown>
  return {
    inputTokens: num(u.input_tokens),
    outputTokens: num(u.output_tokens),
    totalTokens: num(u.total_tokens),
    cachedTokens: num(inDetail.cached_tokens),
    reasoningTokens: num(outDetail.reasoning_tokens),
  }
}

/** Decode a response object and each of its output items. */
export function parseResponse(raw: unknown): ResponsesResponse {
  if (raw === null || typeof raw !== "object") {
    throw new Error("openresponses: decode response: the body is not a JSON object")
  }
  const r = raw as Record<string, unknown>
  const out: ResponsesResponse = {
    id: typeof r.id === "string" ? r.id : "",
    status: typeof r.status === "string" ? r.status : "",
    model: typeof r.model === "string" ? r.model : "",
    output: Array.isArray(r.output) ? r.output.map(parseItem) : [],
  }
  const usage = parseUsage(r.usage)
  if (usage) out.usage = usage
  if (r.incomplete_details && typeof r.incomplete_details === "object") {
    out.incomplete_details = r.incomplete_details as { reason: string }
  }
  if (r.error && typeof r.error === "object") {
    const e = r.error as Record<string, unknown>
    out.error = { code: String(e.code ?? ""), message: String(e.message ?? "") }
  }
  return out
}

/** Return the text of each message of the model, joined in order. */
export function responseText(resp: ResponsesResponse): string {
  let out = ""
  for (const item of resp.output) if (isMessage(item)) out += messageText(item)
  return out
}

/** Return the function calls of the response in order. */
export function responseFunctionCalls(resp: ResponsesResponse): FunctionCallItem[] {
  return resp.output.filter(isFunctionCall)
}
