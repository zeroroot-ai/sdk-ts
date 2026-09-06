// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { defineTool } from "../tool.js"
import type { ToolDefinition } from "../registry.js"
import type { Gibson } from "../session.js"
import { text } from "./result.js"

/** One tool that says how this session is connected to Gibson and why. */
export function statusTool(current: () => Gibson): ToolDefinition {
  return defineTool({
    name: "gibson_status",
    description:
      "Show how this session is connected to Gibson: the check-in source (dispatched grant, bootstrap token, " +
      "enrolled host key, or none), the posture (standalone, component, live, task), the platform, tenant, " +
      "target, mission and run ids, and what is missing if anything.",
    input: {},
    annotations: { readOnlyHint: true },
    handler: async () => text("", describeGibson(current())),
  })
}

export function describeGibson(g: Gibson): string {
  const lines = [`source: ${g.source}`, `posture: ${g.mode}`, `agent: ${g.agentName}`]
  if (g.settings.platformURL) lines.push(`platform: ${g.settings.platformURL}`)
  if (g.settings.tenant) lines.push(`tenant: ${g.settings.tenant}`)
  if (g.settings.targetId) lines.push(`target: ${g.settings.targetId}`)
  if (g.session) lines.push(`component_scope: ${g.session.componentScope}`, `instance: ${g.session.instance.current()}`)
  if (g.live) {
    lines.push(`mission: ${g.live.missionId}`)
    if (g.runId) lines.push(`run: ${g.runId}`)
    lines.push(`work: ${g.live.workId}`)
    const exp = g.live.harness.expiresAt()
    lines.push(`grant expires: ${exp && Number.isFinite(exp) ? new Date(exp).toISOString() : "unknown"}`)
  }
  if (g.reason) lines.push(`note: ${g.reason}`)
  return lines.join("\n")
}
