// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import type { DescService } from "@bufbuild/protobuf"
import { readdir } from "node:fs/promises"
import { cleanComment, parseServices } from "../scripts/generate-tools.js"
import { GENERATED_SERVICES } from "./generated/tools.js"

const run = promisify(execFile)
// dist-test/src/generate.test.js -> the package root is two levels up.
const pkg = join(dirname(fileURLToPath(import.meta.url)), "..", "..")
const generated = join(pkg, "src", "generated", "tools.ts")

test("a comment loses the protoc-gen-es bookkeeping and keeps the prose", () => {
  const block = `/**
   * WorldView returns the caller's slice of the tenant World.
   *
   * @generated from rpc gibson.harness.v1.HarnessCallbackService.WorldView
   */`
  assert.equal(cleanComment(block), "WorldView returns the caller's slice of the tenant World.")
  assert.equal(cleanComment("/**\n * @generated from rpc X\n */"), "")
})

test("the parser reads the proto name, the methods and their comments off a generated file", () => {
  const source = `
/**
 * A service that does one thing.
 *
 * @generated from service gibson.example.v1.ExampleService
 */
export const ExampleService: GenService<{
  /**
   * Does the thing.
   *
   * @generated from rpc gibson.example.v1.ExampleService.DoThing
   */
  doThing: {
    methodKind: "unary";
    input: typeof DoThingRequestSchema;
    output: typeof DoThingResponseSchema;
  },
  /**
   * @generated from rpc gibson.example.v1.ExampleService.Watch
   */
  watch: {
    methodKind: "server_streaming";
    input: typeof WatchRequestSchema;
    output: typeof WatchResponseSchema;
  },
}> = serviceDesc(file_gibson_example_v1_example, 0);
`
  const [service] = parseServices(source, "@zeroroot-ai/sdk/gen/gibson/example/v1/example_pb.js")
  assert.equal(service?.typeName, "gibson.example.v1.ExampleService")
  assert.equal(service?.description, "A service that does one thing.")
  assert.deepEqual(service?.methods, [
    { localName: "doThing", description: "Does the thing." },
    { localName: "watch", description: "" },
  ])
})

test("a service with no proto name is refused rather than guessed", () => {
  const source = `export const MysteryService: GenService<{\n  a: {\n    methodKind: "unary";\n  },\n}> = serviceDesc(f, 0);\n`
  assert.throws(() => parseServices(source, "x.js"), /no "@generated from service" comment/)
})

/** Every generated `_pb.ts` under the SDK's bindings. */
async function bindingFiles(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...(await bindingFiles(full)))
    else if (entry.name.endsWith("_pb.ts")) out.push(full)
  }
  return out
}

test("the table names every service in the bindings, not only the ones it already knew", async () => {
  // The guard that was missing. The per-service comparison walks the table,
  // so a service absent from the table is invisible to it: when v0.177.0
  // added gibson.bank.v1 and gibson.job.v1, the table described the ten
  // services it had and matched them perfectly. This walks the bindings on
  // disk instead, so a whole service that never reached the table fails.
  const gen = join(pkg, "..", "sdk", "src", "gen", "gibson")
  const onDisk = new Set<string>()
  for (const file of await bindingFiles(gen)) {
    for (const service of parseServices(await readFile(file, "utf8"), file)) onDisk.add(service.typeName)
  }
  const inTable = new Set(GENERATED_SERVICES.map((e) => (e.service as DescService).typeName))
  process.stderr.write(`[drift] ${onDisk.size} services in the bindings, ${inTable.size} in the generated table\n`)
  assert.ok(onDisk.size > 0, "no services parsed out of the bindings; the walk is broken, not the table")
  assert.deepEqual(
    [...onDisk].filter((name) => !inTable.has(name)).sort(),
    [],
    "these services exist in the bindings and have no tools; run `pnpm generate` and commit src/generated/tools.ts",
  )
  assert.deepEqual([...inTable].filter((name) => !onDisk.has(name)).sort(), [], "these services are in the table and no longer in the bindings")
})

test("pnpm generate is idempotent: a second run leaves the file byte for byte", async () => {
  const before = await readFile(generated, "utf8")
  await run(process.execPath, [join(pkg, "scripts", "generate-tools.ts")])
  const after = await readFile(generated, "utf8")
  assert.equal(after, before, "the generator is not deterministic; a rerun would show as CI drift")
})
