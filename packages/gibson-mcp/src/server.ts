// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { createRequire } from "node:module"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import type { ToolRegistry } from "./registry.js"
import type { PromptDefinition, ResourceDefinition } from "./resources.js"

/** The package version, read from package.json beside dist. */
export function packageVersion(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version: string }).version
  } catch {
    return "0.0.0"
  }
}

export const SERVER_NAME = "gibson"

export interface ServerBinding {
  registry: ToolRegistry
  /** Text the host shows the model once, at initialize. */
  instructions?: string
  /** Readable resources: the ambient block and the session coordinates. */
  resources?: ResourceDefinition[]
  /** Prompts, for a host with no hook surface to inject the ambient block. */
  prompts?: PromptDefinition[]
}

/**
 * Bind one MCP protocol server to a transport. Every server reads the same
 * registry: the stdio path has one, the HTTP path has one per session. A
 * registry change reaches each attached server as `tools/list_changed`.
 */
export async function attachServer(binding: ServerBinding, transport: Transport): Promise<Server> {
  const resources = binding.resources ?? []
  const prompts = binding.prompts ?? []
  const server = new Server(
    { name: SERVER_NAME, version: packageVersion() },
    {
      capabilities: {
        tools: { listChanged: true },
        ...(resources.length > 0 ? { resources: {} } : {}),
        ...(prompts.length > 0 ? { prompts: {} } : {}),
      },
      ...(binding.instructions ? { instructions: binding.instructions } : {}),
    },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: binding.registry.list().map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.annotations ? { annotations: t.annotations } : {}),
    })),
  }))
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) =>
    binding.registry.call(req.params.name, req.params.arguments ?? {}, {
      headers: extra.requestInfo?.headers as Record<string, string | string[] | undefined> | undefined,
      signal: extra.signal,
    }),
  )
  if (resources.length > 0) {
    server.setRequestHandler(ListResourcesRequestSchema, async () => ({
      resources: resources.map((r) => ({ uri: r.uri, name: r.name, title: r.title, description: r.description, mimeType: r.mimeType })),
    }))
    server.setRequestHandler(ReadResourceRequestSchema, async (req) => {
      const resource = resources.find((r) => r.uri === req.params.uri)
      if (!resource) throw new Error(`no resource ${req.params.uri}`)
      return { contents: [await resource.read()] }
    })
  }

  if (prompts.length > 0) {
    server.setRequestHandler(ListPromptsRequestSchema, async () => ({
      prompts: prompts.map((p) => ({ name: p.name, title: p.title, description: p.description, arguments: p.arguments })),
    }))
    server.setRequestHandler(GetPromptRequestSchema, async (req) => {
      const prompt = prompts.find((p) => p.name === req.params.name)
      if (!prompt) throw new Error(`no prompt ${req.params.name}`)
      return prompt.get(req.params.arguments ?? {})
    })
  }

  const off = binding.registry.onChange(() => {
    void server.sendToolListChanged().catch(() => {})
  })
  server.onclose = () => off()
  await server.connect(transport)
  return server
}
