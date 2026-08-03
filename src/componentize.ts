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
 * SCOPE — two pieces of #11 are deliberately not here:
 *
 *  1. **Image build and publish** is a build-system concern, not an RPC. A
 *     produced artifact needs an image reference before it can be dispatched;
 *     that is carried in `metadata.image` and is the caller's responsibility.
 *  2. **Autonomous enrollment** — a produced component needs its own identity and
 *     a short-TTL bootstrap token, which requires the policy-bounded enrollment
 *     RPC in gibson#1185. That RPC does not exist yet. {@link enrollComponent}
 *     therefore registers under the CALLING agent's identity, which makes the
 *     component visible in the tenant registry but does not give it a credential
 *     of its own. {@link enrollmentSupported} reports this honestly.
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
  /** Registry instance ID of the enrolled component. */
  instanceId: string
  /** How often the component must heartbeat to stay in the registry. */
  heartbeatIntervalMs: number
  /**
   * True once the component holds its own credential. Always false today:
   * the policy-bounded enrollment RPC is gibson#1185, so the component is
   * registered under the calling agent's identity.
   */
  hasOwnIdentity: boolean
}

/**
 * Whether a produced component can be given an identity of its own.
 *
 * Hardcoded to false until gibson#1185 lands the tenant-scoped enrollment RPC.
 * Callers should surface this rather than imply the artifact is fully autonomous.
 */
export function enrollmentSupported(): { supported: false; reason: string } {
  return {
    supported: false,
    reason:
      "autonomous component enrollment needs the policy-bounded enrollment RPC (gibson#1185); " +
      "the component is registered under the calling agent's identity and has no credential of its own",
  }
}

/**
 * Register a produced artifact into the tenant fleet.
 *
 * Throws when the spec is invalid — an unregistrable artifact should fail loudly
 * at the point of enrollment, not become an inert catalog entry.
 */
export async function enrollComponent(
  component: Client<typeof ComponentService>,
  spec: ComponentSpec,
): Promise<EnrollmentResult> {
  const problems = validateComponentSpec(spec)
  if (problems.length > 0) {
    throw new Error(`enrollComponent: invalid ${spec.kind} spec: ${problems.join("; ")}`)
  }

  const manifest = buildComponentManifest(spec)
  const res = await component.registerComponent(manifest)
  return {
    instanceId: res.instanceId,
    heartbeatIntervalMs: res.heartbeatIntervalMs > 0 ? res.heartbeatIntervalMs : 15_000,
    hasOwnIdentity: false,
  }
}
