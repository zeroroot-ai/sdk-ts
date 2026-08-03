import { test } from "node:test"
import assert from "node:assert/strict"
import {
  buildComponentManifest,
  enrollComponent,
  enrollmentSupported,
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

test("enrollComponent registers a valid spec and reports the borrowed identity", async () => {
  let captured: Record<string, unknown> | undefined
  const component = {
    registerComponent: async (req: Record<string, unknown>) => {
      captured = req
      return { instanceId: "inst-1", heartbeatIntervalMs: 20_000 }
    },
  }

  const result = await enrollComponent(component as never, AGENT)

  assert.equal(captured?.kind, "agent")
  assert.equal(captured?.name, "produced-recon-agent")
  assert.equal(result.instanceId, "inst-1")
  assert.equal(result.heartbeatIntervalMs, 20_000)
  // Until gibson#1185 lands there is no per-component credential.
  assert.equal(result.hasOwnIdentity, false)
})

test("enrollComponent falls back to a sane heartbeat interval", async () => {
  const component = {
    registerComponent: async () => ({ instanceId: "inst-1", heartbeatIntervalMs: 0 }),
  }
  const result = await enrollComponent(component as never, AGENT)
  assert.equal(result.heartbeatIntervalMs, 15_000)
})

test("enrollComponent refuses an invalid spec before it reaches the wire", async () => {
  const component = {
    registerComponent: async () => {
      throw new Error("must not be called")
    },
  }
  await assert.rejects(
    () => enrollComponent(component as never, { ...AGENT, capabilities: [] }),
    /invalid agent spec.*capability/s,
  )
})

test("enrollmentSupported reports the gibson#1185 gap honestly", () => {
  const { supported, reason } = enrollmentSupported()
  assert.equal(supported, false)
  assert.match(reason, /gibson#1185/)
})
