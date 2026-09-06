// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, symlink } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"

/**
 * The bin as a host runs it. npm installs a bin as a symlink named after the
 * bin, so argv[1] is never "main.js": a guard on it made an earlier server
 * exit 0 with no output. The test runs the symlink, exactly as npm would.
 */
async function binEnv(): Promise<{ dir: string; link: string; env: Record<string, string> }> {
  const dir = await mkdtemp(join(tmpdir(), "gm-bin-"))
  const link = join(dir, "gibson-mcp")
  await symlink(new URL("./main.js", import.meta.url).pathname, link)
  return {
    dir,
    link,
    env: {
      PATH: process.env.PATH ?? "",
      HOME: dir,
      ZEROCOOL_STATE_DIR: dir,
      GIBSON_HOST_KEY_PATH: join(dir, "host.key"),
      GIBSON_CLI_CREDENTIALS: join(dir, "none"),
    },
  }
}

test("a host spawns the bin on stdio and lists its tools", async () => {
  const { link, env } = await binEnv()
  const client = new Client({ name: "host", version: "0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [link], env }))
  const names = (await client.listTools()).tools.map((t) => t.name).sort()
  assert.deepEqual(names, ["componentize", "gibson_connect", "gibson_login", "gibson_status", "submit_finding", "validate_component"])
  const res = await client.callTool({ name: "gibson_status", arguments: {} })
  assert.match((res.content as { text: string }[])[0]!.text, /posture: standalone/)
  await client.close()
})

test("the bin exits 0 when stdio closes, and logs its posture to stderr", async () => {
  const { link, env } = await binEnv()
  const { spawn } = await import("node:child_process")
  const stderr: string[] = []
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [link], { env, stdio: ["pipe", "pipe", "pipe"] })
    child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()))
    child.stdin.end() // a host closing stdio ends the session
    child.on("exit", (c) => resolve(c ?? -1))
  })
  assert.equal(code, 0)
  assert.match(stderr.join(""), /\[gibson-mcp\] source: none/, "the bin must run main() and log its posture")
})

test("--help names the flag and says the RPCs are reachable either way", async () => {
  const { link, env } = await binEnv()
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const help = (await promisify(execFile)(process.execPath, [link, "--help"], { env })).stdout
  assert.match(help, /--expose-all-rpcs/)
  assert.match(help, /gibson_api_search and gibson_api_call/)
})

test("--help and --version print and exit without serving", async () => {
  const { link, env } = await binEnv()
  const { execFile } = await import("node:child_process")
  const { promisify } = await import("node:util")
  const run = promisify(execFile)
  const help = await run(process.execPath, [link, "--help"], { env })
  assert.match(help.stdout, /--transport stdio\|http/)
  const version = await run(process.execPath, [link, "--version"], { env })
  assert.match(version.stdout.trim(), /^\d+\.\d+\.\d+/)
})

test("a non-loopback --listen is refused before anything is served", async () => {
  const { link, env } = await binEnv()
  const { spawn } = await import("node:child_process")
  const stderr: string[] = []
  const code = await new Promise<number>((resolve) => {
    const child = spawn(process.execPath, [link, "--transport", "http", "--listen", "0.0.0.0:9999"], { env, stdio: ["ignore", "ignore", "pipe"] })
    child.stderr.on("data", (d: Buffer) => stderr.push(d.toString()))
    child.on("exit", (c) => resolve(c ?? -1))
  })
  assert.equal(code, 2)
  assert.match(stderr.join(""), /loopback/)
})
