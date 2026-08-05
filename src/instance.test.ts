import assert from "node:assert/strict"
import test from "node:test"

import { registerInstance } from "./component.js"

/** A ComponentService stub that counts registrations and hands out fresh ids. */
function fakeComponent() {
  let n = 0
  const calls: string[] = []
  return {
    calls,
    registrations: () => n,
    client: {
      registerComponent: async (req: { kind: string }) => {
        n += 1
        calls.push(req.kind)
        return { instanceId: `inst-${n}`, heartbeatIntervalMs: 20_000 }
      },
    } as never,
  }
}

test("registerInstance exposes the id the daemon assigned", async () => {
  const c = fakeComponent()
  const ref = await registerInstance(c.client, "tool", { name: "probe", version: "1" })
  assert.equal(ref.current(), "inst-1")
  assert.equal(ref.heartbeatIntervalMs(), 20_000)
})

test("renew adopts the new id so every caller sees it", async () => {
  // The defect this guards: the heartbeat and the work loop each held their own
  // id, so a renewal by one left the other polling an instance the daemon had
  // already expired — a process that looks healthy and receives nothing.
  const c = fakeComponent()
  const ref = await registerInstance(c.client, "tool", { name: "probe", version: "1" })
  const renewed = await ref.renew()
  assert.equal(renewed, "inst-2")
  assert.equal(ref.current(), "inst-2", "every holder of the ref must see the new id")
})

test("renew re-registers under the ORIGINAL kind", async () => {
  // Renewing as a different kind would move the process to a queue nothing
  // dispatches to, while it kept reporting itself healthy.
  const c = fakeComponent()
  const ref = await registerInstance(c.client, "tool", { name: "probe", version: "1" })
  await ref.renew()
  assert.deepEqual(c.calls, ["tool", "tool"])
})

test("concurrent renewals share one registration", async () => {
  // A heartbeat and a poll can discover the loss in the same instant. Two
  // registrations would leave an orphan instance heartbeating forever.
  const c = fakeComponent()
  const ref = await registerInstance(c.client, "tool", { name: "probe", version: "1" })
  const [a, b] = await Promise.all([ref.renew(), ref.renew()])
  assert.equal(a, b)
  assert.equal(c.registrations(), 2, "one initial registration plus one renewal")
})

test("a later renewal still works after an in-flight one settles", async () => {
  const c = fakeComponent()
  const ref = await registerInstance(c.client, "tool", { name: "probe", version: "1" })
  await ref.renew()
  await ref.renew()
  assert.equal(ref.current(), "inst-3")
})
