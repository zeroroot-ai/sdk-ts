// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { MissionInfo } from "./gen/gibson/harness/v1/harness_callback_pb.js"
import type { TaskContext, TaskHarness } from "./task-harness.js"

/**
 * Mission origination over the TASK-scoped callback harness.
 *
 * The sibling of `createMission` in `delegate.ts`, which originates over
 * ComponentService with the component's own grant. A dispatched run should use
 * this instead: it travels on the per-dispatch capability grant, so the run
 * holds exactly the authority its dispatch granted (see `openTaskHarness`).
 *
 * TWO INPUTS, ONE ROUTE (ADR-0018). A mission is named either by a graph the
 * caller supplies or by the name of a definition checked into the platform's
 * mission catalog. Both travel on the same RPC deliberately: a dedicated
 * catalog RPC would carry its own authorization surface, so the per-tenant gate
 * and the ADR-0063 origination rule ("a component originates only from inside a
 * live parent") would be enforced in two places — which is where two
 * enforcement paths drift apart.
 *
 * The checked-in definition is the authoritative one. An agent that builds its
 * own copy of a mission the catalog already declares is the parallel definition
 * ADR-0027 forbids; name it instead.
 */

/** How to name the mission to originate. Exactly one form, never both. */
export interface CreateMissionOptions {
  /**
   * A caller-supplied mission graph, serialized to `mission_definition_json`.
   * Mutually exclusive with {@link catalogMission}.
   */
  missionDefinition?: unknown
  /**
   * The checked-in catalog mission to originate, by the name the catalog
   * declares. Mutually exclusive with {@link missionDefinition}.
   */
  catalogMission?: string
  /**
   * Parameters for the catalog mission, keyed by the definition's own parameter
   * names. The daemon treats this map as CLOSED: an unrecognised key is
   * refused, never ignored, because silently dropping a key a caller sent would
   * let that caller believe a parameter bound when it did not.
   *
   * The runtime target is NOT among them — it binds from {@link targetId}
   * alone, so a mission can only ever run against a target the tenant
   * registered.
   */
  catalogParams?: Record<string, string>
  /** The registered target the mission binds to. */
  targetId: string
  /** Optional human-readable name for the run. */
  name?: string
}

/**
 * The request this SDK puts on the wire, minus the task context.
 *
 * Exported so the builder can be tested as a pure function: the refusals below
 * are the reason this module exists, and a test that had to stand up a
 * transport to reach them would not be exercising them.
 */
export interface CreateMissionWire {
  missionDefinitionJson: Uint8Array
  catalogMission: string
  catalogParams: Record<string, string>
  targetId: string
  name: string
}

const EMPTY = new Uint8Array(0)

/**
 * Build the CreateMission request, refusing what the daemon would refuse.
 *
 * Both refusals are raised here rather than left to the daemon on purpose: the
 * daemon's error names the wire field, while an error raised at the call site
 * names the argument to drop.
 */
export function buildCreateMissionRequest(opts: CreateMissionOptions): CreateMissionWire {
  const named = (opts.catalogMission ?? "").length > 0

  // BOTH nullish values mean "no graph", and they do NOT encode alike:
  // `JSON.stringify(undefined)` is `undefined`, which encodes to zero bytes,
  // but `JSON.stringify(null)` is the four-byte string "null". So a builder
  // that serializes without normalising puts a non-empty graph on the wire
  // beside a catalog name, the daemon refuses the pair as InvalidArgument, and
  // the failure reads as "the catalog path does not work" rather than "you
  // passed a null definition". Normalise first, then test the LENGTH of the
  // serialized body — never a nullish check on the request field, because a
  // caller can put a literal `null` body there by other means.
  const absent = opts.missionDefinition === undefined || opts.missionDefinition === null
  const graph = absent ? EMPTY : encodeJSON(opts.missionDefinition)
  const hasGraph = graph.length > 0

  if (!named && opts.catalogParams !== undefined) {
    // Checked before the two below so the most specific mistake wins. Inventing
    // a mission name from the presence of parameters would mask the daemon's
    // "neither input" refusal and originate something the caller never named.
    throw new Error(
      "gibson-sdk: `catalogParams` was given without `catalogMission` — " +
        "parameters do not name a mission; set `catalogMission` to the catalog definition to run",
    )
  }
  if (named && hasGraph) {
    throw new Error(
      "gibson-sdk: createMission takes a graph or a catalog mission, not both — " +
        "drop `missionDefinition` to originate the checked-in definition, or drop " +
        "`catalogMission` to originate your own graph",
    )
  }
  if (!named && !hasGraph) {
    throw new Error(
      "gibson-sdk: createMission needs either `missionDefinition` or `catalogMission` — " +
        "passing neither would originate nothing",
    )
  }

  return {
    missionDefinitionJson: hasGraph ? graph : EMPTY,
    catalogMission: named ? opts.catalogMission! : "",
    catalogParams: named ? (opts.catalogParams ?? {}) : {},
    targetId: opts.targetId,
    name: opts.name ?? "",
  }
}

/**
 * Originate a mission on the task grant.
 *
 * Errors from the daemon — an unknown catalog mission, an unrecognised
 * parameter key, a missing required parameter, an authz or origination denial —
 * surface as a thrown ConnectRPC error carrying the daemon's message. Show it
 * rather than retrying: every one of them is a decision, not a transient fault.
 */
export async function createTaskMission(harness: TaskHarness, opts: CreateMissionOptions): Promise<MissionInfo> {
  const wire = buildCreateMissionRequest(opts)
  const context: TaskContext = harness.context
  const res = await harness.client.createMission({ context, ...wire })
  const mission = res.mission
  if (!mission) {
    throw new Error(
      `gibson-sdk: createMission returned no mission for ${wire.catalogMission || "the supplied graph"} — ` +
        "the daemon answered without one, so there is nothing to run",
    )
  }
  return mission
}

function encodeJSON(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}
