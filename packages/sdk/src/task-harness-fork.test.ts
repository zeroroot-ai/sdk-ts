// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { createServer } from "node:http"
import { createServer as createH2Server } from "node:http2"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { connectNodeAdapter } from "@connectrpc/connect-node"

import { HarnessCallbackService } from "./clients.js"
import { park, Watcher } from "./fork.js"
import { CAPABILITY_GRANT_HEADER, IDENTITY_SOCKET_ENV, NoSandboxIdentityError, openTaskHarness, SANDBOX_IDENTITY_HEADER } from "./task-harness.js"

/** The fork contract over the real task harness (D74, zeroroot-ai/sdk#248, sdk#251). */

function fakeJwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA", typ: "JWT" })}.${b64(payload)}.sig`
}

const PARENT = fakeJwt({ sub: "component:agent:zerocool", tenant: "t-1", mission_id: "parent-1", task_id: "task-a", exp: 0 })
const FORK = fakeJwt({ sub: "component:agent:zerocool", tenant: "t-1", mission_id: "child-1", task_id: "task-b", exp: 0 })

/** A fake setec identity socket. Each request gets a new token of the current generation. */
async function identitySocket() {
  const dir = mkdtempSync(join(tmpdir(), "id"))
  const path = join(dir, "identity.sock")
  const state = { generation: 0, requests: 0 }
  const server = createServer((_req, res) => {
    state.requests++
    res.end(JSON.stringify({ token: `gen${state.generation}-req${state.requests}` }))
  })
  await new Promise<void>((r) => server.listen(path, r))
  return {
    path,
    snapshot: () => void state.generation++,
    close: async () => {
      await new Promise<void>((r) => server.close(() => r()))
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

interface Seen {
  method: string
  grant: string | null
  identity: string | null
  sandboxId?: string
  missionId?: string
  taskId?: string
}

/** The callback service of the daemon over h2c. It records each call. */
async function daemon() {
  const seen: Seen[] = []
  const server = createH2Server(
    connectNodeAdapter({
      routes: (router) =>
        router.service(HarnessCallbackService, {
          claimFork: async (req, ctx) => {
            seen.push({ method: "claimFork", grant: ctx.requestHeader.get(CAPABILITY_GRANT_HEADER), identity: ctx.requestHeader.get(SANDBOX_IDENTITY_HEADER), sandboxId: req.sandboxId })
            return { grant: FORK, missionId: "child-1", missionRunId: "child-run-1", agentRunId: "fork-run-1", nodeId: "node-b", model: "model-x", task: { id: "task-b", goal: "scan the next host" } }
          },
          getMissionRunHistory: async (req, ctx) => {
            seen.push({
              method: "getMissionRunHistory",
              grant: ctx.requestHeader.get(CAPABILITY_GRANT_HEADER),
              identity: ctx.requestHeader.get(SANDBOX_IDENTITY_HEADER),
              missionId: req.context?.missionId,
              taskId: req.context?.taskId,
            })
            return {}
          },
        }),
    }),
  )
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return { endpoint: `127.0.0.1:${address.port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) }
}

async function withSocketEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const old = process.env[IDENTITY_SOCKET_ENV]
  if (value === undefined) delete process.env[IDENTITY_SOCKET_ENV]
  else process.env[IDENTITY_SOCKET_ENV] = value
  try {
    await fn()
  } finally {
    if (old === undefined) delete process.env[IDENTITY_SOCKET_ENV]
    else process.env[IDENTITY_SOCKET_ENV] = old
  }
}

test("a parked source that is forked claims once with the parent grant and its own token, then acts as the fork", async () => {
  const sock = await identitySocket()
  const d = await daemon()
  try {
    await withSocketEnv(sock.path, async () => {
      const h = openTaskHarness({ endpoint: d.endpoint, token: PARENT, insecure: true, renew: false, missionRunId: "parent-run-1" })
      let name = "sbx-parent"
      const w = Watcher.withReader(() => name)
      await h.client.getMissionRunHistory({ context: h.context })
      setTimeout(() => {
        sock.snapshot()
        name = "sbx-fork-1"
      }, 20)
      const claim = await park(w, h, { timeoutMs: 5_000, pollIntervalMs: 5 })
      assert.ok(claim)
      assert.equal(claim.nodeId, "node-b")
      assert.equal(claim.task?.id, "task-b")
      h.applyClaim(claim)
      await h.client.getMissionRunHistory({ context: h.context })
      h.stop()
    })
    assert.deepEqual(d.seen, [
      { method: "getMissionRunHistory", grant: PARENT, identity: "gen0-req1", missionId: "parent-1", taskId: "task-a" },
      { method: "claimFork", grant: PARENT, identity: "gen1-req2", sandboxId: "sbx-fork-1" },
      { method: "getMissionRunHistory", grant: FORK, identity: "gen1-req3", missionId: "child-1", taskId: "task-b" },
    ])
  } finally {
    await d.close()
    await sock.close()
  }
})

test("applyClaim moves the context and the grant, and refuses a claim with no grant", async () => {
  const h = openTaskHarness({ endpoint: "d:443", token: PARENT, renew: false, missionRunId: "parent-run-1" })
  const ctx = h.context
  assert.throws(() => h.applyClaim({ sandboxId: "s", grant: "", missionId: "", missionRunId: "", agentRunId: "", nodeId: "", model: "", task: undefined }), /no grant/)
  assert.equal(h.token(), PARENT)
  h.applyClaim({ sandboxId: "s", grant: FORK, missionId: "child-1", missionRunId: "", agentRunId: "a", nodeId: "n", model: "", task: undefined })
  assert.equal(h.token(), FORK)
  assert.equal(ctx, h.context, "the context changes in place")
  assert.deepEqual(h.context, { missionId: "child-1", taskId: "task-b", agentName: "zerocool" })
  h.stop()
})

test("claimFork with no identity socket is refused before the call", async () => {
  const d = await daemon()
  try {
    await withSocketEnv(undefined, async () => {
      const h = openTaskHarness({ endpoint: d.endpoint, token: PARENT, insecure: true, renew: false })
      await assert.rejects(h.claimFork("sbx-fork-1"), NoSandboxIdentityError)
      h.stop()
    })
    assert.equal(d.seen.length, 0, "no call is sent")
  } finally {
    await d.close()
  }
})

