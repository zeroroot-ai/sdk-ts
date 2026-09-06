// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { formatKnowledgeForPrompt, isSeamUnavailable, observe, remember, WorldEntityKind, type KnowledgeHit } from "@zeroroot-ai/sdk"
import { z } from "zod"
import type { ToolDefinition } from "../registry.js"
import { defineTool } from "../tool.js"
import { failure, json, text } from "../tools/result.js"
import type { HelperContext } from "./context.js"

/**
 * Memory and knowledge (gibson#1593, decisions 9 and 10).
 *
 * `remember` is `Observe(MemoryObservation)`: the memory lands in the tenant
 * World as a Timeline event and the projector writes the graph node. It
 * exists only where a mission is open, because the World is written under a
 * mission.
 *
 * `recall` reads the graph. Under a task grant it reads as the task, as a
 * checked-in component it reads as the component. The model decides when a
 * lookup is worth a round trip, and the query it writes beats anything
 * derived from the prompt.
 */
export function knowledgeTools(ctx: HelperContext): ToolDefinition[] {
  const out: ToolDefinition[] = []
  const { knowledge, live } = ctx.gibson

  if (knowledge) {
    out.push(
      defineTool({
        name: "recall",
        description:
          "Search this tenant's Gibson knowledge graph for memories, prior findings, targets and " +
          "security facts recorded by earlier sessions and runs. Use it before you start on an " +
          "unfamiliar area, or to check whether something was already recorded.",
        input: {
          query: z.string().describe("What to look for, in natural language."),
          limit: z.number().int().min(1).max(50).optional().describe("Maximum hits. Defaults to 10."),
          node_types: z.array(z.string()).optional().describe('Restrict to node types, e.g. ["Observation"] for memories or ["Finding"].'),
        },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          let hits: KnowledgeHit[]
          try {
            hits = await knowledge.query({ text: args.query, topK: args.limit ?? 10, ...(args.node_types ? { nodeTypes: args.node_types } : {}) })
          } catch (e) {
            if (isSeamUnavailable(e)) {
              return text("recall unavailable", "The Gibson knowledge graph is not available on this daemon (gibson#1186). Continue without prior context.")
            }
            return failure("recall failed", (e as Error).message)
          }
          if (hits.length === 0) return text("no matches", `Nothing in the tenant graph matches "${args.query}".`)
          return text(`${hits.length} match${hits.length === 1 ? "" : "es"}`, formatKnowledgeForPrompt(hits))
        },
      }),
      defineTool({
        name: "similar_findings",
        description: "Findings in this tenant's graph that are semantically similar to a known finding.",
        input: { finding_id: z.string().describe("The finding to search from."), limit: z.number().int().min(1).max(50).optional().describe("Maximum hits. Defaults to 5.") },
        annotations: { readOnlyHint: true },
        handler: async (args) => json(await knowledge.similarFindings(args.finding_id, args.limit ?? 5)),
      }),
      defineTool({
        name: "related_findings",
        description: "Findings reachable from a given finding through the graph's edges.",
        input: { finding_id: z.string().describe("The finding to traverse from.") },
        annotations: { readOnlyHint: true },
        handler: async (args) => json(await knowledge.relatedFindings(args.finding_id)),
      }),
      defineTool({
        name: "similar_attacks",
        description: "Attack patterns in the graph that are semantically similar to a piece of content.",
        input: { content: z.string().describe("Text to match attack patterns against."), limit: z.number().int().min(1).max(50).optional().describe("Maximum hits. Defaults to 5.") },
        annotations: { readOnlyHint: true },
        handler: async (args) => json(await knowledge.similarAttacks(args.content, args.limit ?? 5)),
      }),
      defineTool({
        name: "attack_chains",
        description: "Multi-hop attack paths that start from a MITRE technique.",
        input: { technique_id: z.string().describe("MITRE technique id, e.g. T1190."), max_depth: z.number().int().min(1).max(10).optional().describe("Hops to follow. Defaults to 3.") },
        annotations: { readOnlyHint: true },
        handler: async (args) => json(await knowledge.attackChains(args.technique_id, args.max_depth ?? 3)),
      }),
    )
  }

  if (live) {
    const harness = live.harness
    out.push(
      defineTool({
        name: "remember",
        description:
          "Keep a fact for later sessions, in this tenant's Gibson knowledge graph. Use it for a " +
          "convention, a decision, a layout fact or a gotcha you would want back next time. Not for " +
          "progress notes. A security finding goes to submit_finding instead.",
        input: {
          text: z.string().describe("The fact, in one or two sentences."),
          kind: z.string().optional().describe('A short category: "convention", "decision", "layout", "gotcha".'),
          tags: z.array(z.string()).optional().describe("Lower-case labels that help recall."),
          source_ref: z.string().optional().describe("Where it came from: a path, a URL, or a work id."),
        },
        handler: async (args) => {
          try {
            await remember(harness, { text: args.text, kind: args.kind, tags: args.tags, sourceRef: args.source_ref })
          } catch (e) {
            return failure("remember failed", (e as Error).message)
          }
          return text("remembered", `Recorded in the tenant graph under mission ${live.missionId}.`)
        },
      }),
      defineTool({
        name: "observe",
        description:
          "Write a typed observation to the tenant World: an entity the platform should know about, " +
          "an edge between two of them, or a lifecycle event. Use remember for a plain fact and " +
          "submit_finding for a vulnerability.",
        input: { observation: z.record(z.string(), z.unknown()).describe("An Observation object: a memory, an entity, an edge, or a lifecycle entity.") },
        handler: async (args) => {
          try {
            await observe(harness, args.observation as never)
          } catch (e) {
            return failure("observe failed", (e as Error).message)
          }
          return text("observed", `Recorded in the World under mission ${live.missionId}.`)
        },
      }),
      defineTool({
        name: "world_view",
        description:
          "Read this mission's slice of the tenant World: the hosts, domains, credentials, accounts " +
          "and findings the platform knows about the target. Pass handles from a previous call in " +
          "focus to zoom into entities.",
        input: { focus: z.array(z.string()).optional().describe("Entity handles from an earlier world_view call.") },
        annotations: { readOnlyHint: true },
        handler: async (args) => {
          try {
            const res = await harness.client.worldView({ context: harness.context, focus: args.focus ?? [] })
            if (res.error) return failure("world_view refused", res.error.message)
            if (res.entities.length === 0) return text("empty slice", "The World holds nothing for this target yet.")
            const lines = res.entities.map((e) => {
              const attrs = Object.entries(e.attributes).map(([k, v]) => `${k}=${v}`).join(", ")
              return `- [${e.handle}] ${WorldEntityKind[e.kind] ?? e.kind} ${e.label}${attrs ? ` (${attrs})` : ""}`
            })
            return text(`${res.entities.length} entit${res.entities.length === 1 ? "y" : "ies"}${res.truncated ? " (truncated)" : ""}`, lines.join("\n"))
          } catch (e) {
            return failure("world_view failed", (e as Error).message)
          }
        },
      }),
      defineTool({
        name: "run_history",
        description: "Earlier runs of this mission's target, so a session can see what previous runs already did.",
        input: {},
        annotations: { readOnlyHint: true },
        handler: async () => json(await (ctx.gibson.knowledge ?? knowledge)!.runHistory()),
      }),
      defineTool({
        name: "application_findings",
        description:
          "The findings of one Application, with the lifecycle context that decides how much each " +
          "one matters: whether the affected place is reachable, whether it is exposed, and what a " +
          "previous triage pass decided. An empty priority means no pass has decided yet, never " +
          "that the finding is unimportant.",
        input: {
          application: z.string().describe("The Application's key. Required: the read is scoped to one Application."),
          statuses: z.array(z.string()).optional().describe('Lifecycle statuses to keep: "open", "fixing", "fixed", "verified". Omit for every status.'),
          limit: z.number().int().min(1).optional().describe("Bound on one read. The server caps it either way."),
        },
        annotations: { readOnlyHint: true },
        handler: async (args) =>
          json(
            await (ctx.gibson.knowledge ?? knowledge)!.applicationFindings({
              application: args.application,
              ...(args.statuses ? { statuses: args.statuses } : {}),
              ...(args.limit ? { limit: args.limit } : {}),
            }),
          ),
      }),
    )
  }
  return out
}
