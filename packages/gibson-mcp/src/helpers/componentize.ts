// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { mkdir, writeFile } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { buildComponentManifest, enrollComponent, enrollmentSupported, validateComponentSpec, type ComponentKind, type ComponentSpec } from "@zeroroot-ai/sdk"
import { z } from "zod"
import type { ToolDefinition } from "../registry.js"
import { defineTool } from "../tool.js"
import { failure, json, text } from "../tools/result.js"
import type { HelperContext } from "./context.js"

/** Componentize and enroll: produced artifacts join the fleet. */
const KINDS = ["agent", "tool", "plugin"] as const

const specSchema = {
  kind: z.enum(KINDS).describe("Component kind."),
  name: z.string().describe("Component name, as it will appear in the tenant registry."),
  version: z.string().describe('Semantic version of the artifact, e.g. "0.1.0".'),
  image: z.string().optional().describe("OCI image reference of the built artifact. Required before it can be dispatched."),
  language: z.string().optional().describe("Language the artifact is written in, for the catalog."),
  capabilities: z.array(z.string()).optional().describe('Agent capabilities. Required when kind is "agent".'),
  methods: z.array(z.string()).optional().describe('Plugin method names. Required when kind is "plugin".'),
  input_message_type: z.string().optional().describe('Fully-qualified proto input type. Required when kind is "tool".'),
  output_message_type: z.string().optional().describe('Fully-qualified proto output type. Required when kind is "tool".'),
  config_schema_json: z.string().optional().describe("JSON Schema for a plugin's configuration."),
}

export interface SpecArgs {
  kind: string
  name: string
  version: string
  image?: string
  language?: string
  capabilities?: string[]
  methods?: string[]
  input_message_type?: string
  output_message_type?: string
  config_schema_json?: string
}

export function toSpec(args: SpecArgs): ComponentSpec {
  const metadata: Record<string, string> = {}
  if (args.image) metadata.image = args.image
  if (args.language) metadata.language = args.language
  return {
    kind: args.kind as ComponentKind,
    name: args.name,
    version: args.version,
    metadata,
    ...(args.capabilities ? { capabilities: args.capabilities } : {}),
    ...(args.methods ? { methods: args.methods } : {}),
    ...(args.input_message_type ? { inputMessageType: args.input_message_type } : {}),
    ...(args.output_message_type ? { outputMessageType: args.output_message_type } : {}),
    ...(args.config_schema_json ? { configSchemaJson: args.config_schema_json } : {}),
  }
}

function invalid(spec: ComponentSpec, problems: string[]) {
  return failure("invalid component spec", `This artifact does not satisfy Gibson's ${spec.kind} contract:\n${problems.map((p) => `- ${p}`).join("\n")}`)
}

export function componentizeTools(ctx: HelperContext): ToolDefinition[] {
  const out: ToolDefinition[] = [
    defineTool({
      name: "validate_component",
      description: "Check an artifact against Gibson's component contract without writing anything. Names every problem it finds.",
      input: specSchema,
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        const spec = toSpec(args)
        const problems = validateComponentSpec(spec)
        if (problems.length > 0) return invalid(spec, problems)
        return text("valid", `${spec.kind} ${spec.name}@${spec.version} satisfies the component contract.`)
      },
    }),
    defineTool({
      name: "componentize",
      description:
        "Turn a built artifact into a Gibson component manifest and write it to disk. Use this after " +
        "building a tool or agent you want to add to the fleet. Validates the artifact against " +
        "Gibson's component contract. Does not build or push an image.",
      input: { ...specSchema, path: z.string().optional().describe('Where to write the manifest. Defaults to "gibson-component.json".') },
      handler: async (args) => {
        const spec = toSpec(args)
        const problems = validateComponentSpec(spec)
        if (problems.length > 0) return invalid(spec, problems)
        const manifest = buildComponentManifest(spec)
        const target = resolve(ctx.cwd, args.path ?? "gibson-component.json")
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, `${JSON.stringify(manifest, null, 2)}\n`, "utf8")
        const missingImage = spec.metadata?.image
          ? ""
          : "\n\nNo image reference was given. Build and push an image, then re-run with image=<oci-ref> before you enroll. A component without an image cannot be dispatched."
        return text(`${spec.kind} manifest: ${spec.name}`, `Wrote a valid ${spec.kind} manifest for ${spec.name}@${spec.version} to ${target}.${missingImage}`)
      },
    }),
  ]

  if (ctx.gibson.session) {
    const component = ctx.gibson.session.clients.component
    out.push(
      defineTool({
        name: "enroll_component",
        description: "Register a produced artifact with Gibson so it joins the tenant fleet. Run componentize first to check the artifact against the component contract.",
        input: specSchema,
        handler: async (args) => {
          const spec = toSpec(args)
          const problems = validateComponentSpec(spec)
          if (problems.length > 0) return invalid(spec, problems)
          try {
            const result = await enrollComponent(component, spec)
            const { reason } = enrollmentSupported()
            return text(
              `enrolled ${spec.name}`,
              `Registered ${spec.kind} ${spec.name}@${spec.version} as instance ${result.instanceId}.\n\nNote: ${reason}. It is visible in the tenant registry, but it drops out when heartbeats stop (every ${Math.round(result.heartbeatIntervalMs / 1000)}s) unless the artifact itself runs and checks in.`,
            )
          } catch (e) {
            return failure("enroll failed", (e as Error).message)
          }
        },
      }),
    )
  }
  return out
}

/** Kept exported so a caller can inspect the manifest a spec would produce. */
export function manifestOf(args: SpecArgs): unknown {
  return json(buildComponentManifest(toSpec(args)))
}
