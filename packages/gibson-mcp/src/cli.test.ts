// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import test from "node:test"
import { createTarget, enrollIdentity, listTargets, parseTargetList, startLogin, type Spawn, submitMission } from "./cli.js"

/** A fake `gibson` process: scripted stdout, stderr and exit code. */
function fakeSpawn(script: { stdout?: string; stderr?: string; code?: number; hang?: boolean }, seen: string[][] = []): Spawn {
  return ((_cmd: string, args: string[]) => {
    seen.push(args)
    const child = new EventEmitter() as EventEmitter & { stdout: PassThrough; stderr: PassThrough; kill(): void; unref(): void }
    child.stdout = new PassThrough()
    child.stderr = new PassThrough()
    child.kill = () => {}
    child.unref = () => {}
    setImmediate(() => {
      if (script.stdout) child.stdout.write(script.stdout)
      if (script.stderr) child.stderr.write(script.stderr)
      if (!script.hang) child.emit("exit", script.code ?? 0)
    })
    return child as never
  }) as Spawn
}

test("enrollIdentity reads the one-time token off the CLI output and passes url and tenant", async () => {
  const seen: string[][] = []
  const token = await enrollIdentity("gibson-mcp", {
    spawn: fakeSpawn({ stdout: "principal_id:  p-1\nbootstrap_token: tok-abc\ngibson_url:    https://api\n" }, seen),
    gibsonURL: "https://api",
    tenant: "primary",
  })
  assert.equal(token, "tok-abc")
  assert.deepEqual(seen[0], [
    "agent", "enroll", "--name", "gibson-mcp", "--kind", "agent",
    "--capability", "mission:originate", "--capability", "mission:delegate",
    "--gibson-url", "https://api", "--tenant", "primary",
  ])
})

test("enrollIdentity asks for the ceiling an interactive agent needs, unless told otherwise", async () => {
  const seen: string[][] = []
  await enrollIdentity("x", { spawn: fakeSpawn({ stdout: "bootstrap_token: t\n" }, seen), capabilities: ["mission:delegate"] })
  assert.deepEqual(seen[0], ["agent", "enroll", "--name", "x", "--kind", "agent", "--capability", "mission:delegate"])
})

test("enrollIdentity names gibson_login when the CLI has no session", async () => {
  await assert.rejects(
    enrollIdentity("x", { spawn: fakeSpawn({ stderr: "Error: no credentials; run gibson login", code: 1 }) }),
    /Call gibson_login first/,
  )
})

test("parseTargetList reads the tabwriter table and skips the header", () => {
  const out = "UUID                                  NAME        TYPE    STATUS\n" + "11111111-aaaa  workspace   custom  active\n" + "22222222-bbbb  prod api    llm_chat  active\n"
  assert.deepEqual(parseTargetList(out), [
    { id: "11111111-aaaa", name: "workspace", type: "custom", status: "active" },
    { id: "22222222-bbbb", name: "prod api", type: "llm_chat", status: "active" },
  ])
})

test("listTargets and createTarget drive the CLI", async () => {
  const seen: string[][] = []
  const targets = await listTargets({ spawn: fakeSpawn({ stdout: "UUID  NAME  TYPE  STATUS\nt-1  ws  custom  active\n" }, seen) })
  assert.equal(targets[0]?.id, "t-1")
  const id = await createTarget("ws", "git@github.com:o/r.git", { spawn: fakeSpawn({ stdout: "t-new\n" }, seen), gibsonURL: "https://api" })
  assert.equal(id, "t-new")
  assert.deepEqual(seen[1], ["target", "create", "--name", "ws", "--url", "git@github.com:o/r.git", "--type", "custom", "--gibson-url", "https://api"])
})

test("startLogin returns the device URL and code while the CLI keeps waiting", async () => {
  const p = await startLogin({
    spawn: fakeSpawn({ stdout: "\nTo finish signing in, open:\n  https://auth.x/device\nand confirm this code:  ABCD-EFGH\n\nWaiting for approval...\n", hang: true }),
    gibsonURL: "https://api",
  })
  assert.deepEqual(p, { url: "https://auth.x/device", code: "ABCD-EFGH" })
})

test("startLogin fails when the CLI exits before printing a code", async () => {
  await assert.rejects(startLogin({ spawn: fakeSpawn({ stderr: "no such host", code: 1 }) }), /exited with 1/)
})

test("submitMission writes the definition to a file, submits it as the person, and returns the printed mission id", async () => {
  const seen: string[][] = []
  const id = await submitMission({ name: "s" }, "tgt-1", {
    spawn: fakeSpawn({ stdout: "  status\n  node.started\n0f1e2d3c-4b5a-4687-8a9b-0c1d2e3f4a5b\n" }, seen),
    gibsonURL: "https://api",
    tenant: "primary",
  })
  assert.equal(id, "0f1e2d3c-4b5a-4687-8a9b-0c1d2e3f4a5b")
  const args = seen[0]!
  assert.deepEqual(args.slice(0, 2), ["mission", "submit"])
  assert.match(args[2]!, /gibson-mcp-mission-.*session\.json$/)
  assert.deepEqual(args.slice(3), ["--format", "json", "--target", "tgt-1", "--detach", "--gibson-url", "https://api", "--tenant", "primary"])
})

test("submitMission names gibson_login when the CLI has no session", async () => {
  await assert.rejects(
    submitMission({ name: "s" }, "tgt-1", { spawn: fakeSpawn({ stderr: "Error: not signed in; run gibson login\n", code: 1 }) }),
    /gibson_login/,
  )
})

test("submitMission fails loudly when no mission id is printed", async () => {
  await assert.rejects(submitMission({ name: "s" }, "tgt-1", { spawn: fakeSpawn({ stdout: "status\n" }) }), /printed no mission id/)
})

test("submitMission names the CLI update when --detach is unknown", async () => {
  await assert.rejects(
    submitMission({ name: "s" }, "tgt-1", { spawn: fakeSpawn({ stderr: "Error: unknown flag: --detach\n", code: 1 }) }),
    /update the gibson CLI/,
  )
})
