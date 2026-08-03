import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"
import type { Value } from "./gen/gibson/graphrag/v1/graphrag_pb.js"
import { decodeJSONBytes } from "./finding.js"

/**
 * Knowledge graph reads — GraphRAG through the harness (zerocool-plugins#8).
 *
 * Every RPC here is tenant-scoped server-side: the daemon derives the tenant from
 * the caller's COMPONENT identity and rejects the `_system` tenant outright
 * (gibson `internal/platform/component/service_graphrag.go:17`). A caller cannot
 * widen its own scope, so there is no tenant argument to get wrong.
 *
 * DAEMON STATE: the `graphrag` and `findingQuerier` seams are declared but not
 * wired at the daemon's registration site, so these RPCs answer `Unimplemented`
 * on a live cluster today — gibson#1186. The client side is complete and every
 * shape is taken from the proto, so it starts working when the seam is wired.
 */

/** One hit from a knowledge-graph query. Flattened from `gibson.graphrag.v1.QueryResult`. */
export interface KnowledgeHit {
  /** Node identifier in the tenant graph. */
  id: string
  /** Node type — "finding", "host", "technique", … */
  type: string
  /** Combined relevance from the hybrid vector + graph ranking. */
  score: number
  /** Free-text content indexed for semantic search. */
  content: string
  /** Node properties, decoded from the graphrag `Value` union into plain JS. */
  properties: Record<string, unknown>
  /** Hop distance from the query seed, when the result came through a traversal. */
  distance: number
}

export interface QueryKnowledgeOptions {
  /** Query text; embedded server-side for the vector half of the search. */
  text: string
  /** Cap on returned nodes (proto `top_k`). Defaults to 10. */
  topK?: number
  /** Restrict to these node types. */
  nodeTypes?: string[]
  /** Drop hits scoring below this threshold. */
  minScore?: number
  /** Extra equality filters on node properties. */
  filters?: Record<string, string>
  /** Work item to attribute the query to; empty for an off-cluster agent. */
  workId?: string
}

/**
 * Query the tenant knowledge graph with hybrid vector + graph scoring.
 *
 * Results are flattened to plain objects, so a caller never has to reach into
 * generated proto types or decode the `Value` union by hand.
 */
export async function queryKnowledge(
  component: Client<typeof ComponentService>,
  opts: QueryKnowledgeOptions,
): Promise<KnowledgeHit[]> {
  const res = await component.queryNodes({
    workId: opts.workId ?? "",
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
}

/**
 * Findings semantically similar to a known finding. `results_json` is a
 * JSON-encoded `[]graphrag.FindingNode` on the wire.
 */
export async function findSimilarFindings(
  component: Client<typeof ComponentService>,
  findingId: string,
  topK = 5,
  workId = "",
): Promise<Record<string, unknown>[]> {
  const res = await component.findSimilarFindings({ workId, findingId, topK })
  return decodeJSONBytes<Record<string, unknown>[]>(res.resultsJson) ?? []
}

/** Findings reachable from a given finding through graph edges. */
export async function getRelatedFindings(
  component: Client<typeof ComponentService>,
  findingId: string,
  workId = "",
): Promise<Record<string, unknown>[]> {
  const res = await component.getRelatedFindings({ workId, findingId })
  return decodeJSONBytes<Record<string, unknown>[]>(res.resultsJson) ?? []
}

/** Attack patterns semantically similar to arbitrary content. */
export async function findSimilarAttacks(
  component: Client<typeof ComponentService>,
  content: string,
  topK = 5,
  workId = "",
): Promise<Record<string, unknown>[]> {
  const res = await component.findSimilarAttacks({ workId, content, topK })
  return decodeJSONBytes<Record<string, unknown>[]>(res.resultsJson) ?? []
}

/** Multi-hop attack paths starting from a MITRE technique. */
export async function getAttackChains(
  component: Client<typeof ComponentService>,
  techniqueId: string,
  maxDepth = 3,
  workId = "",
): Promise<Record<string, unknown>[]> {
  const res = await component.getAttackChains({ workId, techniqueId, maxDepth })
  return decodeJSONBytes<Record<string, unknown>[]>(res.resultsJson) ?? []
}

/**
 * Render knowledge hits as a compact block for a system prompt. Kept here rather
 * than in the plugin so every consumer formats recalled context the same way.
 */
export function formatKnowledgeForPrompt(hits: KnowledgeHit[]): string {
  if (hits.length === 0) return ""
  const lines = hits.map((h) => {
    const title = h.properties.title ?? h.properties.name ?? h.id
    const detail = h.properties.description ?? h.content
    return detail ? `- [${h.type}] ${title} — ${detail}` : `- [${h.type}] ${title}`
  })
  return `Prior knowledge from this tenant's Gibson graph:\n${lines.join("\n")}`
}

/** Decode a `map<string, Value>` property bag into plain JS values. */
export function decodeProperties(props: Record<string, Value> | undefined): Record<string, unknown> {
  if (!props) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(props)) {
    out[key] = decodeValue(value)
  }
  return out
}

/** Decode one `gibson.graphrag.v1.Value` oneof into a plain JS value. */
export function decodeValue(v: Value | undefined): unknown {
  if (!v?.kind) return undefined
  switch (v.kind.case) {
    case "stringValue":
    case "boolValue":
    case "doubleValue":
      return v.kind.value
    // int64 and timestamps arrive as bigint; widen to number so JSON.stringify
    // does not throw on a value that is always well inside the safe range.
    case "intValue":
    case "timestampValue":
      return Number(v.kind.value)
    case "bytesValue":
      return new TextDecoder().decode(v.kind.value)
    case "listValue":
      return v.kind.value.values.map(decodeValue)
    case "mapValue":
      return decodeProperties(v.kind.value.fields)
    default:
      return undefined
  }
}
