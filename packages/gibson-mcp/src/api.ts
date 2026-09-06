// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { z } from "zod"
import type { ToolDefinition } from "./registry.js"
import type { RpcEntry } from "./rpc.js"
import { defineTool } from "./tool.js"
import { failure, json } from "./tools/result.js"

/**
 * The door to the full API (sdk-ts#70).
 *
 * The platform's whole surface is one tool per RPC, and there are 188 of
 * them. Every host loads every description into the model context on each
 * turn, so putting all of them in `tools/list` costs the same tokens whether
 * or not the agent needs a single one, buries the tools it actually reaches
 * for, and trips the tool cap some hosts impose.
 *
 * So the generated tools stay built and stay 1:1 with the descriptors, and
 * two tools stand in front of them: one to find an RPC, one to call it.
 * Coverage is unchanged. Only exposure changed, and `--expose-all-rpcs`
 * puts the flat set back in `tools/list` for a host that wants it.
 */

/** Words that carry no signal in a search over RPC names. */
const STOPWORDS = new Set(["a", "an", "the", "to", "for", "of", "in", "on", "with", "and", "or", "is", "are", "be", "please", "me", "my"])

export const DEFAULT_SEARCH_LIMIT = 10
export const MAX_SEARCH_LIMIT = 50
export const SUGGESTIONS = 3

export function terms(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t))
}

/** True when `haystack` holds `term` as a whole underscore- or space-separated word. */
function wholeWord(haystack: string, term: string): boolean {
  return new RegExp(`(^|[^a-z0-9])${term}([^a-z0-9]|$)`).test(haystack)
}

/**
 * Rank one RPC against a query.
 *
 * The weights say what a person searching for an RPC is actually naming: the
 * method first, the service second, the prose last. A whole-word hit beats a
 * substring, so "job" does not rank `job_service_get_job` below something
 * that merely contains "jobs" in a sentence.
 */
export function score(entry: RpcEntry, query: string): number {
  const words = terms(query)
  if (words.length === 0) return 0
  const method = entry.method.name.toLowerCase()
  const methodSnake = entry.tool.name.slice(entry.tool.name.length - method.length)
  const service = entry.service.name.toLowerCase()
  const comment = entry.comment.toLowerCase()
  const toolName = entry.tool.name

  let total = 0
  let hit = 0
  for (const term of words) {
    let best = 0
    if (wholeWord(methodSnake, term)) best = 10
    else if (methodSnake.includes(term)) best = 6
    if (best === 0 && wholeWord(service, term)) best = 4
    else if (best === 0 && service.includes(term)) best = 2
    if (best === 0 && wholeWord(comment, term)) best = 3
    else if (best === 0 && comment.includes(term)) best = 1
    if (best > 0) hit += 1
    total += best
  }
  if (total === 0) return 0
  // A query whose every word landed beats one that matched half of itself,
  // whatever the raw weights add up to.
  total += hit === words.length ? 8 : 0
  // The whole phrase written as a tool name is the strongest signal there is.
  if (toolName.includes(words.join("_"))) total += 8
  return total
}

export interface SearchHit {
  name: string
  description: string
  service: string
  input_schema: unknown
  score: number
}

/** Rank the catalog. Ties break on the shorter name, then alphabetically. */
export function search(catalog: RpcEntry[], query: string, limit: number): SearchHit[] {
  return catalog
    .map((entry) => ({ entry, score: score(entry, query) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.entry.tool.name.length - b.entry.tool.name.length || (a.entry.tool.name < b.entry.tool.name ? -1 : 1))
    .slice(0, limit)
    .map(({ entry, score: value }) => ({
      name: entry.tool.name,
      description: entry.tool.description,
      service: entry.service.typeName,
      input_schema: entry.tool.inputSchema,
      score: value,
    }))
}

/** The services in the catalog, with a method count each. */
export function services(catalog: RpcEntry[]): { service: string; tools: number; example: string }[] {
  const byService = new Map<string, RpcEntry[]>()
  for (const entry of catalog) {
    const list = byService.get(entry.service.typeName) ?? []
    list.push(entry)
    byService.set(entry.service.typeName, list)
  }
  return [...byService.entries()]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, entries]) => ({ service: name, tools: entries.length, example: entries[0]!.tool.name }))
}

/** Dice coefficient over character bigrams. Survives a typo; an equality test does not. */
export function similarity(a: string, b: string): number {
  const grams = (s: string): string[] => Array.from({ length: Math.max(0, s.length - 1) }, (_, i) => s.slice(i, i + 2))
  const left = grams(a)
  const right = new Map<string, number>()
  for (const g of grams(b)) right.set(g, (right.get(g) ?? 0) + 1)
  let shared = 0
  for (const g of left) {
    const n = right.get(g) ?? 0
    if (n > 0) {
      shared += 1
      right.set(g, n - 1)
    }
  }
  return left.length + grams(b).length === 0 ? 0 : (2 * shared) / (left.length + grams(b).length)
}

/** The names closest to `name`, for a caller that mistyped one. */
export function closest(catalog: RpcEntry[], name: string, count = SUGGESTIONS): string[] {
  return catalog
    .map((entry) => ({ name: entry.tool.name, score: similarity(name.toLowerCase(), entry.tool.name) }))
    .sort((a, b) => b.score - a.score || (a.name < b.name ? -1 : 1))
    .slice(0, count)
    .map((c) => c.name)
}

export interface ApiToolOptions {
  catalog: RpcEntry[]
  /** True when the flat set is also in `tools/list`, which changes what to say. */
  exposeAll?: boolean
}

/**
 * The description both meta-tools carry.
 *
 * It has one job: tell a model the door exists. A model that never reads the
 * 188 entries has no other way to learn that `CreateBank`, `OpenJob` or
 * `PutSessionContext` are reachable at all, so the examples are not
 * decoration.
 */
function surfaceLine(catalog: RpcEntry[]): string {
  const count = catalog.length
  const serviceCount = new Set(catalog.map((e) => e.service.typeName)).size
  return (
    `The Gibson platform's whole API is reachable this way: ${count} RPCs across ${serviceCount} services, ` +
    "including banks of always-on agents (CreateBank, ListMembers), jobs (OpenJob, SendInput, CloseJob), " +
    "missions (CreateMission, RunMission), the knowledge graph (QueryNodes, Observe), findings, targets, " +
    "component registration, credentials and the session store. These RPCs are not in your tool list, " +
    "because listing all of them would cost more context than it is worth. Search here first."
  )
}

export function apiTools(opts: ApiToolOptions): ToolDefinition[] {
  const { catalog } = opts
  const byName = new Map(catalog.map((e) => [e.tool.name, e]))
  const surface = surfaceLine(catalog)

  return [
    defineTool({
      name: "gibson_api_search",
      description:
        `Find an RPC on the Gibson platform API. ${surface} ` +
        "Returns each match with its exact tool name, its description, its service, and the full JSON " +
        "schema of its input, so the result is everything you need to call it with gibson_api_call. " +
        'Call it with an empty query to see the services and how many RPCs each one has, e.g. query "" first, ' +
        'then query "open a job" or "submit a finding".',
      input: {
        query: z
          .string()
          .describe('What you want to do, in your own words, e.g. "submit a finding" or "list the members of a bank". Empty lists the services instead.'),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe(`Maximum matches. Defaults to ${DEFAULT_SEARCH_LIMIT}, capped at ${MAX_SEARCH_LIMIT}.`),
      },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        if (catalog.length === 0) {
          return failure("no platform API", "This session is not checked in to a platform, so no RPC is reachable. Call gibson_status.")
        }
        // An empty query is an agent orienting itself, not a failed search.
        // Answering with "no matches" would teach it the API is empty.
        if (!args.query.trim()) {
          return json({ services: services(catalog), rpcs: catalog.length, next: 'Search again with what you want to do, e.g. "open a job".' })
        }
        const limit = Math.min(args.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
        const hits = search(catalog, args.query, limit)
        if (hits.length === 0) {
          return json({
            query: args.query,
            matches: [],
            services: services(catalog).map((s) => s.service),
            next: "Nothing matched. Try one word from the thing you want to act on, or search with an empty query to see the services.",
          })
        }
        return json({ query: args.query, matches: hits, showing: hits.length, of: catalog.length })
      },
    }),
    defineTool({
      name: "gibson_api_call",
      description:
        `Call one RPC on the Gibson platform API by its exact tool name. ${surface} ` +
        "Use gibson_api_search first to get the name and the input schema. The input must be canonical " +
        "protojson for that RPC's request message. A name that does not exist comes back with the closest " +
        "ones, so a near miss costs one call rather than a guess.",
      input: {
        name: z.string().describe('Exact tool name from gibson_api_search, e.g. "harness_callback_service_world_view".'),
        input: z.record(z.string(), z.unknown()).optional().describe("The request message as protojson. Omit for an RPC whose request has no fields."),
        timeout_ms: z.number().int().min(1).optional().describe("Per-call deadline in milliseconds."),
      },
      handler: async (args, ctx) => {
        if (catalog.length === 0) {
          return failure("no platform API", "This session is not checked in to a platform, so no RPC is reachable. Call gibson_status.")
        }
        const entry = byName.get(args.name)
        if (!entry) {
          const suggestions = closest(catalog, args.name)
          return failure(
            `no RPC named ${args.name}`,
            `The closest names are:\n${suggestions.map((s) => `- ${s}`).join("\n")}\n\nCall gibson_api_search to find the right one.`,
          )
        }
        // The same handler the flat tier registers, so the two paths cannot
        // drift: there is only one of them.
        return entry.tool.handler(args.input ?? {}, { ...ctx, ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}) })
      },
    }),
  ]
}
