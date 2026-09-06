// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { randomUUID } from "node:crypto"
import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js"
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import type { Listen } from "./flags.js"
import { TAG, type Log } from "./log.js"

/**
 * The streamable-HTTP transport on localhost: the sandbox path. One process
 * serves for the life of the sandbox; each MCP client session (one per Claude
 * Code process) gets its own protocol server over the shared tool registry.
 *
 *   POST /mcp        a new session starts with `initialize`; later requests
 *                    carry `mcp-session-id`
 *   GET  /mcp        the session's notification stream
 *   DELETE /mcp      ends a session
 *   GET  /healthz    liveness and the current posture, as JSON
 *
 * DNS-rebinding protection is on: only the loopback host names are accepted.
 */
export interface HttpSurface {
  attach(transport: Transport): Promise<unknown>
  /** Small JSON for /healthz. */
  health(): Record<string, unknown>
  /**
   * The per-turn grant control endpoint (gibson#1706, decision 14). The
   * driver calls it before it feeds Claude a message, and every tool call
   * that follows runs under that dispatch's grant. Absent outside a member
   * sandbox, and then `/turn` answers 404 like any other unknown route.
   */
  turn?: TurnRoute
}

/**
 * `POST /turn {job_id, grant, callback_endpoint?, insecure?}` puts a turn in
 * force. `DELETE /turn` ends it, and later calls fall back to the base
 * grant. `GET /turn` reports the turn in force.
 */
export interface TurnRoute {
  set(turn: { jobId: string; grant: string; endpoint?: string; insecure?: boolean }): void
  clear(): void
  current(): { jobId: string; endpoint: string } | undefined
}

export interface HttpHandle {
  url: string
  host: string
  port: number
  sessions(): number
  close(): Promise<void>
}

const MAX_BODY_BYTES = 8 * 1024 * 1024

export async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    const buf = c as Buffer
    size += buf.byteLength
    if (size > MAX_BODY_BYTES) throw new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`)
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString("utf8").trim()
  if (!raw) return undefined
  return JSON.parse(raw) as unknown
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) })
  res.end(text)
}

export async function serveHttp(surface: HttpSurface, listen: Listen, log: Log): Promise<HttpHandle> {
  const sessions = new Map<string, StreamableHTTPServerTransport>()
  let allowedHosts: string[] = []

  const handleMcp = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const header = req.headers["mcp-session-id"]
    const sid = Array.isArray(header) ? header[0] : header
    if (sid) {
      const transport = sessions.get(sid)
      if (!transport) {
        sendJson(res, 404, { error: "unknown MCP session; start a new one with initialize" })
        return
      }
      await transport.handleRequest(req, res)
      return
    }
    if (req.method !== "POST") {
      sendJson(res, 400, { error: "a new MCP session starts with a POST initialize request" })
      return
    }
    const body = await readJsonBody(req)
    if (!isInitializeRequest(body)) {
      sendJson(res, 400, { error: "a new MCP session starts with initialize; later requests carry mcp-session-id" })
      return
    }
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (id) => {
        sessions.set(id, transport)
        log(`${TAG} http: session ${id} opened (${sessions.size} open)`)
      },
      onsessionclosed: (id) => {
        sessions.delete(id)
        log(`${TAG} http: session ${id} closed (${sessions.size} open)`)
      },
      enableDnsRebindingProtection: true,
      allowedHosts,
    })
    transport.onclose = () => {
      if (transport.sessionId) sessions.delete(transport.sessionId)
    }
    await surface.attach(transport)
    await transport.handleRequest(req, res, body)
  }

  const handleTurn = async (turn: TurnRoute, req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method === "GET") {
      const current = turn.current()
      return sendJson(res, 200, current ? { job_id: current.jobId, endpoint: current.endpoint } : { job_id: null })
    }
    if (req.method === "DELETE") {
      turn.clear()
      return sendJson(res, 200, { job_id: null })
    }
    if (req.method !== "POST") return sendJson(res, 405, { error: "POST to set a turn, DELETE to end it, GET to read it" })
    const body = (await readJsonBody(req)) as Record<string, unknown> | undefined
    const jobId = typeof body?.job_id === "string" ? body.job_id : ""
    const grant = typeof body?.grant === "string" ? body.grant : ""
    if (!jobId || !grant) {
      return sendJson(res, 400, { error: "job_id and grant are both required: a turn is one dispatch's grant, and a grant with no job attributes the work to nothing" })
    }
    const endpoint = typeof body?.callback_endpoint === "string" ? body.callback_endpoint : undefined
    turn.set({ jobId, grant, ...(endpoint ? { endpoint } : {}), ...(typeof body?.insecure === "boolean" ? { insecure: body.insecure } : {}) })
    const current = turn.current()
    return sendJson(res, 200, { job_id: jobId, endpoint: current?.endpoint ?? endpoint ?? "" })
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", `http://${listen.host}:${listen.port || 0}`)
      try {
        if (url.pathname === "/turn" && surface.turn) return await handleTurn(surface.turn, req, res)
        if (url.pathname === "/mcp") return await handleMcp(req, res)
        if (url.pathname === "/healthz" && req.method === "GET") return sendJson(res, 200, { ok: true, sessions: sessions.size, ...surface.health() })
        sendJson(res, 404, { error: `no route ${req.method} ${url.pathname}` })
      } catch (e) {
        log(`${TAG} http: ${req.method} ${url.pathname}: ${(e as Error).message}`)
        if (!res.headersSent) sendJson(res, 500, { error: (e as Error).message })
        else res.end()
      }
    })()
  })

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject)
    server.listen(listen.port, listen.host, () => {
      server.off("error", reject)
      resolve()
    })
  })
  const addr = server.address() as AddressInfo
  const host = addr.family === "IPv6" ? `[${addr.address}]` : addr.address
  allowedHosts = [`${host}:${addr.port}`, `localhost:${addr.port}`, `127.0.0.1:${addr.port}`, `[::1]:${addr.port}`, host, "localhost", "127.0.0.1", "[::1]"]

  return {
    url: `http://${host}:${addr.port}/mcp`,
    host: addr.address,
    port: addr.port,
    sessions: () => sessions.size,
    close: async () => {
      for (const t of sessions.values()) await t.close().catch(() => {})
      sessions.clear()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      server.closeAllConnections?.()
    },
  }
}
