// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { spawn as nodeSpawn, type ChildProcess } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * The `gibson` CLI as the session's user. It holds the login session
 * (`gibson login`, a browser device flow), so it is the one process on the
 * host that can mint an enrollment token or create a target. The plugin
 * drives it instead of asking a person to copy tokens between terminals.
 */
export type Spawn = (cmd: string, args: string[], opts: { detached?: boolean; env?: NodeJS.ProcessEnv }) => ChildProcess

export interface CliOptions {
  bin?: string
  env?: NodeJS.ProcessEnv
  spawn?: Spawn
  timeoutMs?: number
}

export interface CliResult {
  code: number
  stdout: string
  stderr: string
}

export async function runGibson(args: string[], opts: CliOptions = {}): Promise<CliResult> {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn)
  const child = spawn(opts.bin ?? opts.env?.GIBSON_CLI ?? "gibson", args, { env: opts.env ?? process.env })
  return await new Promise<CliResult>((resolve, reject) => {
    const out: string[] = []
    const err: string[] = []
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`gibson ${args[0] ?? ""} ${args[1] ?? ""} timed out after ${opts.timeoutMs ?? 60_000}ms`))
    }, opts.timeoutMs ?? 60_000)
    child.stdout?.on("data", (d: Buffer) => out.push(d.toString()))
    child.stderr?.on("data", (d: Buffer) => err.push(d.toString()))
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(new Error(`cannot run the gibson CLI (${e.message}). Install it: see https://github.com/zeroroot-ai/adk`))
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      resolve({ code: code ?? -1, stdout: out.join(""), stderr: err.join("") })
    })
  })
}

/** True when the CLI's failure reads as "no login session". */
export function needsLogin(r: CliResult): boolean {
  return /login|credentials|unauthenticated|token expired|not signed in/i.test(r.stderr + r.stdout)
}

/**
 * `gibson agent enroll`: mint a one-time bootstrap token for a new machine
 * identity, authenticated as the person who ran `gibson login`.
 */
/**
 * The session capabilities an interactive coding agent needs in its
 * credential's ceiling (ADR-0045): it starts its own live mission
 * (gibson#1593 decision 9) and may hand sub-tasks to other agents.
 */
export const INTERACTIVE_AGENT_CAPABILITIES = ["mission:originate", "mission:delegate"] as const

export async function enrollIdentity(name: string, opts: CliOptions & { gibsonURL?: string; tenant?: string; capabilities?: readonly string[] } = {}): Promise<string> {
  const args = ["agent", "enroll", "--name", name, "--kind", "agent"]
  for (const c of opts.capabilities ?? INTERACTIVE_AGENT_CAPABILITIES) args.push("--capability", c)
  if (opts.gibsonURL) args.push("--gibson-url", opts.gibsonURL)
  if (opts.tenant) args.push("--tenant", opts.tenant)
  const r = await runGibson(args, opts)
  const m = /^bootstrap_token:\s*(\S+)/m.exec(r.stdout)
  if (r.code !== 0 || !m) {
    const why = (r.stderr || r.stdout).trim()
    throw new Error(
      needsLogin(r)
        ? `the gibson CLI has no login session (${why}). Call gibson_login first.`
        : `gibson agent enroll failed (exit ${r.code}): ${why || "no bootstrap_token in the output"}`,
    )
  }
  return m[1]!
}

export interface Target {
  id: string
  name: string
  type: string
  status: string
}

/** `gibson target list`, a tabwriter table: UUID NAME TYPE STATUS. */
export function parseTargetList(stdout: string): Target[] {
  return stdout
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^UUID\s+NAME/.test(l))
    .map((l) => l.split(/\s{2,}|\t/))
    .filter((cols) => cols.length >= 2)
    .map(([id, name, type, status]) => ({ id: id!, name: name ?? "", type: type ?? "", status: status ?? "" }))
}

export async function listTargets(opts: CliOptions & { gibsonURL?: string; tenant?: string } = {}): Promise<Target[]> {
  const args = ["target", "list"]
  if (opts.gibsonURL) args.push("--gibson-url", opts.gibsonURL)
  if (opts.tenant) args.push("--tenant", opts.tenant)
  const r = await runGibson(args, opts)
  if (r.code !== 0) {
    const why = (r.stderr || r.stdout).trim()
    throw new Error(needsLogin(r) ? `the gibson CLI has no login session (${why}). Call gibson_login first.` : `gibson target list failed: ${why}`)
  }
  return parseTargetList(r.stdout)
}

/**
 * `gibson target create`: prints the new target id. The daemon refuses a
 * target with neither a URL nor connection parameters, so the URL is
 * required here: for a coding workspace it names the repository.
 */
export async function createTarget(name: string, url: string, opts: CliOptions & { gibsonURL?: string; tenant?: string; type?: string } = {}): Promise<string> {
  const args = ["target", "create", "--name", name, "--url", url, "--type", opts.type ?? "custom"]
  if (opts.gibsonURL) args.push("--gibson-url", opts.gibsonURL)
  if (opts.tenant) args.push("--tenant", opts.tenant)
  const r = await runGibson(args, opts)
  const id = r.stdout.trim().split("\n").pop()?.trim() ?? ""
  if (r.code !== 0 || !id) {
    const why = (r.stderr || r.stdout).trim()
    throw new Error(needsLogin(r) ? `the gibson CLI has no login session (${why}). Call gibson_login first.` : `gibson target create failed: ${why}`)
  }
  return id
}

export interface LoginPrompt {
  url: string
  code: string
}

/**
 * `gibson login`: a browser device flow. The CLI prints a URL and a code, then
 * waits for the approval. This starts it detached, returns the URL and code
 * as soon as they appear, and leaves the CLI waiting so the session lands in
 * `~/.gibson/auth/credentials` when the person approves.
 */
export async function startLogin(opts: CliOptions & { gibsonURL?: string } = {}): Promise<LoginPrompt> {
  const spawn = opts.spawn ?? (nodeSpawn as unknown as Spawn)
  const args = ["login"]
  if (opts.gibsonURL) args.push("--gibson-url", opts.gibsonURL)
  const child = spawn(opts.bin ?? opts.env?.GIBSON_CLI ?? "gibson", args, { detached: true, env: opts.env ?? process.env })
  return await new Promise<LoginPrompt>((resolve, reject) => {
    let buf = ""
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`gibson login printed no device code within ${opts.timeoutMs ?? 30_000}ms: ${buf.trim()}`))
    }, opts.timeoutMs ?? 30_000)
    const check = () => {
      const url = /open:\s*\n?\s*(https?:\/\/\S+)/.exec(buf)
      const code = /confirm this code:\s*(\S+)/.exec(buf)
      if (url && code) {
        clearTimeout(timer)
        child.unref()
        resolve({ url: url[1]!, code: code[1]! })
      }
    }
    child.stdout?.on("data", (d: Buffer) => {
      buf += d.toString()
      check()
    })
    child.stderr?.on("data", (d: Buffer) => {
      buf += d.toString()
      check()
    })
    child.on("error", (e) => {
      clearTimeout(timer)
      reject(new Error(`cannot run the gibson CLI (${e.message}). Install it: see https://github.com/zeroroot-ai/adk`))
    })
    child.on("exit", (code) => {
      clearTimeout(timer)
      reject(new Error(`gibson login exited with ${code} before printing a device code: ${buf.trim()}`))
    })
  })
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

/**
 * The person originates the session mission. A component may originate a
 * mission only from inside one it was dispatched to (gibson ADR-0063), and an
 * interactive session has no parent mission, so the definition goes through
 * the CLI's login session: `gibson mission submit` validates it, registers it
 * and runs it, then prints the mission id. The daemon dispatches the one AGENT
 * node to this component, which must already be checked in.
 */
export async function submitMission(
  definition: unknown,
  targetId: string,
  opts: CliOptions & { gibsonURL?: string; tenant?: string; dir?: string } = {},
): Promise<string> {
  const dir = await mkdtemp(join(opts.dir ?? tmpdir(), "gibson-mcp-mission-"))
  const file = join(dir, "session.json")
  try {
    await writeFile(file, JSON.stringify(definition), { mode: 0o600 })
    // --detach: the CLI returns once the daemon started the run and prints the
    // mission id. Without it the CLI holds the RunMission stream until the
    // mission ends, which never happens: this process must go on to claim the
    // dispatch, and the CLI's own deadline fires first.
    const args = ["mission", "submit", file, "--format", "json", "--target", targetId, "--detach"]
    if (opts.gibsonURL) args.push("--gibson-url", opts.gibsonURL)
    if (opts.tenant) args.push("--tenant", opts.tenant)
    const r = await runGibson(args, { ...opts, timeoutMs: opts.timeoutMs ?? 120_000 })
    if (r.code !== 0) {
      if (needsLogin(r)) throw new Error("the gibson CLI has no session; run gibson_login first")
      if (/unknown flag: --detach/.test(r.stderr)) throw new Error("the gibson CLI is too old for mission submit --detach; update the gibson CLI (adk >= 0.109)")
      throw new Error(`gibson mission submit failed (exit ${r.code}): ${(r.stderr || r.stdout).trim().slice(0, 400)}`)
    }
    const ids = r.stdout.match(UUID) ?? []
    const missionId = ids[ids.length - 1]
    if (!missionId) throw new Error(`gibson mission submit printed no mission id: ${r.stdout.trim().slice(0, 400)}`)
    return missionId
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
