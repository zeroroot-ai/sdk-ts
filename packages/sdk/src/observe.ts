// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { create } from "@bufbuild/protobuf"
import {
  ObserveRequestSchema,
  type AccountObservation,
  type CredentialObservation,
  type DomainObservation,
  type HostObservation,
  type MemoryObservation,
  type SubdomainObservation,
} from "./gen/gibson/harness/v1/harness_callback_pb.js"
import type { TaskHarness } from "./task-harness.js"
import { WorldEntityKind } from "./gen/gibson/harness/v1/harness_callback_pb.js"

/** The read half of Observe: what a WorldView entity is. Re-exported so a caller can name kinds without reaching into gen. */
export { WorldEntityKind }

/**
 * Observe — the agent's one write into the World (gibson ADR-0012).
 *
 * An observation is a raw sighting. The brain resolves identity and topology,
 * the projector writes the graph, and scope and tenant come from the mission
 * the task grant names. There is no field for any of them here, so a caller
 * cannot get them wrong.
 *
 * A memory is an observation like the others (gibson#1593, decision 10). The
 * Taxonomy gate lands it as an `Observation` node with shape `Memory`, and
 * `recall` reads it back with `node_types: ["Observation"]`.
 */
/** A message's plain-object init: every field optional, no runtime markers. */
type Init<T> = Partial<Omit<T, "$typeName" | "$unknown">>

/**
 * One outgoing relationship of a lifecycle entity.
 *
 * The other end is named by its LABEL and IDENTITY, never by a node id: an
 * emitter does not know node ids and must not be able to guess them. Both ends
 * and the relationship type must be admitted by the Taxonomy, or the daemon
 * skips the edge while still landing the entity.
 */
export interface LifecycleEdge {
  /** A Taxonomy relationship type, e.g. "CONTAINS" or "TOUCHES". */
  type: string
  /** The Taxonomy label of the other end, e.g. "Control". */
  targetLabel: string
  /** The other end's identity properties, folded the same way as `idProperties`. */
  targetIdProperties: Record<string, string>
}

/**
 * A sighting of a typed application-lifecycle entity — an Application,
 * Repository, Image, Package, Deployment, Vulnerability, MergeRequest,
 * Pipeline or Control (gibson#1656).
 *
 * Identity is per LABEL, not per write path, so an entity observed twice
 * resolves to the same node however the sighting reached the daemon. That is
 * what lets an agent annotate a Finding a scan raised — name its `brain_id` and
 * the write lands on the existing node instead of creating a second one.
 *
 * A property this sighting OMITS keeps whatever an earlier one established; a
 * property set to `""` erases it. So omit what you did not decide rather than
 * sending an empty string for it.
 */
export interface LifecycleEntity {
  /** The Taxonomy label, e.g. "Finding". Outside the Taxonomy it lands as an `Observation` rather than being refused. */
  label: string
  /** The properties that identify it. Several are folded into a composite key in sorted order. */
  idProperties: Record<string, string>
  /** Its non-identifying facts. Omit a property to leave an earlier sighting's value alone. */
  properties?: Record<string, string>
  /** The outgoing relationships seen in this sighting. */
  edges?: LifecycleEdge[]
}

export type Observation =
  | { host: Init<HostObservation> }
  | { domain: Init<DomainObservation> }
  | { subdomain: Init<SubdomainObservation> }
  | { credential: Init<CredentialObservation> }
  | { account: Init<AccountObservation> }
  | { memory: Init<MemoryObservation> }
  | { lifecycleEntity: LifecycleEntity }

const CASES = ["host", "domain", "subdomain", "credential", "account", "memory", "lifecycleEntity"] as const

/** Emit one observation under the task grant. Rejects when the daemon refuses it. */
export async function observe(harness: TaskHarness, observation: Observation): Promise<void> {
  const set = CASES.filter((c) => c in observation)
  if (set.length !== 1) {
    throw new Error(`gibson-sdk: an observation carries exactly one shape, got ${JSON.stringify(set)}`)
  }
  const kind = set[0]!
  if (kind === "lifecycleEntity") {
    const e = (observation as { lifecycleEntity: LifecycleEntity }).lifecycleEntity
    // Refused here rather than sent. The daemon records nothing for an entity
    // with no identity property — there would be no stable node to project — so
    // sending one is a write that reports success and changes nothing, which is
    // the failure this SDK is meant to make impossible to reach by accident.
    if (!e.label) {
      throw new Error("gibson-sdk: a lifecycle entity carries a Taxonomy label")
    }
    if (Object.keys(e.idProperties ?? {}).length === 0) {
      throw new Error(
        `gibson-sdk: a lifecycle entity carries at least one identity property; ${e.label} has none, ` +
          "so the daemon would have no stable node to project it onto",
      )
    }
  }
  const req = create(ObserveRequestSchema, {
    context: harness.context,
    observation: { case: kind, value: (observation as Record<string, unknown>)[kind] } as never,
  })
  const res = await harness.client.observe(req)
  if (res.error) {
    throw new Error(`gibson-sdk: Observe rejected (${res.error.code}): ${res.error.message}`)
  }
}

/** What a coding agent wants to keep across runs. */
export interface Memory {
  /** The fact, in the agent's own words. */
  text: string
  /** A short category, for example "convention", "decision", "layout". */
  kind?: string
  /** Free-form, lower-case. */
  tags?: string[]
  /** Where the fact came from: a path, a URL, or a work id. */
  sourceRef?: string
}

/** Keep a fact: `observe` with a memory shape. */
export function remember(harness: TaskHarness, memory: Memory): Promise<void> {
  if (!memory.text.trim()) return Promise.reject(new Error("gibson-sdk: a memory needs text"))
  return observe(harness, {
    memory: { text: memory.text, kind: memory.kind ?? "", tags: memory.tags ?? [], sourceRef: memory.sourceRef ?? "" },
  })
}
