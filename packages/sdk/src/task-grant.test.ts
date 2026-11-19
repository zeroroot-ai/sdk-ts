// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { createRouterTransport } from "@connectrpc/connect"

import { DaemonService } from "./gen/gibson/daemon/v1/daemon_pb.js"
import { NoGatewayGrantError } from "./gateway.js"
import { daemonGrantRenewer, GRANT_RENEW_BEFORE_MS, TaskGrant } from "./task-grant.js"

function jwt(payload: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url")
  return `${b64({ alg: "EdDSA" })}.${b64(payload)}.sig`
}

const NOW = 1_800_000_000_000
/** A renewer for a test that must not renew. */
const stay = async (): Promise<string> => {
  throw new Error("no renewal expected")
}
const grantExpiringIn = (ms: number, tag = "g") =>
  jwt({ sub: "component:agent:a", tenant: "t", mission_id: "m-1", task_id: "t-1", exp: Math.floor((NOW + ms) / 1000), tag })

test("a grant with plenty of time is sent as it is and not renewed", async () => {
  let renewals = 0
  const g = new TaskGrant(grantExpiringIn(10 * 60_000), async () => (renewals++, "x"), () => NOW)
  assert.equal(await g.get(), grantExpiringIn(10 * 60_000))
  assert.equal(renewals, 0)
})

test("a grant within 2 minutes of its expiry is renewed first", async () => {
  assert.equal(GRANT_RENEW_BEFORE_MS, 120_000)
  const fresh = grantExpiringIn(30 * 60_000, "fresh")
  const seen: string[] = []
  const old = grantExpiringIn(90_000, "old")
  const g = new TaskGrant(old, async (cur) => (seen.push(cur), fresh), () => NOW)
  assert.equal(await g.get(), fresh)
  assert.deepEqual(seen, [old])
  assert.equal(await g.get(), fresh, "the new grant is kept")
  assert.equal(seen.length, 1)
})

test("two calls at the same time share one renewal", async () => {
  let renewals = 0
  const fresh = grantExpiringIn(30 * 60_000, "fresh")
  const g = new TaskGrant(
    grantExpiringIn(60_000),
    async () => {
      renewals++
      await new Promise((r) => setTimeout(r, 5))
      return fresh
    },
    () => NOW,
  )
  assert.deepEqual(await Promise.all([g.get(), g.get()]), [fresh, fresh])
  assert.equal(renewals, 1)
})

test("a failed renewal keeps a grant that has not ended", async () => {
  const old = grantExpiringIn(60_000)
  const g = new TaskGrant(old, async () => {
    throw new Error("daemon down")
  }, () => NOW)
  assert.equal(await g.get(), old)
})

test("a failed renewal of a grant that has ended names the renewal failure", async () => {
  const g = new TaskGrant(grantExpiringIn(-1_000), async () => {
    throw new Error("daemon down")
  }, () => NOW)
  await assert.rejects(g.get(), /has ended and the renewal failed/)
})

test("an ended grant with a failed renewal puts the grant in neither the error text nor its cause", async () => {
  const ended = grantExpiringIn(-1_000, "ended")
  const g = new TaskGrant(ended, async (cur) => {
    throw new Error(`renew refused for ${cur}`)
  }, () => NOW)
  const err = (await g.get().then(
    () => assert.fail("must reject"),
    (e: unknown) => e,
  )) as Error
  assert.ok(!err.message.includes(ended), "the error text has no grant")
  assert.ok(!err.message.includes("renew refused"), "the error text does not copy the cause text")
  const cause = err.cause as Error
  assert.match(cause.message, /renew refused for \[task grant\]/)
  assert.ok(!cause.message.includes(ended), "the cause has no grant")
  assert.ok(!String(cause.stack).includes(ended), "the stack of the cause has no grant")
  assert.ok(!JSON.stringify(err, Object.getOwnPropertyNames(err)).includes(ended))
})

test("expiresAt gives the expiry of the grant in force in milliseconds, and 0 when there is none", async () => {
  const fresh = grantExpiringIn(30 * 60_000, "fresh")
  const g = new TaskGrant(grantExpiringIn(60_000), async () => fresh, () => NOW)
  assert.equal(g.expiresAt(), Math.floor((NOW + 60_000) / 1000) * 1000)
  await g.get()
  assert.equal(g.expiresAt(), Math.floor((NOW + 30 * 60_000) / 1000) * 1000, "it follows the renewal")
  assert.equal(new TaskGrant("", async () => fresh).expiresAt(), 0)
  assert.equal(new TaskGrant("not-a-jwt", async () => fresh).expiresAt(), 0)
})

test("a work item with no grant fails before anything is sent", async () => {
  await assert.rejects(new TaskGrant("", stay).get(), NoGatewayGrantError)
  await assert.rejects(async () => await new TaskGrant("", stay).headers()("/v1/responses"), /no task grant: the agent has no task grant to send to the gateway/)
})

test("headers sends the grant in x-capability-grant and no authorization", async () => {
  const g = new TaskGrant(grantExpiringIn(10 * 60_000), stay)
  assert.deepEqual(await g.headers()("/v1/responses"), { "x-capability-grant": grantExpiringIn(10 * 60_000) })
})

test("the renewer calls RenewCapabilityGrant with the claims and presents the current grant", async () => {
  const seen: { req: Record<string, unknown>; header: string | null }[] = []
  const transport = createRouterTransport(({ service }) => {
    service(DaemonService, {
      renewCapabilityGrant: (req, ctx) => {
        seen.push({ req: { ...req }, header: ctx.requestHeader.get("x-capability-grant") })
        return { capabilityGrant: "new-grant" }
      },
    })
  })
  const current = grantExpiringIn(60_000)
  assert.equal(await daemonGrantRenewer(transport)(current), "new-grant")
  assert.equal(seen[0]?.req.agentId, "component:agent:a")
  assert.equal(seen[0]?.req.missionId, "m-1")
  assert.equal(seen[0]?.req.taskId, "t-1")
  assert.equal(seen[0]?.header, current)
})

test("the renewer refuses an empty answer", async () => {
  const transport = createRouterTransport(({ service }) => {
    service(DaemonService, { renewCapabilityGrant: () => ({ capabilityGrant: "" }) })
  })
  await assert.rejects(daemonGrantRenewer(transport)(grantExpiringIn(60_000)), /no grant/)
})
