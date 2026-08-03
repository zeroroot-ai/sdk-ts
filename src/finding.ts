import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"

/**
 * Findings — the World-facing knowledge surface (zerocool-plugins#7).
 *
 * WIRE FORMAT — read this before you change anything here.
 *
 * `ComponentService.SubmitFinding.finding` is a `bytes` field whose proto comment
 * says "proto-encoded Finding message". **That comment is wrong** (sdk#448). Both
 * ends of the wire use JSON:
 *
 *   - Producer  — Go SDK `serve/platform_harness.go:730`: `json.Marshal(*finding.Finding)`.
 *   - Consumer  — gibson `internal/platform/component/service.go:1608`:
 *     `findingJSON := string(req.Finding)`; the graph loader then reads the JSON
 *     keys `title`, `severity`, `description` and `category`.
 *
 * The types below are a faithful port of the Go SDK `finding` package
 * (`opensource/sdk/finding/finding.go`) — snake_case keys, same optionality.
 * The sibling `HarnessCallbackService.SubmitFinding` is a genuinely typed RPC
 * (`gibson.types.v1.Finding`); it is the in-cluster dispatched-work path and is
 * NOT what an off-cluster component calls.
 */

/** Severity levels. Mirrors Go `finding.Severity` (finding/severity.go). */
export type Severity = "critical" | "high" | "medium" | "low" | "info"

/** Finding lifecycle state. Mirrors Go `finding.Status` (finding/export.go). */
export type FindingStatus = "open" | "confirmed" | "resolved" | "false_positive"

/** Mirrors Go `finding.MitreMapping`. */
export interface MitreMapping {
  matrix: string
  tactic_id: string
  tactic_name: string
  technique_id: string
  technique_name: string
  sub_techniques?: string[]
}

/** Mirrors Go `finding.Evidence`. */
export interface Evidence {
  type: string
  title: string
  content: string
  /** RFC3339 timestamp — Go marshals `time.Time` as RFC3339. */
  timestamp: string
  metadata?: Record<string, unknown>
}

/** Mirrors Go `finding.ReproStep`. */
export interface ReproStep {
  order: number
  description: string
  input?: string
}

/** Mirrors Go `finding.Finding`. Field names are the Go JSON tags, verbatim. */
export interface Finding {
  id: string
  mission_id: string
  agent_name: string
  delegated_from?: string
  title: string
  description: string
  category: string
  subcategory?: string
  severity: Severity
  confidence: number
  mitre_attack?: MitreMapping
  mitre_atlas?: MitreMapping
  evidence?: Evidence[]
  reproduction?: ReproStep[]
  cvss_score?: number
  risk_score: number
  remediation?: string
  references?: string[]
  target_id?: string
  technique?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  status: FindingStatus
  created_at: string
  updated_at: string
}

/** The fields a caller must supply; the rest are defaulted by {@link newFinding}. */
export interface NewFindingInput {
  title: string
  description: string
  category: string
  severity: Severity
  missionID?: string
  agentName?: string
  confidence?: number
  evidence?: Evidence[]
  targetID?: string
  technique?: string
  tags?: string[]
  metadata?: Record<string, unknown>
  remediation?: string
  references?: string[]
}

/** Severity weights. Mirrors Go `finding.severityWeights` (finding/severity.go:46). */
const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 10.0,
  high: 7.5,
  medium: 5.0,
  low: 2.5,
  info: 1.0,
}

/**
 * Risk score = severity weight * confidence, with no rounding — byte-for-byte the
 * Go SDK's `calculateRiskScore` (finding/finding.go:310).
 */
export function calculateRiskScore(severity: Severity, confidence: number): number {
  return SEVERITY_WEIGHT[severity] * confidence
}

/**
 * Build a Finding with the same defaults as Go `finding.NewFinding`:
 * fresh UUID, confidence 1.0, status "open", created_at == updated_at,
 * risk_score derived from severity and confidence.
 */
export function newFinding(input: NewFindingInput): Finding {
  const now = new Date().toISOString()
  const confidence = input.confidence ?? 1.0
  return {
    id: crypto.randomUUID(),
    mission_id: input.missionID ?? "",
    agent_name: input.agentName ?? "zerocool",
    title: input.title,
    description: input.description,
    category: input.category,
    severity: input.severity,
    confidence,
    risk_score: calculateRiskScore(input.severity, confidence),
    status: "open",
    created_at: now,
    updated_at: now,
    ...(input.evidence ? { evidence: input.evidence } : {}),
    ...(input.targetID ? { target_id: input.targetID } : {}),
    ...(input.technique ? { technique: input.technique } : {}),
    ...(input.tags ? { tags: input.tags } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.remediation ? { remediation: input.remediation } : {}),
    ...(input.references ? { references: input.references } : {}),
  }
}

/**
 * Validate a Finding against the Go SDK's `Finding.Validate` rules. Returns the
 * list of problems; empty means valid. The daemon does not validate the payload,
 * so a malformed finding is stored and only fails later at the graph loader —
 * check locally instead of discovering it in a Neo4j warning log.
 */
export function validateFinding(f: Finding): string[] {
  const problems: string[] = []
  if (!f.id) problems.push("id is required")
  if (!f.title) problems.push("title is required")
  if (!f.description) problems.push("description is required")
  if (!f.category) problems.push("category is required")
  if (!(f.severity in SEVERITY_WEIGHT)) problems.push(`invalid severity: ${f.severity}`)
  if (f.confidence < 0 || f.confidence > 1) problems.push("confidence must be between 0 and 1")
  return problems
}

/** Encode a Finding for the `bytes finding` field — JSON, not proto (see the module note). */
export function encodeFinding(f: Finding): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(f))
}

/**
 * Submit a finding to the tenant World under the caller's COMPONENT identity.
 *
 * `workId` is optional: the daemon only uses it to associate the finding with a
 * mission run, and an off-cluster Depth-1 agent has no work item. It is passed
 * through when present.
 *
 * Returns the server-assigned finding ID.
 */
export async function submitFinding(
  component: Client<typeof ComponentService>,
  f: Finding,
  workId = "",
): Promise<string> {
  const problems = validateFinding(f)
  if (problems.length > 0) {
    throw new Error(`submitFinding: invalid finding: ${problems.join("; ")}`)
  }
  const res = await component.submitFinding({ workId, finding: encodeFinding(f) })
  return res.findingId
}

/**
 * Read back findings for the tenant. `filter` is a JSON-encoded Go `finding.Filter`.
 *
 * NOTE: the daemon's `findingQuerier` seam is currently unwired, so this returns
 * `Unimplemented` on a live cluster — see gibson#1186.
 */
export async function getFindings(
  component: Client<typeof ComponentService>,
  filter: Record<string, unknown> = {},
  workId = "",
): Promise<Finding[]> {
  const res = await component.getFindings({
    workId,
    filterJson: new TextEncoder().encode(JSON.stringify(filter)),
  })
  return decodeJSONBytes<Finding[]>(res.findingsJson) ?? []
}

/** Decode a `bytes …_json` field. Returns undefined for an empty payload. */
export function decodeJSONBytes<T>(bytes: Uint8Array | undefined): T | undefined {
  if (!bytes || bytes.length === 0) return undefined
  return JSON.parse(new TextDecoder().decode(bytes)) as T
}
