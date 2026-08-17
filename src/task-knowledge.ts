import type { Client } from "@connectrpc/connect"
import type { HarnessCallbackService } from "./clients.js"
import type { AttackChain, AttackPattern, FindingNode } from "./gen/gibson/graphrag/v1/graphrag_pb.js"
import type { MissionRunSummary } from "./gen/gibson/types/v1/types_pb.js"
import { RunScope } from "./gen/gibson/harness/v1/harness_callback_pb.js"
import { decodeProperties, type KnowledgeHit, type QueryKnowledgeOptions } from "./knowledge.js"

/**
 * The knowledge reads over the TASK-scoped callback harness.
 *
 * The sibling of `knowledge.ts`, which reads the same graph over
 * ComponentService with the component's own grant. A dispatched run should use
 * these instead: they travel on the per-dispatch capability grant, so the run
 * holds exactly the authority its dispatch granted rather than borrowing the
 * component's. See `connectTaskHarness` in `callback.ts`.
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

/** A knowledge source, however it is reached. Lets a caller pick a transport once. */
export interface KnowledgeSource {
  query(opts: QueryKnowledgeOptions): Promise<KnowledgeHit[]>
  similarFindings(findingId: string, topK?: number): Promise<FindingNode[]>
  relatedFindings(findingId: string): Promise<FindingNode[]>
  similarAttacks(content: string, topK?: number): Promise<AttackPattern[]>
  attackChains(techniqueId: string, maxDepth?: number): Promise<AttackChain[]>
  runHistory(): Promise<MissionRunSummary[]>
}

/**
 * Build a {@link KnowledgeSource} over a task-scoped harness client.
 *
 * ```ts
 * const harness = connectTaskHarness({ endpoint, token })
 * const knowledge = taskKnowledge(harness)
 * const hits = await knowledge.query({ text: "prior findings for this repo" })
 * ```
 */
export function taskKnowledge(harness: Client<typeof HarnessCallbackService>): KnowledgeSource {
  return {
    async query(opts) {
      const res = await harness.queryNodes({
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
      return (await harness.findSimilarFindings({ findingId, topK })).results
    },

    async relatedFindings(findingId) {
      return (await harness.getRelatedFindings({ findingId })).results
    },

    async similarAttacks(content, topK = 5) {
      return (await harness.findSimilarAttacks({ content, topK })).results
    },

    async attackChains(techniqueId, maxDepth = 3) {
      return (await harness.getAttackChains({ techniqueId, maxDepth })).results
    },

    async runHistory() {
      return (await harness.getMissionRunHistory({})).runs
    },
  }
}

/** Re-exported so a caller can name a scope without importing generated code. */
export { RunScope }
