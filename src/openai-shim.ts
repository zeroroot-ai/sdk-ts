import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

/**
 * A minimal OpenAI-compatible /v1/chat/completions shim that proxies to the
 * Gibson harness (ComponentService.Complete). opencode points its
 * `@ai-sdk/openai-compatible` provider at this local endpoint, so the agent's
 * LLM runs through Gibson (slots, budget, per-tenant creds, tracing) — the
 * Model seam (zerocool#5). The OpenAI "model" IS the Gibson slot.
 *
 * Non-streaming only here; streaming + tools are zerocool#6.
 */
export interface ShimOptions {
  component: Client<typeof ComponentService>
  port?: number // default 8787; 0 picks a free port
  host?: string // default 127.0.0.1
}

export interface RunningShim { url: string; port: number; close: () => Promise<void> }

interface OpenAIMessage { role: string; content: unknown }
interface OpenAIChatRequest { model: string; messages: OpenAIMessage[]; stream?: boolean }

function contentToString(c: unknown): string {
  if (typeof c === "string") return c
  if (Array.isArray(c)) return c.map((p) => (typeof p === "string" ? p : ((p as { text?: string })?.text ?? ""))).join("")
  return c == null ? "" : String(c)
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

export async function startCompletionsShim(opts: ShimOptions): Promise<RunningShim> {
  const host = opts.host ?? "127.0.0.1"
  const server = createServer((req, res) => void handle(req, res))

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== "POST" || !req.url?.startsWith("/v1/chat/completions")) {
      res.writeHead(404); res.end(); return
    }
    let body: OpenAIChatRequest
    try { body = (await readJSON(req)) as OpenAIChatRequest } catch { res.writeHead(400); res.end(); return }
    if (body.stream) {
      res.writeHead(400, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: "streaming is served by zerocool#6" } }))
      return
    }
    try {
      const out = await opts.component.complete({
        slot: body.model,
        messages: (body.messages ?? []).map((m) => ({ role: m.role, content: contentToString(m.content) })),
      })
      const inTok = Number(out.usage?.inputTokens ?? 0)
      const outTok = Number(out.usage?.outputTokens ?? 0)
      const payload = {
        id: `chatcmpl-gibson`,
        object: "chat.completion",
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: out.response?.content ?? "" }, finish_reason: "stop" }],
        usage: { prompt_tokens: inTok, completion_tokens: outTok, total_tokens: inTok + outTok },
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(payload))
    } catch (e) {
      res.writeHead(502, { "content-type": "application/json" })
      res.end(JSON.stringify({ error: { message: (e as Error).message } }))
    }
  }

  await new Promise<void>((r) => server.listen(opts.port ?? 8787, host, r))
  const addr = server.address()
  const port = typeof addr === "object" && addr ? addr.port : (opts.port ?? 8787)
  return { url: `http://${host}:${port}/v1`, port, close: () => new Promise<void>((r) => server.close(() => r())) }
}
