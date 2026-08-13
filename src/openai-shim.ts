import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

/**
 * An OpenAI-compatible /v1/chat/completions shim that proxies to the Gibson
 * harness. opencode points its `@ai-sdk/openai-compatible` provider at this
 * local endpoint, so the agent's LLM runs through Gibson (slots, budget,
 * per-tenant creds, tracing) — the Model seam. The OpenAI "model" IS the
 * Gibson slot.
 *
 * Three request shapes, three harness RPCs (zerocool#6):
 *
 *  - plain            -> ComponentService.Complete           (unary)
 *  - `stream: true`   -> ComponentService.CompleteStream     (server stream -> SSE)
 *  - `tools: [...]`   -> ComponentService.CompleteWithTools  (unary; streamed
 *                        requests get the result as a synthesized SSE turn —
 *                        the RPC is unary, so there is nothing incremental to
 *                        forward, but the streaming client contract holds)
 *  - `response_format: { type: "json_schema" }`
 *                     -> ComponentService.CompleteStructured (unary)
 *
 * Tool-history flattening: the wire message (`LLMMessage`) carries role +
 * content only, so assistant `tool_calls` and `tool` results are flattened
 * into content deterministically (JSON for calls, plain content for results,
 * with the originating call id kept). First-class tool history needs a proto
 * change, tracked in zeroroot-ai/sdk#463.
 */
export interface ShimOptions {
  component: Client<typeof ComponentService>
  port?: number // default 8787; 0 picks a free port
  host?: string // default 127.0.0.1
}

export interface RunningShim { url: string; port: number; close: () => Promise<void> }

interface OpenAIToolCall { id?: string; type?: string; function?: { name?: string; arguments?: string } }
interface OpenAIMessage {
  role: string
  content: unknown
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}
interface OpenAITool { type?: string; function?: { name?: string; description?: string; parameters?: unknown } }
interface OpenAIChatRequest {
  model: string
  messages: OpenAIMessage[]
  stream?: boolean
  tools?: OpenAITool[]
  tool_choice?: unknown
  response_format?: { type?: string; json_schema?: { name?: string; schema?: unknown } }
}

function contentToString(c: unknown): string {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : ((p as { text?: string })?.text ?? ""))).join("")
  return c == null ? "" : String(c)
}

/**
 * Flatten an OpenAI conversation into role+content wire messages.
 *
 * Assistant tool calls become a JSON line appended to the content; tool
 * results keep role "tool" and carry their originating call id inline. The
 * shape is lossy by construction — the wire message has no tool fields — but
 * deterministic, so the model sees a faithful transcript of what it called
 * and what came back.
 */
function toWireMessages(messages: OpenAIMessage[]): { role: string; content: string }[] {
  return (messages ?? []).map((m) => {
    let content = contentToString(m.content)
    if (m.role === "assistant" && m.tool_calls?.length) {
      const calls = m.tool_calls.map((tc) => ({
        id: tc.id ?? "",
        name: tc.function?.name ?? "",
        arguments: tc.function?.arguments ?? "",
      }))
      const line = `[tool_calls] ${JSON.stringify(calls)}`
      content = content ? `${content}\n${line}` : line
    }
    if (m.role === "tool" && m.tool_call_id) {
      content = `[tool_result ${m.tool_call_id}] ${content}`
    }
    return { role: m.role, content }
  })
}

function readJSON(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}")) } catch (e) { reject(e) }
    })
    req.on("error", reject)
  })
}

interface Usage { prompt_tokens: number; completion_tokens: number; total_tokens: number }

function toUsage(u: { inputTokens?: number | bigint; outputTokens?: number | bigint } | undefined): Usage {
  const inTok = Number(u?.inputTokens ?? 0)
  const outTok = Number(u?.outputTokens ?? 0)
  return { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok }
}

/** One SSE writer per response: chunk frames share an id, [DONE] closes. */
function sseWriter(res: ServerResponse, model: string) {
  const id = `chatcmpl-gibson-${Date.now().toString(36)}`
  const created = Math.floor(Date.now() / 1000)
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
    connection: "keep-alive",
  })
  return {
    chunk(delta: Record<string, unknown>, finishReason: string | null, usage?: Usage): void {
      const frame: Record<string, unknown> = {
        id,
        object: "chat.completion.chunk",
        created,
        model,
        choices: [{ index: 0, delta, finish_reason: finishReason }],
      }
      if (usage) frame.usage = usage
      res.write(`data: ${JSON.stringify(frame)}\n\n`)
    },
    error(message: string): void {
      res.write(`data: ${JSON.stringify({ error: { message } })}\n\n`)
    },
    done(): void {
      res.write("data: [DONE]\n\n")
      res.end()
    },
  }
}

export async function startCompletionsShim(opts: ShimOptions): Promise<RunningShim> {
  const host = opts.host ?? "127.0.0.1"
  const server = createServer((req, res) => void handle(req, res))

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      res.writeHead(404); res.end(); return
    }
    let body: OpenAIChatRequest
    try { body = (await readJSON(req)) as OpenAIChatRequest } catch { res.writeHead(400); res.end(); return }
    const model = body.model
    const messages = toWireMessages(body.messages)

    try {
      if (body.tools?.length) {
        await handleWithTools(res, body, model, messages)
      } else if (body.response_format?.type === "json_schema") {
        await handleStructured(res, body, model, messages)
      } else if (body.stream) {
        await handleStream(res, model, messages)
      } else {
        const out = await opts.component.complete({ slot: model, messages })
        respondJSON(res, model, {
          message: { role: "assistant", content: out.response?.content ?? "" },
          finishReason: "stop",
          usage: toUsage(out.usage),
        })
      }
    } catch (e) {
      if (res.headersSent) {
        // Mid-stream failure: surface it in-band; the SSE consumer sees the
        // error frame instead of a silent hang.
        res.write(`data: ${JSON.stringify({ error: { message: (e as Error).message } })}\n\n`)
        res.end()
        return
      }
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: (e as Error).message } }))
    }
  }

  async function handleStream(res: ServerResponse, model: string, messages: { role: string; content: string }[]): Promise<void> {
    const sse = sseWriter(res, model)
    sse.chunk({ role: "assistant" }, null)
    let usage: Usage | undefined
    try {
      for await (const chunk of opts.component.completeStream({ slot: model, messages })) {
        if (chunk.content) sse.chunk({ content: chunk.content }, null)
        if (chunk.done) usage = toUsage(chunk.usage)
      }
    } catch (e) {
      sse.error((e as Error).message)
      res.end()
      return
    }
    sse.chunk({}, "stop", usage)
    sse.done()
  }

  async function handleWithTools(
    res: ServerResponse,
    body: OpenAIChatRequest,
    model: string,
    messages: { role: string; content: string }[],
  ): Promise<void> {
    const out = await opts.component.completeWithTools({
      slot: model,
      messages,
      tools: (body.tools ?? []).map((t) => ({
        name: t.function?.name ?? "",
        description: t.function?.description ?? "",
        inputSchemaJson: JSON.stringify(t.function?.parameters ?? {}),
      })),
    })
    const toolCalls = (out.toolCalls ?? []).map((tc, i) => ({
      index: i,
      id: tc.id,
      type: "function" as const,
      function: { name: tc.name, arguments: tc.argumentsJson },
    }))
    const finishReason = out.finishReason || (toolCalls.length ? "tool_calls" : "stop")
    const content = out.response?.content ?? ""
    const usage = toUsage(out.usage)

    if (!body.stream) {
      respondJSON(res, model, {
        message: {
          role: "assistant",
          content,
          ...(toolCalls.length ? { tool_calls: toolCalls.map(({ index: _i, ...tc }) => tc) } : {}),
        },
        finishReason,
        usage,
      })
      return
    }
    // The RPC is unary; answer a streaming client with one synthesized turn.
    const sse = sseWriter(res, model)
    sse.chunk({ role: "assistant", ...(content ? { content } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }, null)
    sse.chunk({}, finishReason, usage)
    sse.done()
  }

  async function handleStructured(
    res: ServerResponse,
    body: OpenAIChatRequest,
    model: string,
    messages: { role: string; content: string }[],
  ): Promise<void> {
    const out = await opts.component.completeStructured({
      slot: model,
      messages,
      schemaJson: JSON.stringify(body.response_format?.json_schema?.schema ?? {}),
    })
    const usage = toUsage(out.usage)
    if (!body.stream) {
      respondJSON(res, model, {
        message: { role: "assistant", content: out.resultJson },
        finishReason: "stop",
        usage,
      })
      return
    }
    const sse = sseWriter(res, model)
    sse.chunk({ role: "assistant", content: out.resultJson }, null)
    sse.chunk({}, "stop", usage)
    sse.done()
  }

  function respondJSON(
    res: ServerResponse,
    model: string,
    r: { message: Record<string, unknown>; finishReason: string; usage: Usage },
  ): void {
    res.writeHead(200, { "content-type": "application/json" })
    res.end(
      JSON.stringify({
        id: `chatcmpl-gibson-${Date.now().toString(36)}`,
        object: "chat.completion",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, message: r.message, finish_reason: r.finishReason }],
        usage: r.usage,
      }),
    )
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 8787, host, r))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 8787)
  return { url: `http://${host}:${port}/v1`, port, close: () => new Promise<void>((r) => server.close(() => r())) }
}
