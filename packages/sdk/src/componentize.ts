// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

/**
 * Componentize a produced artifact into the tenant fleet (zerocool-plugins#11).
 *
 * Gibson's component contract is language-neutral: what makes an artifact a
 * component is the shape it registers with, not the language it is written in.
 * `RegisterComponentRequest` (component.proto:619) IS that contract — kind, name,
 * version, and the kind-specific fields below. This module builds and validates
 * that shape, then registers it.
 *
 * SCOPE — one piece of #11 is deliberately not here:
 *
 *  1. **Image build and publish** is a build-system concern, not an RPC. A
 *     produced artifact needs an image reference, pinned by digest, before it
 *     can be enrolled. That is carried in `metadata.image` and is the
 *     caller's responsibility.
 *
 * Enrollment gives the produced component an identity of its own
 * (`ComponentService.EnrollComponent`, gibson#33). The daemon takes the
 * tenant and the producer from the identity of the calling agent, assigns the
 * trust, applies the quota of the tenant and returns a one-time bootstrap
 * token for the new component. The component starts with that token
 * (`GIBSON_BOOTSTRAP_TOKEN`) and registers itself.
 */

/** The three component kinds the registry accepts. */
export type ComponentKind = "agent" | "tool" | "plugin"

/** A plugin method, with the description an agent reads to pick between methods. */
export interface ComponentMethodSpec {
  name: string
  description?: string
  /** JSON Schema for this method's input. */
  inputSchemaJson?: string
}

/**
 * A produced artifact, described in the terms `RegisterComponent` accepts.
 * Which fields are required depends on `kind` — see {@link validateComponentSpec}.
 */
export interface ComponentSpec {
  kind: ComponentKind
  name: string
  version: string
  /**
   * Free-form metadata. By convention `image` carries the OCI reference of the
   * built artifact and `language` records what it was written in.
   */
  metadata?: Record<string, string>
  /** Agent capabilities. Required when kind === "agent". */
  capabilities?: string[]
  /** Plugin method names. Required when kind === "plugin". */
  methods?: string[]
  /** Rich per-method metadata; the superset of `methods`. */
  methodDescriptors?: ComponentMethodSpec[]
  /** Fully-qualified proto input type. Required when kind === "tool". */
  inputMessageType?: string
  /** Fully-qualified proto output type. Required when kind === "tool". */
  outputMessageType?: string
  /** Serialized proto FileDescriptorSet describing a tool's schema. */
  fileDescriptorSet?: Uint8Array
  /** JSON Schema for a plugin's configuration surface. */
  configSchemaJson?: string
}

/**
 * Check a spec against the contract before it reaches the wire. Returns the list
 * of problems; empty means the spec is registrable.
 *
 * The daemon accepts a partially-filled registration and the component simply
 * never becomes dispatchable, so validating here is what turns a silent no-op
 * into an actionable error.
 */
export function validateComponentSpec(spec: ComponentSpec): string[] {
  const problems: string[] = []

  if (!spec.name) problems.push("name is required")
  if (!spec.version) problems.push("version is required")
  if (!["agent", "tool", "plugin"].includes(spec.kind)) {
    problems.push(`kind must be "agent", "tool" or "plugin" (got ${JSON.stringify(spec.kind)})`)
  }

  switch (spec.kind) {
    case "agent":
      if (!spec.capabilities?.length) {
        problems.push("an agent must declare at least one capability")
      }
      break
    case "tool":
      if (!spec.inputMessageType) problems.push("a tool must declare inputMessageType")
      if (!spec.outputMessageType) problems.push("a tool must declare outputMessageType")
      break
    case "plugin":
      if (!spec.methods?.length && !spec.methodDescriptors?.length) {
        problems.push("a plugin must declare at least one method")
      }
      break
  }

  if (spec.configSchemaJson) {
    try {
      JSON.parse(spec.configSchemaJson)
    } catch {
      problems.push("configSchemaJson is not valid JSON")
    }
  }
  for (const m of spec.methodDescriptors ?? []) {
    if (!m.name) problems.push("every method descriptor needs a name")
    if (m.inputSchemaJson) {
      try {
        JSON.parse(m.inputSchemaJson)
      } catch {
        problems.push(`method ${m.name}: inputSchemaJson is not valid JSON`)
      }
    }
  }

  return problems
}

/** The registration payload, ready for `RegisterComponent`. */
export interface ComponentManifest {
  kind: string
  name: string
  version: string
  metadata: Record<string, string>
  capabilities: string[]
  methods: string[]
  inputMessageType: string
  outputMessageType: string
  configSchemaJson: string
  methodDescriptors: { name: string; description: string; inputSchemaJson: string }[]
  fileDescriptorSet?: Uint8Array
}

/**
 * Build the registration manifest for a spec. Pure — no I/O — so it can be
 * inspected, diffed or written to disk before anything is registered.
 */
export function buildComponentManifest(spec: ComponentSpec): ComponentManifest {
  // `methods` stays populated even when methodDescriptors are supplied: the
  // proto keeps both, and older daemons read only the names.
  const methods = spec.methods ?? spec.methodDescriptors?.map((m) => m.name) ?? []
  return {
    kind: spec.kind,
    name: spec.name,
    version: spec.version,
    metadata: spec.metadata ?? {},
    capabilities: spec.capabilities ?? [],
    methods,
    inputMessageType: spec.inputMessageType ?? "",
    outputMessageType: spec.outputMessageType ?? "",
    configSchemaJson: spec.configSchemaJson ?? "",
    methodDescriptors: (spec.methodDescriptors ?? []).map((m) => ({
      name: m.name,
      description: m.description ?? "",
      inputSchemaJson: m.inputSchemaJson ?? "",
    })),
    ...(spec.fileDescriptorSet ? { fileDescriptorSet: spec.fileDescriptorSet } : {}),
  }
}

export interface EnrollmentResult {
  /** The identity of the new component, for example "tool_principal:<id>". */
  principalId: string
  /**
   * The one-time credential of the new component. Start the component with
   * it as GIBSON_BOOTSTRAP_TOKEN before expiresAt. It is good for this
   * component only.
   */
  bootstrapToken: string
  /** The end of the bootstrap token. */
  expiresAt: Date | undefined
}

/** An image reference pinned by digest, the form the daemon accepts. */
const PINNED_IMAGE = /@sha256:[0-9a-f]{64}$/

/**
 * Enroll a produced artifact into the tenant fleet with an identity of its
 * own (gibson#33).
 *
 * Throws when the spec is invalid or the image is not pinned by digest — an
 * unenrollable artifact should fail loudly at the point of enrollment.
 */
export async function enrollComponent(
  component: Client<typeof ComponentService>,
  spec: ComponentSpec,
): Promise<EnrollmentResult> {
  const problems = validateComponentSpec(spec)
  const image = spec.metadata?.image ?? ""
  if (!PINNED_IMAGE.test(image)) {
    problems.push("metadata.image must be an image reference pinned by digest (@sha256:...)")
  }
  if (problems.length > 0) {
    throw new Error(`enrollComponent: invalid ${spec.kind} spec: ${problems.join("; ")}`)
  }

  const res = await component.enrollComponent({
    kind: spec.kind,
    name: spec.name,
    version: spec.version,
    image,
    description: spec.metadata?.description ?? "",
  })
  return {
    principalId: res.principalId,
    bootstrapToken: res.bootstrapToken,
    expiresAt: res.expiresAt ? new Date(Number(res.expiresAt.seconds) * 1000 + Math.floor(res.expiresAt.nanos / 1e6)) : undefined,
  }
}
