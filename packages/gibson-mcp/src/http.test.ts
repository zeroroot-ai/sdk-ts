// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { buildSurface } from "./build.js"
import { serveHttp } from "./http.js"

const quiet = () => {}

async function serve() {
  const cwd = await mkdtemp(join(tmpdir(), "gm-http-"))
  const surface = await buildSurface(
    { ZEROCOOL_STATE_DIR: cwd, GIBSON_CLI_CREDENTIALS: join(cwd, "none"), GIBSON_HOST_KEY_PATH: join(cwd, "host.key") },
    cwd,
  )
  // Port 0: the kernel picks a free port, so parallel tests never collide.
  const http = await serveHttp(surface, { host: "127.0.0.1", port: 0 }, quiet)
  return { surface, http, close: async () => { await http.close(); await surface.close() } }
}

test("a client reaches the same tools over streamable HTTP on localhost", async () => {
  const s = await serve()
  const client = new Client({ name: "driver", version: "0" })
  await client.connect(new StreamableHTTPClientTransport(new URL(s.http.url)))
  const names = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, ["componentize", "gibson_connect", "gibson_login", "gibson_status", "submit_finding", "validate_component"])
  assert.equal(s.http.sessions(), 1)
  await client.close()
  await s.close()
})

test("two clients hold two sessions over one process and one tool registry", async () => {
  const s = await serve()
  const a = new Client({ name: "a", version: "0" })
  const b = new Client({ name: "b", version: "0" })
  await a.connect(new StreamableHTTPClientTransport(new URL(s.http.url)))
  await b.connect(new StreamableHTTPClientTransport(new URL(s.http.url)))
  assert.equal(s.http.sessions(), 2)
  assert.equal((await a.listTools()).tools.length, (await b.listTools()).tools.length)
  await a.close()
  await b.close()
  await s.close()
})

test("/healthz reports the source, the posture and the tool count", async () => {
  const s = await serve()
  const res = await fetch(new URL("/healthz", s.http.url))
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), { ok: true, sessions: 0, source: "none", posture: "standalone", tools: 6, api_rpcs: 0 })
  await s.close()
})

test("a request with an unknown session id is refused, and an unknown route is a 404", async () => {
  const s = await serve()
  const unknown = await fetch(new URL(s.http.url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-session-id": "no-such-session" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  assert.equal(unknown.status, 404)
  const nowhere = await fetch(new URL("/nowhere", s.http.url))
  assert.equal(nowhere.status, 404)
  await s.close()
})

test("a POST that is not initialize and carries no session id is refused", async () => {
  const s = await serve()
  const res = await fetch(new URL(s.http.url), {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
  })
  assert.equal(res.status, 400)
  assert.match(JSON.stringify(await res.json()), /initialize/)
  await s.close()
})

/** A surface that serves turns, so the /turn contract can be exercised whole. */
async function serveWithTurns() {
  const turns: { jobId: string; endpoint: string }[] = []
  let current: { jobId: string; endpoint: string } | undefined
  const surface = {
    attach: async () => ({}),
    health: () => ({ posture: "task" }),
    turn: {
      set: (t: { jobId: string; grant: string; endpoint?: string }) => {
        current = { jobId: t.jobId, endpoint: t.endpoint ?? "daemon:50001" }
        turns.push({ ...current, grant: t.grant } as never)
      },
      clear: () => {
        current = undefined
      },
      current: () => current,
    },
  }
  const http = await serveHttp(surface, { host: "127.0.0.1", port: 0 }, quiet)
  const turnURL = new URL("/turn", http.url)
  return { http, turnURL, turns, close: () => http.close() }
}

const postTurn = (url: URL, body: unknown) =>
  fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })

test("POST /turn puts a dispatch's grant in force, and DELETE /turn ends it", async () => {
  const s = await serveWithTurns()
  const set = await postTurn(s.turnURL, { job_id: "job-1", grant: "grant-1", callback_endpoint: "daemon:50001" })
  assert.equal(set.status, 200)
  assert.deepEqual(await set.json(), { job_id: "job-1", endpoint: "daemon:50001" })
  assert.deepEqual(await (await fetch(s.turnURL)).json(), { job_id: "job-1", endpoint: "daemon:50001" })

  const cleared = await fetch(s.turnURL, { method: "DELETE" })
  assert.deepEqual(await cleared.json(), { job_id: null })
  assert.deepEqual(await (await fetch(s.turnURL)).json(), { job_id: null })
  await s.close()
})

test("a turn with no job or no grant is refused: a grant with no job attributes the work to nothing", async () => {
  const s = await serveWithTurns()
  for (const body of [{ grant: "g" }, { job_id: "j" }, {}]) {
    const res = await postTurn(s.turnURL, body)
    assert.equal(res.status, 400)
    assert.match(JSON.stringify(await res.json()), /job_id and grant/)
  }
  assert.deepEqual(s.turns, [])
  await s.close()
})

test("/turn is absent where there is no task grant to swap", async () => {
  const s = await serve()
  const res = await postTurn(new URL("/turn", s.http.url), { job_id: "j", grant: "g" })
  assert.equal(res.status, 404)
  await s.close()
})
