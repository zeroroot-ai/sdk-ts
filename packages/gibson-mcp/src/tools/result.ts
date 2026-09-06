// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"

/** One text block. MCP has no title/metadata split, so the title leads the text. */
export function text(title: string, body: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: title ? `${title}\n\n${body}` : body }], ...(isError ? { isError } : {}) }
}

/** Error text for a failure the model can act on. */
export function failure(title: string, body: string): CallToolResult {
  return text(title, body, true)
}

/** A JSON document as the one text block, plus the structured copy. */
export function json(value: unknown): CallToolResult {
  const body = JSON.stringify(value, null, 2)
  return {
    content: [{ type: "text", text: body }],
    ...(value !== null && typeof value === "object" && !Array.isArray(value) ? { structuredContent: value as Record<string, unknown> } : {}),
  }
}
