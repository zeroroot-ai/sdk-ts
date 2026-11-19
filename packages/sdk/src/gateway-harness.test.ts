// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"
import { Task, TaskState } from "@a2a-js/sdk"

import { newMessage, Role, textPart } from "./a2a.js"
import { HarnessCallbackService } from "./clients.js"
import { NoGatewayGrantError } from "./gateway.js"
import { responseText, userMessage } from "./openresponses.js"
import { openTaskHarness } from "./task-harness.js"
import { startAgentWorker } from "./work.js"
import type { InstanceRef } from "./component.js"
import { makeTestCa, startTlsServer } from "./tls-fixture.test.js"

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA" })}.${b64(payload)}.sig`
}
const farGrant = (tag = "g") =>
  jwt({ sub: "component:agent:a", tenant: "t", mission_id: "m-1", task_id: "t-1", mrid: "run-1", exp: 4_000_000_000, tag })

const reply = `{"id":"r","status":"completed","model":"m","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"hi"}]}]}`

/** A gateway on a private CA that serves a model reply and an A2A task. */
async function gateway(ca: ReturnType<typeof makeTestCa>) {
  const seen: { path: string; headers: Record<string, unknown>; body: string }[] = []
  const srv = await startTlsServer(ca, (req, res) => {
    const chunks: Buffer[] = []
    req.on("data", (c: Buffer) => chunks.push(c))
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8")
      seen.push({ path: req.url ?? "", headers: req.headers, body })
      res.setHeader("content-type", "application/json")
      if (req.url === "/v1/responses") return void res.end(reply)
      const rpc = JSON.parse(body) as { id: unknown }
      const task = Task.toJSON({
        id: "t-9",
        contextId: "c",
        status: { state: TaskState.TASK_STATE_COMPLETED, message: undefined, timestamp: undefined },
        artifacts: [],
        history: [],
        metadata: undefined,
      })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: rpc.id, result: { task } }))
    })
  })
  return { ...srv, seen }
}

test("the callback harness resolves a model and calls it with the task grant", async () => {
  const ca = makeTestCa()
  const gw = await gateway(ca)
  const requests: Record<string, unknown>[] = []
  try {
    const transport = createRouterTransport(({ service }) => {
      service(HarnessCallbackService, {
        resolveModel: (req) => {
          requests.push({ ...req })
          return {
            model: "claude-x",
            provider: "anthropic-main",
            gatewayUrl: gw.url,
            routeHeaders: { "x-gibson-tenant": "t", "x-gibson-provider": "anthropic-main" },
            contextWindow: 200000,
            maxOutputTokens: 8192,
            gatewayCaPem: ca.caPem,
          }
        },
      })
    })
    const token = farGrant()
    const harness = openTaskHarness({ endpoint: "d:443", token, transport, renew: false })
    const resolved = await harness.resolveModel("primary")
    assert.equal(resolved.model, "claude-x")
    assert.equal((requests[0] as { slot: string }).slot, "primary")
    assert.equal((requests[0] as { context: { missionId: string } }).context.missionId, "m-1")

    const model = await harness.model("primary")
    assert.equal(model.provider, "anthropic-main")
    assert.equal(responseText(await model.create({ input: [userMessage("x")] })), "hi")
    assert.equal(gw.seen[0]?.headers["x-capability-grant"], token)
    assert.equal(gw.seen[0]?.headers["x-gibson-provider"], "anthropic-main")
    assert.equal(gw.seen[0]?.headers.authorization, undefined)
    harness.stop()
  } finally {
    await gw.close()
    ca.cleanup()
  }
})

test("the callback harness resolves an agent with a bank and delegates through the gateway", async () => {
  const ca = makeTestCa()
  const gw = await gateway(ca)
  const asked: { name: string; bankId?: string }[] = []
  try {
    const transport = createRouterTransport(({ service }) => {
      service(HarnessCallbackService, {
        resolveAgent: (req) => {
          asked.push({ name: req.name, bankId: req.bankId })
          return {
            gatewayUrl: `${gw.url}/a2a/helper`,
            routeHeaders: { "x-gibson-agent": "helper" },
            gatewayCaPem: ca.caPem,
            agentCardUrl: `${gw.url}/a2a/helper/card`,
          }
        },
      })
    })
    const token = farGrant()
    const harness = openTaskHarness({ endpoint: "d:443", token, transport, renew: false })
    const agent = await harness.resolveAgent("helper", { bankId: "bank-1" })
    assert.equal(agent.agentCardUrl, `${gw.url}/a2a/helper/card`)
    const task = await harness.delegate("helper", newMessage(Role.ROLE_USER, [textPart("go")]), { bankId: "bank-2" })
    assert.equal(task.id, "t-9")
    assert.deepEqual(asked, [
      { name: "helper", bankId: "bank-1" },
      { name: "helper", bankId: "bank-2" },
    ])
    assert.equal(gw.seen[0]?.path, "/a2a/helper")
    assert.equal(gw.seen[0]?.headers["x-capability-grant"], token)
    assert.equal(gw.seen[0]?.headers["x-gibson-agent"], "helper")
    harness.stop()
  } finally {
    await gw.close()
    ca.cleanup()
  }
})

test("a resolve with an unset bank sends no bank id", async () => {
  let seen: { bankId?: string } | undefined
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, {
      resolveAgent: (req) => {
        seen = { bankId: req.bankId }
        return { gatewayUrl: "https://x", routeHeaders: {}, gatewayCaPem: "", agentCardUrl: "" }
      },
    })
  })
  const harness = openTaskHarness({ endpoint: "d:443", token: farGrant(), transport, renew: false })
  await harness.resolveAgent("helper")
  assert.equal(seen?.bankId, undefined)
  harness.stop()
})

test("the model client needs a model and a URL from the daemon", async () => {
  const transport = createRouterTransport(({ service }) => {
    service(HarnessCallbackService, {
      resolveModel: () => ({ model: "", provider: "", gatewayUrl: "", routeHeaders: {}, contextWindow: 0, maxOutputTokens: 0, gatewayCaPem: "" }),
    })
  })
  const harness = openTaskHarness({ endpoint: "d:443", token: farGrant(), transport, renew: false })
  await assert.rejects(harness.model("primary"), /no model/)
  harness.stop()
})

// ── pull mode ───────────────────────────────────────────────────────────────

function fixedRef(id: string): InstanceRef {
  return { current: () => id, heartbeatIntervalMs: () => 15_000, renew: async () => id }
}

function workMessage(): Uint8Array {
  return new TextEncoder().encode(
    JSON.stringify({ messageId: "m", role: "ROLE_USER", taskId: "task-1", contextId: "ctx-1", parts: [{ text: "go" }] }),
  )
}

/** Run one work item through a worker with the given poll reply and component calls. */
async function runWork(
  poll: Record<string, unknown>,
  component: Record<string, unknown>,
  handler: Parameters<typeof startAgentWorker>[2]["handler"],
  renewGrant?: (cur: string) => Promise<string>,
) {
  let delivered = false
  let done!: () => void
  const finished = new Promise<void>((r) => (done = r))
  const comp = {
    pollWork: async () => {
      if (!delivered) {
        delivered = true
        return { workId: "w1", workType: "execute", payload: workMessage(), context: {}, ...poll }
      }
      return new Promise<never>(() => {})
    },
    submitResult: async () => (done(), {}),
    ...component,
  }
  const stop = startAgentWorker(comp as never, fixedRef("i"), { handler, onError: () => {}, ...(renewGrant ? { renewGrant } : {}) })
  await finished
  stop()
}

test("the pull harness resolves a model with the work id and sends the grant of the poll reply", async () => {
  const ca = makeTestCa()
  const gw = await gateway(ca)
  const token = farGrant("pull")
  const asked: Record<string, unknown>[] = []
  try {
    let text = ""
    await runWork(
      { taskGrant: token },
      {
        resolveModel: async (req: Record<string, unknown>) => {
          asked.push(req)
          return {
            model: "m",
            provider: "p",
            gatewayUrl: gw.url,
            routeHeaders: { "x-gibson-provider": "p" },
            contextWindow: 0,
            maxOutputTokens: 0,
            gatewayCaPem: ca.caPem,
          }
        },
      },
      async ({ harness }) => {
        text = responseText(await (await harness.model("primary")).create({ input: [userMessage("x")] }))
        return {}
      },
    )
    assert.equal(text, "hi")
    assert.deepEqual(asked, [{ workId: "w1", slot: "primary" }])
    assert.equal(gw.seen[0]?.headers["x-capability-grant"], token)
  } finally {
    await gw.close()
    ca.cleanup()
  }
})

test("the pull harness resolves an agent with the work id and a bank", async () => {
  const asked: Record<string, unknown>[] = []
  await runWork(
    { taskGrant: farGrant() },
    {
      resolveAgent: async (req: Record<string, unknown>) => {
        asked.push(req)
        return { gatewayUrl: "https://gw/a2a/h", routeHeaders: { a: "b" }, gatewayCaPem: "", agentCardUrl: "https://gw/card" }
      },
    },
    async ({ harness }) => {
      const r = await harness.resolveAgent("helper", { bankId: "bank-1" })
      assert.equal(r.agentCardUrl, "https://gw/card")
      assert.deepEqual(r.routeHeaders, { a: "b" })
      return {}
    },
  )
  assert.deepEqual(asked, [{ workId: "w1", name: "helper", bankId: "bank-1" }])
})

test("a work item with no task grant fails each gateway call before it is sent", async () => {
  const ca = makeTestCa()
  const gw = await gateway(ca)
  try {
    let failure: unknown
    await runWork(
      { taskGrant: "" },
      {
        resolveModel: async () => ({
          model: "m", provider: "p", gatewayUrl: gw.url, routeHeaders: {}, contextWindow: 0, maxOutputTokens: 0, gatewayCaPem: ca.caPem,
        }),
      },
      async ({ harness }) => {
        try {
          await (await harness.model("primary")).create({ input: [userMessage("x")] })
        } catch (e) {
          failure = e
        }
        return {}
      },
    )
    assert.ok(failure instanceof NoGatewayGrantError || /no task grant/.test((failure as Error).message))
    assert.equal(gw.seen.length, 0, "nothing reached the gateway")
  } finally {
    await gw.close()
    ca.cleanup()
  }
})

test("the pull harness renews a grant that is near its expiry", async () => {
  const ca = makeTestCa()
  const gw = await gateway(ca)
  const soon = jwt({ sub: "component:agent:a", mission_id: "m-1", task_id: "t-1", exp: Math.floor(Date.now() / 1000) + 30 })
  const fresh = farGrant("fresh")
  const renewed: string[] = []
  try {
    await runWork(
      { taskGrant: soon },
      {
        resolveModel: async () => ({
          model: "m", provider: "p", gatewayUrl: gw.url, routeHeaders: {}, contextWindow: 0, maxOutputTokens: 0, gatewayCaPem: ca.caPem,
        }),
      },
      async ({ harness }) => {
        await (await harness.model("primary")).create({ input: [userMessage("x")] })
        return {}
      },
      async (cur) => (renewed.push(cur), fresh),
    )
    assert.deepEqual(renewed, [soon])
    assert.equal(gw.seen[0]?.headers["x-capability-grant"], fresh)
  } finally {
    await gw.close()
    ca.cleanup()
  }
})

test("the handler reads the task grant of the poll reply with token()", async () => {
  const token = farGrant("read")
  let read = ""
  await runWork({ taskGrant: token }, {}, async ({ harness }) => {
    read = await harness.token()
    return {}
  })
  assert.equal(read, token)
})

test("token() gives the renewed grant after a renewal, and the daemon renews one time", async () => {
  const soon = jwt({ sub: "component:agent:a", mission_id: "m-1", task_id: "t-1", exp: Math.floor(Date.now() / 1000) + 30 })
  const fresh = farGrant("fresh")
  const renewed: string[] = []
  let first = ""
  let second = ""
  await runWork(
    { taskGrant: soon },
    {},
    async ({ harness }) => {
      first = await harness.token()
      second = await harness.token()
      return {}
    },
    async (cur) => (renewed.push(cur), fresh),
  )
  assert.equal(first, fresh, "the first read renews the grant that is near its expiry")
  assert.equal(second, fresh)
  assert.deepEqual(renewed, [soon])
  assert.notEqual(first, soon)
})

test("the handler gets the Model gateway endpoint from resolveModel, as the daemon sent it", async () => {
  let url = ""
  await runWork(
    { taskGrant: farGrant() },
    {
      resolveModel: async () => ({
        model: "m", provider: "p", gatewayUrl: "https://model-gw.example:8443/v1", routeHeaders: {}, contextWindow: 0, maxOutputTokens: 0, gatewayCaPem: "",
      }),
    },
    async ({ harness }) => {
      url = (await harness.resolveModel("primary")).gatewayUrl
      return {}
    },
  )
  assert.equal(url, "https://model-gw.example:8443/v1")
})

test("token() of a work item with no grant fails before any call", async () => {
  let failure: unknown
  await runWork({ taskGrant: "" }, {}, async ({ harness }) => {
    try {
      await harness.token()
    } catch (e) {
      failure = e
    }
    return {}
  })
  assert.ok(failure instanceof NoGatewayGrantError)
})

test("a failed renewal of an ended grant does not put the grant in the error", async () => {
  const ended = jwt({ sub: "component:agent:a", mission_id: "m-1", task_id: "t-1", exp: Math.floor(Date.now() / 1000) - 10 })
  let message = ""
  await runWork(
    { taskGrant: ended },
    {},
    async ({ harness }) => {
      try {
        await harness.token()
      } catch (e) {
        message = (e as Error).message
      }
      return {}
    },
    async () => {
      throw new Error("daemon down")
    },
  )
  assert.match(message, /renewal failed: daemon down/)
  assert.ok(!message.includes(ended))
})
