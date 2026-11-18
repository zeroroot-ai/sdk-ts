// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { gatewayFetch, checkGatewayUrl, type HeaderFunc } from "./gateway.js"
import {
  buildRequestBody,
  parseItem,
  parseResponse,
  responseText,
  type Item,
  type ResponsesRequest,
  type ResponsesResponse,
  type Usage,
} from "./openresponses.js"

/**
 * The one client that an agent uses to call a model.
 *
 * It has no code for a model provider. It sends one request shape to the model
 * gateway: `POST {baseUrl}/v1/responses`. The gateway does the conversion to
 * the provider. The client has these calls:
 *
 *  - {@link ModelClient.create} makes one call and returns the whole response.
 *  - {@link ModelClient.stream} makes one call and returns the server-sent events.
 *  - {@link ModelClient.createStructured} makes one call with a JSON schema and decodes the reply.
 *  - A call with tools is `create` with `tools` set.
 */

/** The route of a model call. It is also the method name that a task grant lists. */
export const RESPONSES_PATH = "/v1/responses"

/**
 * What the daemon tells the agent about one model slot. It is the shape of
 * `ResolveModelResponse`.
 */
export interface ResolvedModel {
  /** One exact model name. */
  model: string
  /** The name of the tenant model provider. */
  provider: string
  /** The base URL. The client calls `POST {gatewayUrl}/v1/responses`. */
  gatewayUrl: string
  /** The client sends each one unchanged. */
  routeHeaders: Record<string, string>
  /** Tokens. `0` means unknown. */
  contextWindow: number
  /** Tokens. `0` means unknown. */
  maxOutputTokens: number
  /** The PEM bundle of the private CA of the gateway. Empty means the system roots. */
  gatewayCaPem: string
}

export interface ModelClientOptions {
  /** The gateway URL, for example `https://gateway.example`. */
  baseUrl: string
  /** The exact model name. It fills `model` of a request when that is empty. */
  model?: string
  /** Sent unchanged on each call. The route of the gateway matches on them. */
  routeHeaders?: Record<string, string>
  /** Adds the headers of each call, for example the task grant. */
  headers?: HeaderFunc
  /** Called with the token counts of each finished response. */
  onUsage?: (usage: Usage) => void
  /** Describe the model. The client does not read them. `0` means unknown. */
  provider?: string
  contextWindow?: number
  maxOutputTokens?: number
  /**
   * The PEM bundle of the CA that signed the certificate of the gateway. When
   * it is set, the client trusts exactly this bundle for the gateway, and
   * `baseUrl` must use https. When it is empty, the client uses the system
   * roots. The client has no option to skip verification.
   */
  caPem?: string
  /**
   * Make the call. It is a test seam. Do not set it together with `caPem`.
   * The default sends the call through the gateway trust rule.
   */
  fetch?: typeof fetch
}

/** An error reply of the gateway. */
export class ModelAPIError extends Error {
  constructor(
    readonly statusCode: number,
    readonly errorType: string,
    readonly code: string,
    message: string,
    readonly param: string = "",
  ) {
    super(`openresponses: gateway returned ${statusCode} (${code}): ${message}`)
    this.name = "ModelAPIError"
  }
}

/** Build a client from the answer of `ResolveModel`. */
export function modelClientFrom(
  resolved: ResolvedModel,
  extra: { headers?: HeaderFunc; onUsage?: (usage: Usage) => void } = {},
): ModelClient {
  return new ModelClient({
    baseUrl: resolved.gatewayUrl,
    model: resolved.model,
    routeHeaders: resolved.routeHeaders,
    provider: resolved.provider,
    contextWindow: resolved.contextWindow,
    maxOutputTokens: resolved.maxOutputTokens,
    caPem: resolved.gatewayCaPem,
    ...extra,
  })
}

/** The events of the stream that the SDK reads. */
export const EventType = {
  Created: "response.created",
  InProgress: "response.in_progress",
  OutputItemAdded: "response.output_item.added",
  OutputItemDone: "response.output_item.done",
  OutputTextDelta: "response.output_text.delta",
  OutputTextDone: "response.output_text.done",
  FunctionArgsDelta: "response.function_call_arguments.delta",
  FunctionArgsDone: "response.function_call_arguments.done",
  ReasoningDelta: "response.reasoning.delta",
  ReasoningSummaryDelta: "response.reasoning_summary_text.delta",
  Completed: "response.completed",
  Failed: "response.failed",
  Incomplete: "response.incomplete",
  Error: "error",
} as const

/**
 * One server-sent event. The fields that an event type does not have stay
 * unset. `raw` holds the JSON data of the event.
 */
export interface ModelEvent {
  type: string
  sequenceNumber: number
  itemId: string
  outputIndex: number
  contentIndex: number
  /** The text of a delta event. */
  delta: string
  /** The full text of a done event. */
  text: string
  /** The full arguments of a `function_call_arguments.done` event. */
  arguments: string
  /** Set on `output_item.added` and `output_item.done`. */
  item?: Item
  /** Set on the `response.*` events. */
  response?: ResponsesResponse
  /** Set on an `error` event. */
  error?: ModelAPIError
  raw: unknown
}

function responseFailure(r: ResponsesResponse): Error {
  return r.error
    ? new Error(`openresponses: response failed (${r.error.code}): ${r.error.message}`)
    : new Error("openresponses: response failed")
}

/**
 * The events of one streamed call. Iterate it with `for await`, or call
 * {@link ModelStream.collect}. A terminal `response.failed` or `error` event is
 * yielded as an event, and the iteration then throws an error that says why the
 * stream failed. Call {@link ModelStream.close} to release the connection.
 */
export class ModelStream implements AsyncIterable<ModelEvent> {
  private final: ResponsesResponse | undefined
  private terminalError: Error | undefined
  private reported = false

  constructor(
    private readonly body: ReadableStream<Uint8Array>,
    private readonly onDone: (r: ResponsesResponse) => void,
  ) {}

  /** The response of the terminal event. It is unset before the stream ends. */
  get response(): ResponsesResponse | undefined {
    return this.final
  }

  /** Release the connection. */
  async close(): Promise<void> {
    await this.body.cancel().catch(() => undefined)
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ModelEvent, void, undefined> {
    const reader = this.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ""
    let name = ""
    let data: string[] = []
    const flush = (): ModelEvent | "done" | undefined => {
      if (data.length === 0) {
        name = ""
        return undefined
      }
      const payload = data.join("\n")
      const eventName = name
      name = ""
      data = []
      if (payload === "[DONE]") return "done"
      return this.decode(eventName, payload)
    }
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (value) buffer += decoder.decode(value, { stream: !done })
        if (done) buffer += decoder.decode()
        let nl = buffer.indexOf("\n")
        while (nl >= 0 || (done && buffer.length > 0)) {
          const end = nl >= 0 ? nl : buffer.length
          const line = buffer.slice(0, end).replace(/\r$/, "")
          buffer = buffer.slice(nl >= 0 ? nl + 1 : buffer.length)
          if (line === "") {
            const ev = flush()
            if (ev === "done") return
            if (ev) {
              yield ev
              if (this.terminalError) throw this.terminalError
            }
          } else if (line.startsWith(":")) {
            // A comment line. Ignore it.
          } else if (line.startsWith("event:")) {
            name = line.slice("event:".length).trim()
          } else if (line.startsWith("data:")) {
            data.push(line.slice("data:".length).replace(/^ /, ""))
          }
          nl = buffer.indexOf("\n")
        }
        if (done) break
      }
      const last = flush()
      if (last && last !== "done") {
        yield last
        if (this.terminalError) throw this.terminalError
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private decode(name: string, payload: string): ModelEvent {
    let w: Record<string, unknown>
    try {
      w = JSON.parse(payload) as Record<string, unknown>
    } catch (cause) {
      throw new Error("openresponses: decode event: the data is not JSON", { cause })
    }
    const str = (k: string): string => (typeof w[k] === "string" ? (w[k] as string) : "")
    const int = (k: string): number => (typeof w[k] === "number" ? (w[k] as number) : 0)
    const ev: ModelEvent = {
      type: str("type") || name,
      sequenceNumber: int("sequence_number"),
      itemId: str("item_id"),
      outputIndex: int("output_index"),
      contentIndex: int("content_index"),
      delta: str("delta"),
      text: str("text"),
      arguments: str("arguments"),
      raw: w,
    }
    if (w.item !== undefined && w.item !== null) ev.item = parseItem(w.item)
    if (w.response !== undefined && w.response !== null) ev.response = parseResponse(w.response)
    if (w.error && typeof w.error === "object") {
      const e = w.error as Record<string, unknown>
      ev.error = new ModelAPIError(0, String(e.type ?? ""), String(e.code ?? ""), String(e.message ?? ""), String(e.param ?? ""))
    }
    switch (ev.type) {
      case EventType.Completed:
      case EventType.Incomplete:
        this.final = ev.response
        break
      case EventType.Failed:
        this.final = ev.response
        this.terminalError = ev.response ? responseFailure(ev.response) : new Error("openresponses: response failed")
        break
      case EventType.Error:
        this.terminalError = ev.error ?? new Error("openresponses: stream error")
        break
      default:
    }
    if (this.final && !this.reported) {
      this.reported = true
      this.onDone(this.final)
    }
    return ev
  }

  /**
   * Read the stream to its end and return the final response. It calls `on`
   * for each text delta when `on` is set.
   */
  async collect(on?: (delta: string) => void): Promise<ResponsesResponse> {
    for await (const ev of this) {
      if (on && ev.type === EventType.OutputTextDelta) on(ev.delta)
    }
    if (!this.final) throw new Error("openresponses: stream ended with no terminal event")
    return this.final
  }
}

/** Calls the model gateway. It holds no state that changes. */
export class ModelClient {
  /** The description of the model. The client does not read these. */
  readonly provider: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  private readonly doFetch: typeof fetch

  constructor(private readonly opts: ModelClientOptions) {
    if (!opts.baseUrl) throw new Error("openresponses: client has no base URL")
    checkGatewayUrl(opts.baseUrl, opts.caPem)
    if (opts.caPem && opts.fetch) throw new Error("openresponses: set caPem or fetch, not both")
    this.provider = opts.provider ?? ""
    this.contextWindow = opts.contextWindow ?? 0
    this.maxOutputTokens = opts.maxOutputTokens ?? 0
    this.doFetch =
      opts.fetch ??
      gatewayFetch({
        baseUrl: opts.baseUrl,
        ...(opts.caPem ? { caPem: opts.caPem } : {}),
        ...(opts.routeHeaders ? { fixedHeaders: opts.routeHeaders } : {}),
        ...(opts.headers ? { headers: opts.headers } : {}),
      })
  }

  private async post(req: ResponsesRequest, stream: boolean, signal?: AbortSignal): Promise<Response> {
    const body = buildRequestBody({ ...req, model: req.model || this.opts.model, stream })
    if (!body.model) throw new Error("openresponses: request has no model")
    const url = `${this.opts.baseUrl.replace(/\/$/, "")}${RESPONSES_PATH}`
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: stream ? "text/event-stream" : "application/json",
    }
    // A caller-made fetch gets the headers here. The default fetch adds them
    // itself, so the grant header is built for the route of the call.
    if (this.opts.fetch) {
      Object.assign(headers, this.opts.routeHeaders ?? {})
      if (this.opts.headers) Object.assign(headers, await this.opts.headers(RESPONSES_PATH))
    }
    let resp: Response
    try {
      resp = await this.doFetch(url, { method: "POST", headers, body: JSON.stringify(body), ...(signal ? { signal } : {}) })
    } catch (cause) {
      throw new Error(`openresponses: call gateway: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
    if (resp.status < 200 || resp.status >= 300) throw await parseAPIError(resp)
    return resp
  }

  /**
   * Make one call and return the whole response. A response with the status
   * `failed` throws.
   */
  async create(req: ResponsesRequest, signal?: AbortSignal): Promise<ResponsesResponse> {
    const resp = await this.post(req, false, signal)
    let out: ResponsesResponse
    try {
      out = parseResponse(await resp.json())
    } catch (cause) {
      throw new Error(`openresponses: decode response: ${cause instanceof Error ? cause.message : String(cause)}`, { cause })
    }
    if (out.usage) this.opts.onUsage?.(out.usage)
    if (out.status === "failed") throw responseFailure(out)
    return out
  }

  /**
   * Make one call whose output must match a JSON schema. It sets `text.format`,
   * decodes the text of the reply, and returns it with the response. The name
   * labels the schema in the request.
   */
  async createStructured<T = unknown>(
    req: ResponsesRequest,
    name: string,
    schema: unknown,
    signal?: AbortSignal,
  ): Promise<{ value: T; response: ResponsesResponse }> {
    const response = await this.create({ ...req, text: { format: { name, schema, strict: true } } }, signal)
    const text = responseText(response)
    if (!text) throw new Error("openresponses: structured reply has no text")
    try {
      return { value: JSON.parse(text) as T, response }
    } catch (cause) {
      throw new Error("openresponses: decode structured reply: the text is not JSON", { cause })
    }
  }

  /** Make one call with `stream` set and return the events. */
  async stream(req: ResponsesRequest, signal?: AbortSignal): Promise<ModelStream> {
    const resp = await this.post(req, true, signal)
    if (!resp.body) throw new Error("openresponses: the stream reply has no body")
    return new ModelStream(resp.body, (r) => {
      if (r.usage) this.opts.onUsage?.(r.usage)
    })
  }
}

async function parseAPIError(resp: Response): Promise<ModelAPIError> {
  const raw = (await resp.text().catch(() => "")).slice(0, 1 << 20)
  try {
    const w = JSON.parse(raw) as { error?: { type?: string; code?: string; message?: string; param?: string } }
    if (w.error?.message) {
      return new ModelAPIError(resp.status, w.error.type ?? "", w.error.code ?? "", w.error.message, w.error.param ?? "")
    }
  } catch {
    // The body is not JSON. Use the text.
  }
  return new ModelAPIError(resp.status, "", "", raw.trim())
}
