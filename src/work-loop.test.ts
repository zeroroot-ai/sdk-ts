import { test } from "node:test"
import assert from "node:assert/strict"
import { startWorker } from "./work.js"
import type { InstanceRef } from "./component.js"

/**
 * The startWorker loop itself: claim -> handle -> submit, a handler failure
 * answered as an in-band tool error, and an expired instance renewed through
 * the shared ref. The encode/decode helpers have their own tests in
 * work.test.ts; these drive the loop against a fake component client.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

function toolPayload(input: unknown): Uint8Array {
  return enc.encode(JSON.stringify({ inputJson: JSON.stringify(input) }))
}

function fixedRef(id: string): InstanceRef & { renewals: number } {
  const ref = {
    renewals: 0,
    current: () => id,
    heartbeatIntervalMs: () => 15_000,
    renew: async () => {
      ref.renewals += 1
      return id
    },
  }
  return ref
}

/** Resolves once, then parks every later poll until stop() abandons the loop. */
function pollOnce(work: { workId: string; workType: string; payload: Uint8Array }) {
  let delivered = false
  return async () => {
    if (!delivered) {
      delivered = true
      return { ...work, context: {} }
    }
    return new Promise<never>(() => {}) // park: block like a real long-poll
  }
}

test("a claimed work item flows claim -> handler -> submitResult", async () => {
  const submitted: { workId: string; result: Uint8Array }[] = []
  let resolveSubmitted!: () => void
  const done = new Promise<void>((r) => (resolveSubmitted = r))

  const component = {
    pollWork: pollOnce({ workId: "w1", workType: "execute_proto", payload: toolPayload({ url: "https://x" }) }),
    submitResult: async (req: { workId: string; result: Uint8Array }) => {
      submitted.push(req)
      resolveSubmitted()
      return {}
    },
  }

  const stop = startWorker(component as never, fixedRef("i1"), {
    handler: async (item) => ({ echoed: item.input.url }),
  })
  await done
  stop()

  assert.equal(submitted[0].workId, "w1")
  const envelope = JSON.parse(dec.decode(submitted[0].result)) as { outputJson: string }
  assert.deepEqual(JSON.parse(envelope.outputJson), { echoed: "https://x" })
})

test("a handler failure is answered as a tool error, not left to time out", async () => {
  const submitted: { workId: string; result: Uint8Array }[] = []
  const errors: unknown[] = []
  let resolveSubmitted!: () => void
  const done = new Promise<void>((r) => (resolveSubmitted = r))

  const component = {
    pollWork: pollOnce({ workId: "w2", workType: "execute_proto", payload: toolPayload({}) }),
    submitResult: async (req: { workId: string; result: Uint8Array }) => {
      submitted.push(req)
      resolveSubmitted()
      return {}
    },
  }

  const stop = startWorker(component as never, fixedRef("i1"), {
    handler: async () => {
      throw new Error("probe exploded")
    },
    onError: (e) => errors.push(e),
  })
  await done
  stop()

  const envelope = JSON.parse(dec.decode(submitted[0].result)) as { outputJson: string; error: { message: string } }
  assert.equal(envelope.outputJson, "")
  assert.match(envelope.error.message, /probe exploded/)
  assert.equal(errors.length, 1)
})

test("an expired instance renews through the shared ref and keeps polling", async () => {
  const ref = fixedRef("i1")
  let calls = 0
  let resolveRenewed!: () => void
  const renewed = new Promise<void>((r) => (resolveRenewed = r))

  const component = {
    pollWork: async () => {
      calls += 1
      if (calls === 1) throw Object.assign(new Error("instance not found"), { code: "not_found" })
      resolveRenewed()
      return new Promise<never>(() => {}) // park after proving the loop survived
    },
    submitResult: async () => ({}),
  }

  const stop = startWorker(component as never, ref, {
    handler: async () => null,
    backoffMs: 1,
  })
  await renewed
  stop()

  assert.equal(ref.renewals, 1, "NotFound must renew through the shared ref")
  assert.ok(calls >= 2, "the loop must poll again after renewing")
})
