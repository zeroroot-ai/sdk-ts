// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { callGibsonTool, listGibsonPlugins, listGibsonTools, parseMaybeJSON, queryGibsonPlugin } from "@zeroroot-ai/sdk"
import { z } from "zod"
import type { ToolDefinition } from "../registry.js"
import { defineTool } from "../tool.js"
import { failure, text } from "../tools/result.js"
import type { HelperContext } from "./context.js"

export interface ToolOutcome {
  output: unknown
  error?: { code: string; message: string; retryable: boolean }
}

export function formatToolResult(name: string, result: ToolOutcome) {
  if (result.error) {
    return failure(`${name} failed`, `Gibson tool ${name} failed [${result.error.code}]: ${result.error.message}${result.error.retryable ? " (retryable)" : ""}`)
  }
  const body = typeof result.output === "string" ? result.output : JSON.stringify(result.output, null, 2)
  return text(name, body ?? "(no output)")
}

/**
 * The generic tool and plugin surface. `gibson_call_tool` stays even where
 * discovery works: discovery answers `Unimplemented` on some daemons
 * (gibson#1186), and an operator may know a tool by name.
 */
export function platformToolHelpers(ctx: HelperContext): ToolDefinition[] {
  if (!ctx.gibson.session) return []
  const component = ctx.gibson.session.clients.component
  return [
    defineTool({
      name: "gibson_call_tool",
      description:
        "Invoke a Gibson tool by name through the harness. Use this when you know a tool's name " +
        "but it is not in your tool list. Gibson tool discovery is not available on every daemon.",
      input: {
        name: z.string().describe("Registered Gibson tool name."),
        input: z.record(z.string(), z.unknown()).describe("Input object matching the tool's input schema."),
        timeout_ms: z.number().int().min(1).optional().describe("Per-call timeout in milliseconds."),
      },
      handler: async (args) =>
        formatToolResult(args.name, await callGibsonTool(component, { name: args.name, input: args.input, ...(args.timeout_ms ? { timeoutMs: args.timeout_ms } : {}) })),
    }),
    defineTool({
      name: "list_gibson_tools",
      description: "List the Gibson tools available to this tenant, with the input message type each one expects.",
      input: {},
      annotations: { readOnlyHint: true },
      handler: async () => {
        const discovery = await listGibsonTools(component)
        if (discovery.unavailable) return text("discovery unavailable", `Tool discovery is unavailable: ${discovery.unavailable}.`)
        if (discovery.tools.length === 0) return text("no tools", "No Gibson tools are registered for this tenant.")
        const lines = discovery.tools.map((t) => `- ${t.name} (${t.version}): ${t.description || "no description"}${t.inputMessageType ? `\n    input: ${t.inputMessageType}` : ""}`)
        return text(`${discovery.tools.length} tool${discovery.tools.length === 1 ? "" : "s"}`, lines.join("\n"))
      },
    }),
    defineTool({
      name: "list_gibson_plugins",
      description: "List the Gibson plugins in the catalog, annotated with this tenant's enablement and health.",
      input: {},
      annotations: { readOnlyHint: true },
      handler: async () => {
        const plugins = await listGibsonPlugins(component)
        if (plugins.length === 0) return text("no plugins", "The catalog holds no plugins for this tenant.")
        const lines = plugins.map((p) => `- ${p.name} (${p.version}): ${p.description || "no description"} [${p.enabled ? "enabled" : "disabled"}, ${p.healthStatus || "health unknown"}]`)
        return text(`${plugins.length} plugin${plugins.length === 1 ? "" : "s"}`, lines.join("\n"))
      },
    }),
    defineTool({
      name: "query_plugin",
      description: "Call a method on a tenant Gibson plugin (a connector or an integration) through the harness.",
      input: {
        plugin: z.string().describe("Plugin name."),
        method: z.string().describe("Method name."),
        params: z.record(z.string(), z.unknown()).optional().describe("Method parameters."),
      },
      handler: async (args) =>
        formatToolResult(`${args.plugin}.${args.method}`, await queryGibsonPlugin(component, { plugin: args.plugin, method: args.method, params: args.params ?? {} })),
    }),
    defineTool({
      name: "parse_gibson_output",
      description:
        "Decode a Gibson `*_json` string field. A tool is free to return a bare string, so a value " +
        "that does not parse comes back as the raw text rather than an error.",
      input: { raw: z.string().describe("The raw string field.") },
      annotations: { readOnlyHint: true },
      handler: async (args) => text("", JSON.stringify(parseMaybeJSON(args.raw) ?? null, null, 2)),
    }),
  ]
}
