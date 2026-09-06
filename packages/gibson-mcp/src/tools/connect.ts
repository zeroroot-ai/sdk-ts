// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { execFile } from "node:child_process"
import { existsSync } from "node:fs"
import { promisify } from "node:util"
import { z } from "zod"
import { createTarget, enrollIdentity, listTargets, startLogin, type CliOptions } from "../cli.js"
import { loadSettings, writeConfig, type Settings } from "../config.js"
import { log } from "../log.js"
import type { ToolDefinition } from "../registry.js"
import { openGibson, type Gibson, type OpenGibsonOptions } from "../session.js"
import { defineTool } from "../tool.js"
import { failure, text } from "./result.js"
import { describeGibson } from "./status.js"

/**
 * gibson_login and gibson_connect: the in-session path to a platform, for a
 * host with no key and no token. `gibson_login` starts the CLI device flow
 * and returns the URL and code. `gibson_connect` enrolls through the CLI
 * session, trusts the private CA, checks in, picks the target, starts the
 * live mission and swaps the tool set live. The settings it learns are
 * persisted, so later sessions connect on their own.
 */
export interface ConnectDeps {
  open?: Pick<OpenGibsonOptions, "connect" | "start" | "hostKeyExists" | "trust" | "harness">
  cli?: CliOptions
}

export interface ConnectTarget {
  current(): Gibson
  /** Replace the connection and re-register the posture's tools. */
  upgrade(next: Gibson): Promise<void>
}

export function loginTool(target: ConnectTarget, env: NodeJS.ProcessEnv, deps: ConnectDeps): ToolDefinition {
  return defineTool({
    name: "gibson_login",
    description:
      "Sign in to a Gibson platform as the person running this session. Starts the gibson CLI device " +
      "flow and returns a URL and a code. The person opens the URL, confirms the code, and then calls " +
      "gibson_connect. Needed once per host, and again when the login session expires.",
    input: {
      platform_url: z.string().optional().describe("Platform URL, e.g. https://api.example.com. Defaults to the last one used."),
    },
    handler: async (args) => {
      const s = target.current().settings
      try {
        const p = await startLogin({ ...deps.cli, env, gibsonURL: args.platform_url ?? s.platformURL })
        return text("sign in", `Open ${p.url} and confirm the code ${p.code}. The CLI waits for the approval. When it is approved, call gibson_connect.`)
      } catch (e) {
        return failure("gibson_login failed", (e as Error).message)
      }
    },
  })
}

export function connectTool(target: ConnectTarget, env: NodeJS.ProcessEnv, cwd: string, deps: ConnectDeps): ToolDefinition {
  const cli = (s: Settings): CliOptions & { gibsonURL?: string; tenant?: string } => ({ ...deps.cli, env, gibsonURL: s.platformURL, tenant: s.tenant })
  return defineTool({
    name: "gibson_connect",
    description:
      "Connect this session to a Gibson platform without a restart: enroll this host through the gibson " +
      "CLI login session if needed, check in, pick the target, start the live mission, and add the " +
      "platform tools. The settings are kept, so later sessions connect on their own. Call gibson_status afterwards.",
    input: {
      platform_url: z.string().optional().describe("Platform URL. Defaults to the gibson CLI login session or the saved config."),
      target_id: z.string().optional().describe("Target id for the live mission. Defaults to the only target in the tenant."),
      create_target: z.string().optional().describe("Create a target with this name when none exists, and use it."),
      target_url: z.string().optional().describe("URL of the target to create. Defaults to the workspace's git origin, or file://<cwd>."),
      bootstrap_token: z.string().optional().describe("One-time enrollment token. Only when the CLI cannot mint one."),
      ca_cert_path: z.string().optional().describe("Path to a private CA to trust. Defaults to the CLI session's CA."),
      callback_insecure: z.boolean().optional().describe("Dial the callback endpoint without TLS. Local daemons only."),
    },
    handler: async (args) => {
      const base = await loadSettings(env)
      const s: Settings = {
        ...base,
        platformURL: args.platform_url ?? base.platformURL,
        targetId: args.target_id ?? base.targetId,
        caCertPath: args.ca_cert_path ?? base.caCertPath,
        callbackInsecure: args.callback_insecure ?? base.callbackInsecure,
        bootstrapToken: args.bootstrap_token ?? base.bootstrapToken,
      }
      if (!s.platformURL) {
        return failure("no platform", "Pass platform_url, or call gibson_login first so the CLI session names the platform.")
      }
      const hostKeyExists = (deps.open?.hostKeyExists ?? existsSync)(s.hostKeyPath)
      try {
        if (!hostKeyExists && !s.bootstrapToken) {
          s.bootstrapToken = await enrollIdentity(s.agentName, cli(s))
        }
        if (!s.targetId) {
          if (args.create_target) {
            s.targetId = await createTarget(args.create_target, args.target_url ?? (await workspaceURL(cwd)), cli(s))
          } else {
            const targets = await listTargets(cli(s))
            if (targets.length === 1) s.targetId = targets[0]!.id
            else if (targets.length === 0) {
              return failure("no target", "The tenant has no target. Call gibson_connect again with create_target set to a name for this workspace.")
            } else {
              return failure(
                "choose a target",
                `The tenant has ${targets.length} targets. Call gibson_connect again with target_id:\n${targets.map((t) => `- ${t.id}  ${t.name} (${t.type}, ${t.status})`).join("\n")}`,
              )
            }
          }
        }
      } catch (e) {
        return failure("gibson_connect failed", (e as Error).message)
      }

      await writeConfig(env, {
        platformURL: s.platformURL,
        targetId: s.targetId,
        ...(s.caCertPath ? { caCertPath: s.caCertPath } : {}),
        ...(s.daemonURL ? { daemonURL: s.daemonURL } : {}),
        callbackInsecure: s.callbackInsecure,
      })

      const previous = target.current()
      await previous.close().catch(() => {})
      const next = await openGibson({ settings: s, log, env, ...deps.open })
      await target.upgrade(next)
      const body = describeGibson(next)
      return next.mode === "live" ? text("connected", body) : failure("connected, but not live", body)
    },
  })
}

/** What a coding workspace is, as a URL: its git origin, else the directory. */
export async function workspaceURL(cwd: string): Promise<string> {
  try {
    const { stdout } = await promisify(execFile)("git", ["-C", cwd, "remote", "get-url", "origin"])
    const remote = stdout.trim()
    if (remote) return remote
  } catch {
    // not a git checkout, or no origin
  }
  return `file://${cwd}`
}
