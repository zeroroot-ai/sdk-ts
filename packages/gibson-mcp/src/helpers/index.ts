// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { ToolDefinition } from "../registry.js"
import type { Gibson } from "../session.js"
import { componentizeTools } from "./componentize.js"
import { helperContext, type HelperContext } from "./context.js"
import { delegationTools } from "./delegate.js"
import { findingTools } from "./findings.js"
import { knowledgeTools } from "./knowledge.js"
import { platformToolHelpers } from "./tools.js"

export * from "./context.js"
export * from "./coverage.js"
export { componentizeTools } from "./componentize.js"
export { delegationTools } from "./delegate.js"
export { findingTools, gibsonFindingsBackend, localFindingsBackend, taskFindingsBackend, type FindingsBackend } from "./findings.js"
export { knowledgeTools } from "./knowledge.js"
export { platformToolHelpers } from "./tools.js"

/**
 * One tool per SDK helper (gibson#1706, decision 2), for whatever this
 * posture can reach. A helper whose grant is absent registers no tool
 * rather than a tool that always fails.
 */
export function helperTools(ctx: HelperContext): ToolDefinition[] {
  return [...findingTools(ctx), ...knowledgeTools(ctx), ...delegationTools(ctx), ...componentizeTools(ctx), ...platformToolHelpers(ctx)]
}

export function helperToolsFor(gibson: Gibson, cwd: string, env: NodeJS.ProcessEnv): ToolDefinition[] {
  return helperTools(helperContext(gibson, cwd, env))
}
