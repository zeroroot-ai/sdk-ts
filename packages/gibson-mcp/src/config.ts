// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { readFile, writeFile, mkdir } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { stateDir } from "./state.js"

/**
 * Where a session learns how to reach Gibson, in precedence order:
 *
 *  1. the environment (`GIBSON_*`), for people who script it,
 *  2. the config this server wrote after a `gibson_connect`,
 *  3. the `gibson` CLI login session (`~/.gibson/auth/credentials`), which
 *     already knows the platform URL, the active tenant and the private CA.
 *
 * So a person who ran `gibson login` once needs nothing else: the server
 * finds the platform through the same session the CLI uses.
 */
export interface ServerConfig {
  platformURL?: string
  daemonURL?: string
  targetId?: string
  caCertPath?: string
  callbackInsecure?: boolean
}

export interface CliCredentials {
  gibsonURL?: string
  tenant?: string
  caCertPath?: string
}

export interface Settings {
  platformURL?: string
  daemonURL?: string
  targetId?: string
  caCertPath?: string
  callbackInsecure: boolean
  bootstrapToken?: string
  hostKeyPath: string
  agentName: string
  tenant?: string
}

/** The registered component name, and the `sub` of every grant minted for it. */
export const DEFAULT_AGENT_NAME = "gibson-mcp"

export function configPath(env: NodeJS.ProcessEnv): string {
  return join(stateDir(env), "config.json")
}

export async function readConfig(env: NodeJS.ProcessEnv): Promise<ServerConfig> {
  try {
    return JSON.parse(await readFile(configPath(env), "utf8")) as ServerConfig
  } catch {
    return {}
  }
}

/** Merge and persist. Only the keys given change. */
export async function writeConfig(env: NodeJS.ProcessEnv, patch: ServerConfig): Promise<ServerConfig> {
  const merged = { ...(await readConfig(env)), ...patch }
  await mkdir(stateDir(env), { recursive: true, mode: 0o700 })
  await writeFile(configPath(env), `${JSON.stringify(merged, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
  return merged
}

export function cliCredentialsPath(env: NodeJS.ProcessEnv): string {
  return env.GIBSON_CLI_CREDENTIALS ?? join(homedir(), ".gibson", "auth", "credentials")
}

/** The `gibson` CLI login session, addressing fields only. Tokens are never read. */
export async function cliCredentials(env: NodeJS.ProcessEnv): Promise<CliCredentials | undefined> {
  try {
    const raw = JSON.parse(await readFile(cliCredentialsPath(env), "utf8")) as Record<string, unknown>
    const str = (k: string) => (typeof raw[k] === "string" && raw[k] ? (raw[k] as string) : undefined)
    return { gibsonURL: str("gibson_url"), tenant: str("active_tenant"), caCertPath: str("ca_cert_path") }
  } catch {
    return undefined
  }
}

export function resolveSettings(env: NodeJS.ProcessEnv, cfg: ServerConfig, creds: CliCredentials | undefined): Settings {
  return {
    platformURL: env.GIBSON_PLATFORM_URL ?? cfg.platformURL ?? creds?.gibsonURL,
    daemonURL: env.GIBSON_DAEMON_URL ?? cfg.daemonURL,
    targetId: env.GIBSON_TARGET_ID ?? cfg.targetId,
    caCertPath: env.GIBSON_CA_CERT ?? cfg.caCertPath ?? creds?.caCertPath,
    callbackInsecure: env.GIBSON_CALLBACK_INSECURE === "1" || cfg.callbackInsecure === true,
    bootstrapToken: env.GIBSON_BOOTSTRAP_TOKEN,
    hostKeyPath: env.GIBSON_HOST_KEY_PATH ?? join(homedir(), ".zerocool", "host.key"),
    agentName: env.ZEROCOOL_AGENT_NAME ?? DEFAULT_AGENT_NAME,
    tenant: creds?.tenant,
  }
}

export async function loadSettings(env: NodeJS.ProcessEnv): Promise<Settings> {
  return resolveSettings(env, await readConfig(env), await cliCredentials(env))
}
