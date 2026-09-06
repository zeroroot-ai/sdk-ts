// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { z, type ZodRawShape } from "zod"
import type { JsonSchema, ToolAnnotations, ToolContext, ToolDefinition } from "./registry.js"
import { failure } from "./tools/result.js"

/**
 * A hand-signed tool: a zod shape for the input, a typed handler. The JSON
 * Schema the host sees is derived from the shape, so a description written
 * once on a field reaches the model.
 */
export interface ToolSpec<S extends ZodRawShape> {
  name: string
  description: string
  input: S
  annotations?: ToolAnnotations
  handler: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<CallToolResult>
}

export function jsonSchemaOf(shape: ZodRawShape): JsonSchema {
  const raw = z.toJSONSchema(z.object(shape), { io: "input" }) as Record<string, unknown>
  delete raw.$schema
  return { ...raw, type: "object" }
}

export function defineTool<S extends ZodRawShape>(spec: ToolSpec<S>): ToolDefinition {
  const schema = z.object(spec.input)
  return {
    name: spec.name,
    description: spec.description,
    inputSchema: jsonSchemaOf(spec.input),
    ...(spec.annotations ? { annotations: spec.annotations } : {}),
    handler: async (raw, ctx) => {
      const parsed = schema.safeParse(raw)
      if (!parsed.success) return failure(`${spec.name}: invalid arguments`, z.prettifyError(parsed.error))
      return spec.handler(parsed.data as z.infer<z.ZodObject<S>>, ctx)
    },
  }
}
