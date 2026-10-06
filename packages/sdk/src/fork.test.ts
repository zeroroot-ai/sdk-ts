// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { hostname } from "node:os"
import test from "node:test"
import { Code, ConnectError } from "@connectrpc/connect"
import { BinaryWriter } from "@bufbuild/protobuf/wire"

import {
  type Claim,
  type Claimer,
  DEFAULT_PARK_TIMEOUT_MS,
  FORK_ERROR_DOMAIN,
  FORKABLE_ENV,
  ForkedError,
  forkable,
  isForkUnclaimed,
  PARK_TIMEOUT_ENV,
  park,
  parkTimeout,
  point,
  REASON_FORK_UNCLAIMED,
  sandboxId,
  Watcher,
} from "./fork.js"

/** A hostname that a test changes, as a fork changes it. */
function host(name: string) {
  const h = { name, read: () => h.name, set: (n: string) => void (h.name = n) }
  return h
}

/** Records each claim and answers with a fixed dispatch. */
function claimer(error?: unknown): Claimer & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    claimFork: async (id: string): Promise<Claim> => {
      calls.push(id)
      if (error) throw error
      return { sandboxId: id, grant: "fork-grant", missionId: "", missionRunId: "", agentRunId: "", nodeId: "node-b", model: "", task: undefined }
    },
  }
}

test("sandboxId is the trimmed hostname, and a watcher records it", () => {
  assert.equal(sandboxId(), hostname().trim())
  assert.equal(Watcher.create().origin, hostname().trim())
})

test("point in the parent claims nothing", async () => {
  const w = Watcher.withReader(host("sbx-parent").read)
  const c = claimer()
  assert.equal(await point(w, c), undefined)
  assert.equal(c.calls.length, 0)
})

test("point in a fork claims with the new id", async () => {
  const h = host("sbx-parent")
  const w = Watcher.withReader(h.read)
  h.set("sbx-fork-1")
  const claim = await point(w, claimer())
  assert.equal(claim?.sandboxId, "sbx-fork-1")
  assert.equal(claim?.grant, "fork-grant")
})

test("point reports a failed claim with the error of the daemon", async () => {
  const h = host("sbx-parent")
  const w = Watcher.withReader(h.read)
  h.set("sbx-fork-1")
  await assert.rejects(point(w, claimer(new ConnectError("claimed", Code.AlreadyExists))), (err: Error) => {
    assert.match(err.message, /sbx-fork-1/)
    assert.equal(ConnectError.from(err.cause).code, Code.AlreadyExists)
    return true
  })
})

test("park returns the claim after a fork", async () => {
  const h = host("sbx-parent")
  const w = Watcher.withReader(h.read)
  setTimeout(() => h.set("sbx-fork-2"), 30)
  const claim = await park(w, claimer(), { timeoutMs: 5_000, pollIntervalMs: 5 })
  assert.equal(claim?.sandboxId, "sbx-fork-2")
})

test("park in the parent ends at the timeout and claims nothing", async () => {
  const w = Watcher.withReader(host("sbx-parent").read)
  const c = claimer()
  const start = Date.now()
  assert.equal(await park(w, c, { timeoutMs: 40, pollIntervalMs: 5 }), undefined)
  assert.ok(Date.now() - start >= 39, "park returned before the timeout")
  assert.equal(c.calls.length, 0)
})

test("park ends with the signal", async () => {
  const w = Watcher.withReader(host("sbx-parent").read)
  await assert.rejects(park(w, claimer(), { timeoutMs: 60_000, pollIntervalMs: 1, signal: AbortSignal.abort() }), /aborted/)
  const ac = new AbortController()
  setTimeout(() => ac.abort(), 10)
  await assert.rejects(park(w, claimer(), { timeoutMs: 60_000, pollIntervalMs: 60_000, signal: ac.signal }), /aborted/)
})

test("park takes the defaults: a fork found on the first check returns at once", async () => {
  const h = host("sbx-parent")
  const w = Watcher.withReader(h.read)
  h.set("sbx-fork-3")
  assert.equal((await park(w, claimer()))?.sandboxId, "sbx-fork-3")
})

test("forkable and parkTimeout read the launch", () => {
  assert.equal(forkable({}), false)
  assert.equal(forkable({ [FORKABLE_ENV]: "1" }), true)
  assert.equal(forkable({ [FORKABLE_ENV]: "true" }), false)
  assert.equal(parkTimeout({}), DEFAULT_PARK_TIMEOUT_MS)
  assert.equal(parkTimeout({ [PARK_TIMEOUT_ENV]: "" }), DEFAULT_PARK_TIMEOUT_MS)
  assert.equal(parkTimeout({ [PARK_TIMEOUT_ENV]: "90s" }), 90_000)
  assert.equal(parkTimeout({ [PARK_TIMEOUT_ENV]: "1h30m" }), 5_400_000)
  assert.equal(parkTimeout({ [PARK_TIMEOUT_ENV]: "1.5s" }), 1_500)
  for (const bad of ["soon", "0s", "-1m", "10", "5x"]) {
    assert.throws(() => parkTimeout({ [PARK_TIMEOUT_ENV]: bad }), new RegExp(PARK_TIMEOUT_ENV), `accepted ${bad}`)
  }
})

/** The refusal that the daemon sends, with a google.rpc.ErrorInfo detail. */
function unclaimed(code: Code, reason: string, domain: string): ConnectError {
  const info = new BinaryWriter().tag(1, 2).string(reason).tag(2, 2).string(domain).finish()
  return new ConnectError("the grant belongs to another sandbox", code, undefined, [{ type: "google.rpc.ErrorInfo", value: info } as never])
}

test("isForkUnclaimed recognizes the refusal and nothing else", () => {
  const cases: [string, unknown, boolean][] = [
    ["the refusal", unclaimed(Code.FailedPrecondition, REASON_FORK_UNCLAIMED, FORK_ERROR_DOMAIN), true],
    ["another reason", unclaimed(Code.FailedPrecondition, "OTHER", FORK_ERROR_DOMAIN), false],
    ["another domain", unclaimed(Code.FailedPrecondition, REASON_FORK_UNCLAIMED, "other.v1"), false],
    ["another code", unclaimed(Code.PermissionDenied, REASON_FORK_UNCLAIMED, FORK_ERROR_DOMAIN), false],
    ["a broken detail", new ConnectError("x", Code.FailedPrecondition, undefined, [{ type: "google.rpc.ErrorInfo", value: new Uint8Array([0x0a, 0x05]) } as never]), false],
    ["no details", new ConnectError("x", Code.FailedPrecondition), false],
    ["not a status", new Error("x"), false],
    ["undefined", undefined, false],
  ]
  for (const [name, err, want] of cases) assert.equal(isForkUnclaimed(err), want, name)
})

test("ForkedError names the fork and carries the claim", () => {
  const claim = { sandboxId: "sbx-fork-1", grant: "g", missionId: "", missionRunId: "", agentRunId: "", nodeId: "node-b", model: "", task: undefined }
  const err = new ForkedError(claim)
  assert.match(err.message, /sbx-fork-1.*node-b/)
  assert.equal(err.claim.nodeId, "node-b")
  assert.ok(err instanceof Error)
})
