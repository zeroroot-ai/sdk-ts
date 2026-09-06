// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { existsSync } from "node:fs"
import {
  componentKnowledge,
  connectGibson,
  openTaskHarness,
  SANDBOX_ENV,
  startLiveMission,
  taskKnowledge,
  type GibsonSession,
  type KnowledgeSource,
  type LiveMission,
  type MissionOriginator,
} from "@zeroroot-ai/sdk"
import { submitMission } from "./cli.js"
import type { Settings } from "./config.js"
import { TAG, type Log } from "./log.js"
import { decideMode, type Mode } from "./mode.js"
import { decideSource, type CheckInSource } from "./source.js"
import { trustCA } from "./tls.js"

export { DEFAULT_AGENT_NAME } from "./config.js"

/** Everything the tools need, decided once per connect. */
export interface Gibson {
  source: CheckInSource
  mode: Mode
  reason: string
  agentName: string
  hostKeyPath: string
  settings: Settings
  session?: GibsonSession
  live?: LiveMission
  knowledge?: KnowledgeSource
  /** The mission run this dispatched process belongs to, when the launch named one. */
  runId?: string
  /** Release the mission and the component registration. Idempotent. */
  close(): Promise<void>
}

export interface OpenGibsonOptions {
  settings: Settings
  log: Log
  /** The process environment, for the dispatched-grant contract. */
  env?: NodeJS.ProcessEnv
  /** Test seams. */
  connect?: typeof connectGibson
  start?: typeof startLiveMission
  harness?: typeof openTaskHarness
  originate?: MissionOriginator
  hostKeyExists?: (path: string) => boolean
  trust?: (path: string) => Promise<void>
}

/**
 * Pick the check-in source, check in, then make the session a live mission.
 * Fails open at every step (ADR-0005): a platform failure lands one posture
 * down, never in a refusal to start.
 */
export async function openGibson(opts: OpenGibsonOptions): Promise<Gibson> {
  const { settings, log } = opts
  const env = opts.env ?? {}
  const { hostKeyPath, agentName } = settings
  const hostKeyExists = (opts.hostKeyExists ?? existsSync)(hostKeyPath)
  const decision = decideSource({
    grant: env[SANDBOX_ENV.grant],
    callbackEndpoint: env[SANDBOX_ENV.callbackEndpoint],
    bootstrapToken: settings.bootstrapToken,
    hostKeyExists,
  })
  for (const note of decision.notes) log(`${TAG} check-in: ${note}`)
  if (decision.source === "dispatched") return openDispatched(env, settings, log, opts)

  const source = decision.source
  const mode = decideMode(
    { platformURL: settings.platformURL, bootstrapToken: settings.bootstrapToken, hostKeyExists, targetId: settings.targetId },
    hostKeyPath,
  )
  const standalone = (reason: string): Gibson => ({ source, mode: "standalone", reason, agentName, hostKeyPath, settings, close: async () => {} })
  if (mode.mode === "standalone") {
    log(`${TAG} ${source === "none" ? "not checked in" : "standalone"}: ${mode.reason}`)
    return standalone(mode.reason)
  }

  if (settings.caCertPath) {
    try {
      await (opts.trust ?? trustCA)(settings.caCertPath)
    } catch (e) {
      log(`${TAG} CA at ${settings.caCertPath} not loaded: ${(e as Error).message}`)
    }
  }

  // The bootstrap token is passed ONLY when no host key exists yet. Replaying a
  // one-time token on every start would be rejected (gibson
  // capabilitygrant_register.go:134-155).
  const bootstrapToken = source === "bootstrap" ? settings.bootstrapToken : undefined
  let session: GibsonSession
  try {
    session = await (opts.connect ?? connectGibson)({
      platformURL: settings.platformURL!,
      daemonURL: settings.daemonURL,
      bootstrapToken,
      hostKeyPath,
      agentName,
      agentMode: "interactive",
      agent: { name: agentName, version: "0.0.0", capabilities: ["code"] },
    })
  } catch (e) {
    const reason = `Gibson connect failed: ${(e as Error).message}`
    log(`${TAG} ${reason}; continuing standalone`)
    return standalone(reason)
  }
  log(`${TAG} checked in via ${source === "bootstrap" ? "the bootstrap token (first check-in)" : "the registered host key"} as ${agentName} (component_scope=${session.componentScope})`)
  if (source === "bootstrap") log(`${TAG} host key written to ${hostKeyPath}; the bootstrap token is spent`)

  const component: Gibson = {
    source,
    mode: "component",
    reason: mode.reason,
    agentName,
    hostKeyPath,
    settings,
    session,
    knowledge: componentKnowledge(session.clients.component),
    close: async () => session.stop(),
  }
  if (mode.mode === "component") {
    log(`${TAG} component posture: ${mode.reason}`)
    return component
  }

  let live: LiveMission
  try {
    live = await (opts.start ?? startLiveMission)(session, {
      agentName,
      targetId: settings.targetId!,
      // The person originates the session mission through the CLI login
      // session; the component only claims its dispatch (gibson ADR-0063,
      // ADR-0007 decision 3: one live mission per session).
      originate: opts.originate ?? ((definition, targetId) => submitMission(definition, targetId, { env, gibsonURL: settings.platformURL, tenant: settings.tenant })),
      harness: { insecure: settings.callbackInsecure },
    })
  } catch (e) {
    const reason = `live mission failed: ${(e as Error).message}`
    log(`${TAG} ${reason}; continuing as a component`)
    return { ...component, reason }
  }
  log(`${TAG} live mission ${live.missionId} (work ${live.workId}); reads and writes use the task grant`)

  let closed = false
  return {
    source,
    mode: "live",
    reason: "",
    agentName,
    hostKeyPath,
    settings,
    session,
    live,
    knowledge: taskKnowledge(live.harness),
    close: async () => {
      if (closed) return
      closed = true
      try {
        await live.end({ output: { ended: "session closed" } })
      } finally {
        session.stop()
      }
    },
  }
}

/**
 * The dispatched source: the daemon launched this process with a grant and
 * a callback endpoint. The launch already decided everything; the server
 * opens the task harness from the grant and serves the tools that run under
 * it. No host key, no check-in, no mission creation, no state file.
 *
 * A grant the harness cannot open still fails open: the process serves
 * standalone with the reason in `gibson_status`, so the run's log says why
 * the tools are missing instead of the sandbox dying with no tool surface.
 */
async function openDispatched(env: NodeJS.ProcessEnv, settings: Settings, log: Log, opts: OpenGibsonOptions): Promise<Gibson> {
  const endpoint = env[SANDBOX_ENV.callbackEndpoint]!
  const token = env[SANDBOX_ENV.grant]!
  const runId = env[SANDBOX_ENV.missionRunId] || undefined
  if (settings.caCertPath) {
    await (opts.trust ?? trustCA)(settings.caCertPath).catch((e: Error) => log(`${TAG} CA not loaded: ${e.message}`))
  }
  const base = { source: "dispatched" as const, hostKeyPath: settings.hostKeyPath, settings, ...(runId ? { runId } : {}) }
  let harness
  try {
    harness = (opts.harness ?? openTaskHarness)({ endpoint, token, insecure: settings.callbackInsecure })
  } catch (e) {
    const reason = `dispatched grant unusable: ${(e as Error).message}`
    log(`${TAG} ${reason}; continuing standalone`)
    return { ...base, mode: "standalone", reason, agentName: settings.agentName, close: async () => {} }
  }
  const missionId = harness.context.missionId
  const live: LiveMission = {
    missionId,
    workId: runId ?? harness.context.taskId,
    harness,
    // The dispatched process reports completion by exiting; the launcher owns the node.
    end: async () => harness.stop(),
  }
  log(`${TAG} dispatched: mission ${missionId}${runId ? ` run ${runId}` : ""} as ${harness.context.agentName}; reads and writes use the dispatch grant`)
  return {
    ...base,
    mode: "task",
    reason: "",
    agentName: harness.context.agentName,
    live,
    knowledge: taskKnowledge(harness),
    close: async () => harness.stop(),
  }
}
