// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { z } from "zod"
import { ambientBlock } from "./ambient.js"
import type { Gibson } from "./session.js"

/**
 * Ambient knowledge and session coordinates, as MCP resources.
 *
 * A host with a hook surface injects the ambient block itself: Claude Code
 * reads it at SessionStart, the opencode plugin at `system.transform`. A
 * host with no hook surface has nowhere to put it, so the same block is also
 * an MCP resource the model can read and a prompt it can call. One lookup
 * either way: the block is computed once per connection and cached, because
 * it is prompt overhead on every session.
 *
 * `gibson://session` carries the live-mission coordinates a session-end hook
 * needs to checkpoint the transcript (`PutSessionContext`). A hook runs as
 * its own process and cannot reach this server, so it reads the same
 * coordinates from the state file; the resource is for a host that can ask
 * the server directly.
 */
export const AMBIENT_URI = "gibson://ambient"
export const SESSION_URI = "gibson://session"

export const DEFAULT_AMBIENT_QUERY = "memories, prior findings and security facts for this codebase"

export interface ResourceContents {
  uri: string
  mimeType: string
  text: string
}

export interface ResourceDefinition {
  uri: string
  name: string
  title: string
  description: string
  mimeType: string
  read(): Promise<ResourceContents>
}

export interface PromptDefinition {
  name: string
  title: string
  description: string
  arguments: { name: string; description: string; required: boolean }[]
  get(args: Record<string, string>): Promise<{ description: string; messages: { role: "user"; content: { type: "text"; text: string } }[] }>
}

/** The session's ambient block, computed once and kept. */
export interface AmbientSource {
  block(query?: string): Promise<string>
}

export function ambientSource(gibson: Gibson, env: NodeJS.ProcessEnv): AmbientSource {
  const defaultQuery = env.ZEROCOOL_AMBIENT_QUERY ?? DEFAULT_AMBIENT_QUERY
  let cached: Promise<string> | undefined
  return {
    block: (query) => {
      const knowledge = gibson.knowledge
      if (!knowledge) return Promise.resolve("")
      // Only the default query is cached. A model that asks its own question
      // wants an answer to that question, not the session's opening block.
      if (query && query !== defaultQuery) return ambientBlock(knowledge, query)
      cached ??= ambientBlock(knowledge, defaultQuery)
      return cached
    },
  }
}

/** What a session-end hook needs to checkpoint a transcript. */
export function sessionCoordinates(gibson: Gibson): Record<string, unknown> {
  return {
    source: gibson.source,
    posture: gibson.mode,
    agent_name: gibson.agentName,
    ...(gibson.settings.platformURL ? { platform_url: gibson.settings.platformURL } : {}),
    ...(gibson.settings.tenant ? { tenant: gibson.settings.tenant } : {}),
    ...(gibson.settings.targetId ? { target_id: gibson.settings.targetId } : {}),
    ...(gibson.live
      ? {
          mission_id: gibson.live.missionId,
          work_id: gibson.live.workId,
          callback_endpoint: gibson.live.harness.endpoint,
          callback_insecure: gibson.settings.callbackInsecure,
        }
      : {}),
    ...(gibson.runId ? { run_id: gibson.runId } : {}),
  }
}

export function resources(gibson: () => Gibson, ambient: AmbientSource): ResourceDefinition[] {
  return [
    {
      uri: AMBIENT_URI,
      name: "gibson_ambient",
      title: "Gibson ambient knowledge",
      description:
        "One GraphRAG lookup for this session: the memories, prior findings and security facts the " +
        "tenant already holds about this codebase. Read it once at the start of a session. Empty " +
        "when the session has no platform.",
      mimeType: "text/markdown",
      read: async () => ({ uri: AMBIENT_URI, mimeType: "text/markdown", text: await ambient.block() }),
    },
    {
      uri: SESSION_URI,
      name: "gibson_session",
      title: "Gibson session coordinates",
      description:
        "How this session is connected: the check-in source, the posture, and the mission, run and " +
        "callback endpoint a session-end hook needs to checkpoint the transcript.",
      mimeType: "application/json",
      read: async () => ({ uri: SESSION_URI, mimeType: "application/json", text: `${JSON.stringify(sessionCoordinates(gibson()), null, 2)}\n` }),
    },
  ]
}

/** The ambient block as a prompt, for a host with no hook surface. */
export function ambientPrompt(ambient: AmbientSource): PromptDefinition {
  return {
    name: "gibson_ambient",
    title: "Gibson prior context",
    description: "Load what this tenant's Gibson graph already knows about this codebase. Use it at the start of a session, or with a question of your own.",
    arguments: [{ name: "query", description: "What to look for. Defaults to the session's opening lookup.", required: false }],
    get: async (args) => {
      const query = z.string().optional().parse(args.query)
      const block = await ambient.block(query)
      return {
        description: "Prior context from the Gibson knowledge graph",
        messages: [{ role: "user", content: { type: "text", text: block || "The Gibson knowledge graph holds nothing for this codebase yet." } }],
      }
    },
  }
}
