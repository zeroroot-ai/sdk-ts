import { test } from "node:test"
import assert from "node:assert/strict"
import {
  calculateRiskScore,
  encodeFinding,
  newFinding,
  submitFinding,
  validateFinding,
  type Finding,
} from "./finding.js"

/**
 * Golden tests for the SubmitFinding wire format.
 *
 * The fixture below is what Go's `json.Marshal(*finding.Finding)` produces for a
 * finding built by `finding.NewFinding` — the exact bytes the daemon reads with
 * `string(req.Finding)`. If a key here changes, the daemon's graph loader stops
 * seeing it, so the shape is asserted key-by-key rather than by round-tripping.
 */
const GO_GOLDEN_KEYS = [
  "id",
  "mission_id",
  "agent_name",
  "title",
  "description",
  "category",
  "severity",
  "confidence",
  "risk_score",
  "status",
  "created_at",
  "updated_at",
] as const

test("newFinding produces the Go SDK's default shape", () => {
  const f = newFinding({
    title: "Reflected XSS in /search",
    description: "The q parameter is echoed unescaped.",
    category: "injection",
    severity: "high",
  })

  for (const key of GO_GOLDEN_KEYS) {
    assert.ok(key in f, `missing required key ${key}`)
  }
  // Defaults from Go finding.NewFinding.
  assert.equal(f.confidence, 1.0)
  assert.equal(f.status, "open")
  assert.equal(f.created_at, f.updated_at)
  assert.equal(f.risk_score, 7.5, "high * 1.0 confidence")
  assert.match(f.id, /^[0-9a-f]{8}-[0-9a-f]{4}-/, "id is a UUID")
})

test("risk score matches the Go severity weights exactly", () => {
  // finding/severity.go:46 — note info is 1.0, not 0.
  assert.equal(calculateRiskScore("critical", 1.0), 10.0)
  assert.equal(calculateRiskScore("high", 1.0), 7.5)
  assert.equal(calculateRiskScore("medium", 1.0), 5.0)
  assert.equal(calculateRiskScore("low", 1.0), 2.5)
  assert.equal(calculateRiskScore("info", 1.0), 1.0)
  // calculateRiskScore does not round (finding/finding.go:310).
  assert.equal(calculateRiskScore("high", 0.5), 3.75)
})

test("optional fields are omitted, not emitted as null", () => {
  // Go uses `omitempty` on every optional field; a null would change the
  // decoded shape on the daemon side.
  const f = newFinding({
    title: "t",
    description: "d",
    category: "c",
    severity: "low",
  })
  const decoded = JSON.parse(new TextDecoder().decode(encodeFinding(f)))
  for (const optional of ["evidence", "tags", "metadata", "cvss_score", "remediation"]) {
    assert.ok(!(optional in decoded), `${optional} should be omitted when unset`)
  }
})

test("supplied optional fields survive encoding", () => {
  const f = newFinding({
    title: "t",
    description: "d",
    category: "c",
    severity: "critical",
    tags: ["web", "owasp-a03"],
    targetID: "target-1",
    evidence: [
      { type: "http", title: "response", content: "<script>", timestamp: "2026-08-03T00:00:00Z" },
    ],
  })
  const decoded = JSON.parse(new TextDecoder().decode(encodeFinding(f)))
  assert.deepEqual(decoded.tags, ["web", "owasp-a03"])
  assert.equal(decoded.target_id, "target-1")
  assert.equal(decoded.evidence[0].type, "http")
})

test("validateFinding mirrors the Go Validate rules", () => {
  const valid = newFinding({ title: "t", description: "d", category: "c", severity: "low" })
  assert.deepEqual(validateFinding(valid), [])

  const missing = { ...valid, title: "", category: "" }
  const problems = validateFinding(missing)
  assert.ok(problems.some((p) => p.includes("title")))
  assert.ok(problems.some((p) => p.includes("category")))

  const badSeverity = { ...valid, severity: "urgent" as Finding["severity"] }
  assert.ok(validateFinding(badSeverity).some((p) => p.includes("severity")))

  const badConfidence = { ...valid, confidence: 1.5 }
  assert.ok(validateFinding(badConfidence).some((p) => p.includes("confidence")))
})

test("submitFinding sends JSON bytes and returns the server finding id", async () => {
  let captured: { workId: string; finding: Uint8Array } | undefined
  const component = {
    submitFinding: async (req: { workId: string; finding: Uint8Array }) => {
      captured = req
      return { findingId: "srv-finding-1" }
    },
  }

  const f = newFinding({ title: "t", description: "d", category: "c", severity: "medium" })
  const id = await submitFinding(component as never, f, "work-9")

  assert.equal(id, "srv-finding-1")
  assert.equal(captured?.workId, "work-9")
  // The payload must be JSON, NOT a proto encoding (sdk#448).
  const text = new TextDecoder().decode(captured!.finding)
  assert.equal(text[0], "{", "payload must start with a JSON object")
  assert.deepEqual(JSON.parse(text), f)
})

test("submitFinding refuses an invalid finding before it reaches the wire", async () => {
  const component = {
    submitFinding: async () => {
      throw new Error("must not be called")
    },
  }
  const bad = { ...newFinding({ title: "t", description: "d", category: "c", severity: "low" }), title: "" }
  await assert.rejects(() => submitFinding(component as never, bad, ""), /invalid finding.*title/s)
})

test("workId defaults to empty for an off-cluster agent with no work item", async () => {
  let captured: { workId: string } | undefined
  const component = {
    submitFinding: async (req: { workId: string; finding: Uint8Array }) => {
      captured = req
      return { findingId: "x" }
    },
  }
  await submitFinding(
    component as never,
    newFinding({ title: "t", description: "d", category: "c", severity: "info" }),
  )
  assert.equal(captured?.workId, "")
})
