// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Client } from "@connectrpc/connect"
import type { TaskHarness } from "./task-harness.js"
import type { AttackChain, AttackPattern, FindingNode } from "./gen/gibson/graphrag/v1/graphrag_pb.js"
import type { ApplicationFinding } from "./gen/gibson/harness/v1/harness_callback_pb.js"
import type { MissionRunSummary } from "./gen/gibson/types/v1/types_pb.js"
import { RunScope } from "./gen/gibson/harness/v1/harness_callback_pb.js"
import type { ComponentService } from "./clients.js"
import {
  decodeProperties,
  findSimilarAttacks,
  findSimilarFindings,
  getAttackChains,
  getRelatedFindings,
  queryKnowledge,
  type KnowledgeHit,
  type QueryKnowledgeOptions,
} from "./knowledge.js"

/**
 * The knowledge reads over the TASK-scoped callback harness.
 *
 * The sibling of `knowledge.ts`, which reads the same graph over
 * ComponentService with the component's own grant. A dispatched run should use
 * these instead: they travel on the per-dispatch capability grant, so the run
 * holds exactly the authority its dispatch granted rather than borrowing the
 * component's. See `openTaskHarness` in `task-harness.ts`.
 *
 * TWO DIFFERENCES FROM THE COMPONENT SURFACE, both deliberate:
 *
 *  - **No `workId` argument.** The callback service resolves tenant and mission
 *    from the task context the client already attaches, so there is nothing here
 *    for a caller to get wrong or to widen.
 *  - **Typed results.** ComponentService answers these four with
 *    `bytes results_json` whose schema lives in a comment; the callback wire
 *    carries real messages, so there is no JSON to decode and no second
 *    definition of the same shape to drift.
 */

/** What to read, for {@link KnowledgeSource.applicationFindings}. */
export interface ApplicationFindingsOptions {
  /**
   * The Application's key. Required: the read is scoped to one Application by
   * construction, and an empty key would silently widen it to the whole tenant
   * graph.
   */
  application: string
  /** Lifecycle statuses to keep: `open`, `fixing`, `fixed`, `verified`. Omit for every status. */
  statuses?: string[]
  /** Bound on one read. Omit for the server default; the server caps it either way. */
  limit?: number
}

/** A knowledge source, however it is reached. Lets a caller pick a transport once. */
export interface KnowledgeSource {
  query(opts: QueryKnowledgeOptions): Promise<KnowledgeHit[]>
  similarFindings(findingId: string, topK?: number): Promise<FindingNode[]>
  relatedFindings(findingId: string): Promise<FindingNode[]>
  similarAttacks(content: string, topK?: number): Promise<AttackPattern[]>
  attackChains(techniqueId: string, maxDepth?: number): Promise<AttackChain[]>
  runHistory(): Promise<MissionRunSummary[]>
  /**
   * The Findings of one Application, with the lifecycle context that decides
   * how much each one matters (gibson#1674).
   *
   * `reachable` says the affected place sits inside an Image a Deployment of
   * this Application runs; `exposed` says that Deployment also exposes a Host.
   * Both are derived per read, never stored, because a stored value goes stale
   * the moment a deployment rolls — and a stale "not reachable" is a silent
   * false negative: a triage rule reads it as "nothing runs this" and ranks a
   * live Finding last.
   *
   * `priority`, `priorityRule` and `priorityReason` are what a previous triage
   * pass decided, written back and returned so the next pass can read its own
   * history. **Empty means no pass has decided yet** — a fact about the
   * Finding, never "unimportant", and never to be defaulted.
   */
  applicationFindings(opts: ApplicationFindingsOptions): Promise<ApplicationFinding[]>
}

/**
 * Build a {@link KnowledgeSource} over a task-scoped harness client.
 *
 * ```ts
 * const harness = openTaskHarness({ endpoint, token })
 * const knowledge = taskKnowledge(harness)
 * const hits = await knowledge.query({ text: "prior findings for this repo" })
 * ```
 */
export function taskKnowledge(harness: TaskHarness): KnowledgeSource {
  const { client, context } = harness
  return {
    async query(opts) {
      const res = await client.queryNodes({
        context,
        query: {
          text: opts.text,
          topK: opts.topK ?? 10,
          nodeTypes: opts.nodeTypes ?? [],
          ...(opts.minScore !== undefined ? { minScore: opts.minScore } : {}),
          ...(opts.filters ? { filters: opts.filters } : {}),
        },
      })
      return res.results.map((r) => ({
        id: r.node?.id ?? "",
        type: r.node?.type ?? "",
        score: r.score,
        content: r.node?.content ?? "",
        properties: decodeProperties(r.node?.properties),
        distance: r.distance,
      }))
    },

    async similarFindings(findingId, topK = 5) {
      return (await client.findSimilarFindings({ context, findingId, topK })).results
    },

    async relatedFindings(findingId) {
      return (await client.getRelatedFindings({ context, findingId })).results
    },

    async similarAttacks(content, topK = 5) {
      return (await client.findSimilarAttacks({ context, content, topK })).results
    },

    async attackChains(techniqueId, maxDepth = 3) {
      return (await client.getAttackChains({ context, techniqueId, maxDepth })).results
    },

    async runHistory() {
      return (await client.getMissionRunHistory({ context })).runs
    },

    async applicationFindings(opts) {
      if (!opts.application) {
        throw new Error("gibson-sdk: applicationFindings requires an application key")
      }
      const res = await client.applicationFindings({
        context,
        application: opts.application,
        statuses: opts.statuses ?? [],
        limit: opts.limit ?? 0,
      })
      // Rejected, never resolved empty. A caller reads a missing Finding as
      // "nothing deploys this" and ranks it last, so answering an outage with
      // `[]` reports a clean Application over a live backlog — silently, and
      // looking exactly like health.
      if (res.error) {
        throw new Error(`gibson-sdk: ApplicationFindings rejected (${res.error.code}): ${res.error.message}`)
      }
      return res.findings
    },
  }
}

/** Re-exported so a caller can name a scope without importing generated code. */
export { RunScope }

/**
 * Build a {@link KnowledgeSource} over a ComponentService client.
 *
 * The counterpart to {@link taskKnowledge}, reading the same graph with the
 * component's own grant. Correct for an INTERACTIVE agent — a human started it
 * and there is no task to scope to. A dispatched run should use
 * {@link taskKnowledge} instead, so it holds only the authority its dispatch
 * granted.
 *
 * Both exist behind one interface so a caller decides once, at startup, and the
 * rest of its code never asks which grant it is holding.
 */
export function componentKnowledge(component: Client<typeof ComponentService>): KnowledgeSource {
  return {
    query: (opts) => queryKnowledge(component, opts),

    // ComponentService answers these four with `bytes results_json`, so they
    // decode here rather than at every caller. The shapes match the typed
    // callback messages field-for-field — same graph, two transports.
    similarFindings: async (findingId, topK = 5) =>
      (await findSimilarFindings(component, findingId, topK)) as unknown as FindingNode[],
    relatedFindings: async (findingId) =>
      (await getRelatedFindings(component, findingId)) as unknown as FindingNode[],
    similarAttacks: async (content, topK = 5) =>
      (await findSimilarAttacks(component, content, topK)) as unknown as AttackPattern[],
    attackChains: async (techniqueId, maxDepth = 3) =>
      (await getAttackChains(component, techniqueId, maxDepth)) as unknown as AttackChain[],

    // ComponentService has GetMissionRunHistory, but the SDK has never exposed a
    // client for it. Reported as unsupported rather than answered with an empty
    // list: "no runs" and "this transport cannot tell you" are different, and an
    // agent that conflates them reports a clean history it never read.
    runHistory: async () => {
      throw new Error(
        "componentKnowledge: mission run history is not available over ComponentService; " +
          "use a dispatched run's task harness (taskKnowledge)",
      )
    },

    // ApplicationFindings exists only on HarnessCallbackService. Reported as
    // unsupported for the same reason as runHistory above: "this Application
    // has no Findings" and "this transport cannot tell you" are different
    // answers, and an agent that conflates them reports a clean Application it
    // never read.
    applicationFindings: async () => {
      throw new Error(
        "componentKnowledge: application findings are not available over ComponentService; " +
          "use a dispatched run's task harness (taskKnowledge)",
      )
    },
  }
}
