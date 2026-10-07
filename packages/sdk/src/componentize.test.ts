// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildComponentManifest,
  enrollComponent,
  validateComponentSpec,
  type ComponentSpec,
} from "./componentize.js"

const AGENT: ComponentSpec = {
  kind: "agent",
  name: "produced-recon-agent",
  version: "0.1.0",
  capabilities: ["recon"],
  metadata: { image: "ghcr.io/tenant/produced-recon:0.1.0", language: "rust" },
}

test("a well-formed agent spec validates", () => {
  assert.deepEqual(validateComponentSpec(AGENT), [])
})

test("an agent without capabilities is rejected", () => {
  const problems = validateComponentSpec({ ...AGENT, capabilities: [] })
  assert.ok(problems.some((p) => p.includes("capability")))
})

test("a tool must declare both proto message types", () => {
  const problems = validateComponentSpec({
    kind: "tool",
    name: "produced-scanner",
    version: "0.1.0",
    inputMessageType: "gibson.tool.v1.ScanRequest",
  })
  assert.ok(problems.some((p) => p.includes("outputMessageType")))
  assert.ok(!problems.some((p) => p.includes("inputMessageType")))
})

test("a plugin must declare at least one method, by either field", () => {
  const bare: ComponentSpec = { kind: "plugin", name: "p", version: "0.1.0" }
  assert.ok(validateComponentSpec(bare).some((p) => p.includes("method")))

  const viaNames: ComponentSpec = { ...bare, methods: ["lookup"] }
  assert.deepEqual(validateComponentSpec(viaNames), [])

  const viaDescriptors: ComponentSpec = { ...bare, methodDescriptors: [{ name: "lookup" }] }
  assert.deepEqual(validateComponentSpec(viaDescriptors), [])
})

test("name, version and kind are required for every kind", () => {
  const problems = validateComponentSpec({
    kind: "widget" as ComponentSpec["kind"],
    name: "",
    version: "",
  })
  assert.ok(problems.some((p) => p.includes("name")))
  assert.ok(problems.some((p) => p.includes("version")))
  assert.ok(problems.some((p) => p.includes("kind")))
})

test("malformed JSON Schema is caught before registration", () => {
  const problems = validateComponentSpec({
    kind: "plugin",
    name: "p",
    version: "0.1.0",
    methods: ["m"],
    configSchemaJson: "{not json",
  })
  assert.ok(problems.some((p) => p.includes("configSchemaJson")))
})

test("buildComponentManifest derives methods from descriptors", () => {
  const manifest = buildComponentManifest({
    kind: "plugin",
    name: "p",
    version: "0.1.0",
    methodDescriptors: [
      { name: "lookup", description: "look an IP up" },
      { name: "enrich" },
    ],
  })
  // `methods` stays populated for daemons that read names only.
  assert.deepEqual(manifest.methods, ["lookup", "enrich"])
  assert.equal(manifest.methodDescriptors[0].description, "look an IP up")
  assert.equal(manifest.methodDescriptors[1].description, "", "absent description becomes empty, not undefined")
})

test("buildComponentManifest is pure and fills every proto field", () => {
  const manifest = buildComponentManifest(AGENT)
  for (const key of [
    "kind",
    "name",
    "version",
    "metadata",
    "capabilities",
    "methods",
    "inputMessageType",
    "outputMessageType",
    "configSchemaJson",
    "methodDescriptors",
  ]) {
    assert.ok(key in manifest, `manifest is missing ${key}`)
  }
  assert.equal(manifest.inputMessageType, "", "unused fields are empty strings, not undefined")
  assert.equal(manifest.metadata.image, "ghcr.io/tenant/produced-recon:0.1.0")
})

test("fileDescriptorSet is omitted when the spec has none", () => {
  const manifest = buildComponentManifest(AGENT)
  assert.ok(!("fileDescriptorSet" in manifest))
})

const PINNED = "ghcr.io/tenant/produced-recon@sha256:" + "a".repeat(64)

test("enrollComponent enrolls a valid spec with an identity of its own", async () => {
  let captured: Record<string, unknown> | undefined
  const component = {
    enrollComponent: async (req: Record<string, unknown>) => {
      captured = req
      return { principalId: "agent_principal:new", bootstrapToken: "one-time", expiresAt: { seconds: 1800000000n, nanos: 0 } }
    },
  }

  const result = await enrollComponent(component as never, { ...AGENT, metadata: { image: PINNED, description: "recon" } })

  assert.equal(captured?.kind, "agent")
  assert.equal(captured?.name, "produced-recon-agent")
  assert.equal(captured?.image, PINNED)
  assert.equal(captured?.description, "recon")
  assert.equal(result.principalId, "agent_principal:new")
  assert.equal(result.bootstrapToken, "one-time")
  assert.equal(result.expiresAt?.getTime(), 1800000000 * 1000)
})

test("enrollComponent refuses an image that is not pinned by digest", async () => {
  const component = {
    enrollComponent: async () => {
      throw new Error("must not be called")
    },
  }
  await assert.rejects(
    () => enrollComponent(component as never, AGENT),
    /pinned by digest/,
  )
})

test("enrollComponent refuses an invalid spec before it reaches the wire", async () => {
  const component = {
    enrollComponent: async () => {
      throw new Error("must not be called")
    },
  }
  await assert.rejects(
    () => enrollComponent(component as never, { ...AGENT, capabilities: [], metadata: { image: PINNED } }),
    /invalid agent spec.*capability/s,
  )
})
