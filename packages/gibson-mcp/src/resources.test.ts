// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { createRouterTransport } from "@connectrpc/connect"
import type { GibsonSession, KnowledgeSource, LiveMission, QueryKnowledgeOptions, TaskHarness } from "@zeroroot-ai/sdk"
import { buildSurface } from "./build.js"
import { AMBIENT_URI, ambientSource, sessionCoordinates, SESSION_URI } from "./resources.js"
import type { Gibson } from "./session.js"
import { keyFor } from "./state.js"

function knowledge(queries: string[], hits = 1): KnowledgeSource {
  return {
    query: async (opts: QueryKnowledgeOptions) => {
      queries.push(opts.text)
      return Array.from({ length: hits }, (_, i) => ({ id: `n-${i}`, type: "Observation", score: 1, content: `fact ${i}`, properties: { title: `fact ${i}` }, distance: 0 }))
    },
  } as unknown as KnowledgeSource
}

function gibson(parts: Partial<Gibson>): Gibson {
  return {
    source: "enrolled",
    mode: "live",
    reason: "",
    agentName: "gibson-mcp",
    hostKeyPath: "/tmp/host.key",
    settings: { callbackInsecure: false, hostKeyPath: "/tmp/host.key", agentName: "gibson-mcp", platformURL: "https://p", targetId: "tgt-1", tenant: "primary" },
    close: async () => {},
    ...parts,
  }
}

const harness = (): TaskHarness => ({
  transport: createRouterTransport(() => {}),
  client: {} as never,
  endpoint: "daemon:50001",
  context: { missionId: "m-1", taskId: "t-1", agentName: "gibson-mcp" },
  token: () => "tok",
  expiresAt: () => 0,
  stop: () => {},
})

const live = (): LiveMission => ({ missionId: "m-1", workId: "w-1", harness: harness(), end: async () => {} })

test("the ambient block is one lookup per session, and a question of the model's own is not cached", async () => {
  const queries: string[] = []
  const ambient = ambientSource(gibson({ knowledge: knowledge(queries) }), {})
  const first = await ambient.block()
  assert.match(first, /fact 0/)
  await ambient.block()
  assert.equal(queries.length, 1, "the opening lookup is prompt overhead on every session; it runs once")

  await ambient.block("what did we learn about the auth service")
  assert.deepEqual(queries.slice(1), ["what did we learn about the auth service"])
})

test("with no platform the block is empty and nothing is dialed", async () => {
  const ambient = ambientSource(gibson({ mode: "standalone", knowledge: undefined }), {})
  assert.equal(await ambient.block(), "")
})

test("the session coordinates carry what a session-end hook needs to checkpoint", () => {
  const c = sessionCoordinates(gibson({ live: live(), runId: "run-7" }))
  assert.deepEqual(c, {
    source: "enrolled",
    posture: "live",
    agent_name: "gibson-mcp",
    platform_url: "https://p",
    tenant: "primary",
    target_id: "tgt-1",
    mission_id: "m-1",
    work_id: "w-1",
    callback_endpoint: "daemon:50001",
    callback_insecure: false,
    run_id: "run-7",
  })
  // No mission, no mission fields. A hook reads "absent" and skips the
  // checkpoint rather than writing one against an empty mission id.
  const bare = sessionCoordinates(gibson({ mode: "component" }))
  assert.equal(bare.mission_id, undefined)
})

async function open(env: NodeJS.ProcessEnv = {}, deps = {}) {
  const cwd = await mkdtemp(join(tmpdir(), "gm-res-"))
  const surface = await buildSurface(
    { ZEROCOOL_STATE_DIR: cwd, GIBSON_CLI_CREDENTIALS: join(cwd, "none"), GIBSON_HOST_KEY_PATH: join(cwd, "host.key"), ...env },
    cwd,
    deps,
  )
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  const server = await surface.attach(serverSide)
  const client = new Client({ name: "host", version: "0" })
  await client.connect(clientSide)
  return { surface, client, cwd, close: async () => { await client.close(); await server.close(); await surface.close() } }
}

test("a host reads both resources and the ambient prompt over MCP", async () => {
  const s = await open()
  const uris = (await s.client.listResources()).resources.map((r) => r.uri).sort()
  assert.deepEqual(uris, [AMBIENT_URI, SESSION_URI])

  const session = await s.client.readResource({ uri: SESSION_URI })
  const body = JSON.parse((session.contents[0] as { text: string }).text) as Record<string, unknown>
  assert.equal(body.source, "none")
  assert.equal(body.posture, "standalone")

  const prompts = (await s.client.listPrompts()).prompts.map((p) => p.name)
  assert.deepEqual(prompts, ["gibson_ambient"])
  const prompt = await s.client.getPrompt({ name: "gibson_ambient", arguments: {} })
  // With no platform there is nothing to load, and the prompt says so
  // rather than returning an empty message a model cannot read.
  assert.match((prompt.messages[0]!.content as { text: string }).text, /holds nothing/)
  await s.close()
})

test("a checked-in session writes the hook handoff files beside the host key", async () => {
  const session: GibsonSession = {
    transport: createRouterTransport(() => {}),
    clients: { component: {}, harness: {} } as never,
    componentScope: "scope-1",
    instance: { current: () => "i", heartbeatIntervalMs: () => 1000, renew: async () => "i" },
    instanceId: "i",
    stop: () => {},
  }
  const s = await open(
    { GIBSON_PLATFORM_URL: "https://p", GIBSON_TARGET_ID: "tgt-1" },
    { open: { connect: async () => session, start: async () => live(), hostKeyExists: () => true } },
  )
  const written = JSON.parse(await readFile(join(s.cwd, `live-${keyFor(s.cwd)}.json`), "utf8")) as Record<string, unknown>
  assert.equal(written.missionId, "m-1")
  assert.equal(written.endpoint, "daemon:50001")
  await s.close()
})

test("a dispatched run writes no state file: its launch decided everything", async () => {
  const s = await open(
    { GIBSON_CG_JWT: "jwt", GIBSON_CALLBACK_ENDPOINT: "daemon:50001" },
    { open: { harness: () => harness(), hostKeyExists: () => false } },
  )
  await assert.rejects(readFile(join(s.cwd, `live-${keyFor(s.cwd)}.json`), "utf8"), /ENOENT/)
  await s.close()
})
