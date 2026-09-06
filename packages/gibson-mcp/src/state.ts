// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { mkdir, readFile, writeFile, rm } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createHash } from "node:crypto"

/**
 * The handoff between the MCP server and a host's hook processes.
 *
 * A hook runs as a separate process and cannot reach the server's session.
 * The server writes one small file per working directory: the ambient
 * knowledge block for a session-start hook, and the live-mission coordinates
 * for a session-end hook. The files live in the state directory beside the
 * host key. The task grant in the live file is bounded (30 minutes, renewed
 * by the server), and a hook that finds a stale one fails open.
 *
 * The directory is `~/.zerocool/`, not a per-host subdirectory: the server
 * is host-agnostic. A dispatched run writes no state file at all.
 */
export interface LiveState {
  missionId: string
  workId: string
  endpoint: string
  token: string
  insecure: boolean
  /** Unix ms. */
  writtenAt: number
}

export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZEROCOOL_STATE_DIR ?? join(homedir(), ".zerocool")
}

export function keyFor(cwd: string): string {
  return createHash("sha256").update(cwd).digest("hex").slice(0, 16)
}

export async function writeAmbient(dir: string, cwd: string, block: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, `ambient-${keyFor(cwd)}.md`), block, { encoding: "utf8", mode: 0o600 })
}

export async function readAmbient(dir: string, cwd: string): Promise<string> {
  try {
    return await readFile(join(dir, `ambient-${keyFor(cwd)}.md`), "utf8")
  } catch {
    return ""
  }
}

export async function writeLive(dir: string, cwd: string, state: LiveState): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 })
  await writeFile(join(dir, `live-${keyFor(cwd)}.json`), JSON.stringify(state), { encoding: "utf8", mode: 0o600 })
}

export async function readLive(dir: string, cwd: string): Promise<LiveState | undefined> {
  try {
    return JSON.parse(await readFile(join(dir, `live-${keyFor(cwd)}.json`), "utf8")) as LiveState
  } catch {
    return undefined
  }
}

export async function clearLive(dir: string, cwd: string): Promise<void> {
  await rm(join(dir, `live-${keyFor(cwd)}.json`), { force: true })
}
