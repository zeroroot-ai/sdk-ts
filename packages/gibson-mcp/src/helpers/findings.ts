// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { appendFile, mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { getFindings, newFinding, submitFinding, type Finding, type GibsonSession, type Severity, type TaskHarness } from "@zeroroot-ai/sdk"
import { z } from "zod"
import type { ToolDefinition } from "../registry.js"
import { defineTool } from "../tool.js"
import { failure, json, text } from "../tools/result.js"
import type { HelperContext } from "./context.js"

const SEVERITIES = ["critical", "high", "medium", "low", "info"] as const

export interface FindingsBackend {
  submit(f: Finding): Promise<string>
  describe(): string
}

/** Platform backend: the finding lands in the tenant knowledge graph. */
export function gibsonFindingsBackend(session: GibsonSession): FindingsBackend {
  return { submit: (f) => submitFinding(session.clients.component, f), describe: () => "the tenant Gibson graph" }
}

/**
 * Task backend: the callback service's typed SubmitFinding, under the
 * dispatch grant. Fields map from the SDK's JSON finding onto
 * gibson.types.v1.Finding; the daemon assigns the id and the mission.
 */
export function taskFindingsBackend(harness: TaskHarness): FindingsBackend {
  const severity = (s: string): number => ({ critical: 1, high: 2, medium: 3, low: 4, info: 5 })[s] ?? 0
  return {
    submit: async (f) => {
      const res = await harness.client.submitFinding({
        context: harness.context,
        finding: {
          id: f.id,
          missionId: f.mission_id,
          agentName: f.agent_name,
          title: f.title,
          description: f.description,
          category: f.category,
          severity: severity(f.severity),
          confidence: f.confidence,
          remediation: f.remediation ?? "",
          targetId: f.target_id ?? "",
          tags: f.tags ?? [],
          evidence: (f.evidence ?? []).map((e) => ({ type: e.type, title: e.title, content: e.content })),
        } as never,
      })
      if (res.error) throw new Error(`SubmitFinding refused: ${res.error.message}`)
      // The callback acknowledges without an id; the finding keeps the one
      // newFinding minted, which is what the daemon stored.
      return f.id
    },
    describe: () => "the tenant Gibson graph (dispatch grant)",
  }
}

/** Standalone backend: an append-only JSONL log. */
export function localFindingsBackend(path: string): FindingsBackend {
  return {
    submit: async (f) => {
      await mkdir(dirname(path), { recursive: true })
      await appendFile(path, `${JSON.stringify(f)}\n`, "utf8")
      return f.id
    },
    describe: () => path,
  }
}

/**
 * Findings: emit what the agent discovers. The model calls this when it
 * finds something. Nothing here emits on its own: a file edit is not a
 * security finding, and inventing one fills the tenant graph with noise a
 * person then has to triage.
 */
export function findingTools(ctx: HelperContext): ToolDefinition[] {
  const out: ToolDefinition[] = [
    defineTool({
      name: "submit_finding",
      description:
        "Record a security finding in the Gibson knowledge graph. Use this when you discover a " +
        "real vulnerability, misconfiguration or notable security fact about the target or " +
        "codebase. Not for progress updates or general observations.",
      input: {
        title: z.string().describe("One-line summary of the finding."),
        description: z.string().describe("What the issue is, where it is, and why it matters."),
        category: z.string().describe('Type of issue, e.g. "injection", "auth", "secrets-exposure", "misconfiguration".'),
        severity: z.enum(SEVERITIES).describe("Impact level of the finding."),
        confidence: z.number().min(0).max(1).optional().describe("How certain you are, from 0 to 1. Defaults to 1."),
        evidence: z.string().optional().describe("A code excerpt, request/response, or log line."),
        remediation: z.string().optional().describe("How to fix or mitigate the issue."),
        target_id: z.string().optional().describe("Identifier of the affected target or component."),
        tags: z.array(z.string()).optional().describe("Labels for filtering."),
      },
      handler: async (args) => {
        const finding = newFinding({
          title: args.title,
          description: args.description,
          category: args.category,
          severity: args.severity as Severity,
          confidence: args.confidence,
          missionID: ctx.gibson.live?.missionId ?? "",
          agentName: ctx.gibson.agentName,
          ...(args.remediation ? { remediation: args.remediation } : {}),
          ...(args.target_id ? { targetID: args.target_id } : {}),
          ...(args.tags ? { tags: args.tags } : {}),
          ...(args.evidence ? { evidence: [{ type: "text", title: "evidence", content: args.evidence, timestamp: new Date().toISOString() }] } : {}),
        })
        try {
          const id = await ctx.findings.submit(finding)
          return text(`${args.severity}: ${args.title}`, `Recorded finding ${id} in ${ctx.findings.describe()}.`)
        } catch (e) {
          return failure("submit_finding failed", (e as Error).message)
        }
      },
    }),
  ]

  if (ctx.gibson.session) {
    const component = ctx.gibson.session.clients.component
    out.push(
      defineTool({
        name: "get_findings",
        description:
          "Read findings already recorded in this tenant's Gibson graph. Filter by any field the " +
          "finding carries, for example mission_id, severity, category or target_id.",
        input: { filter: z.record(z.string(), z.unknown()).optional().describe("Equality filters on finding fields. Omit for every finding the caller may read.") },
        annotations: { readOnlyHint: true },
        handler: async (args) => json(await getFindings(component, args.filter ?? {})),
      }),
    )
  }
  return out
}
