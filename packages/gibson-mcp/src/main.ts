#!/usr/bin/env node
// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { buildSurface } from "./build.js"
import { parseFlags, usage, type Flags } from "./flags.js"
import { serveHttp } from "./http.js"
import { log, TAG } from "./log.js"
import { packageVersion } from "./server.js"
import { describeGibson } from "./tools/status.js"

/**
 * The bin. This file runs main() unconditionally: npm installs bins as
 * symlinks named after the bin (`gibson-mcp`), so any "am I the entry point"
 * check on argv[1] is false there and the process would exit before it
 * serves anything. Library code lives in build.ts.
 */
async function main(): Promise<void> {
  let flags: Flags
  try {
    flags = parseFlags(process.argv.slice(2))
  } catch (e) {
    process.stderr.write(`${TAG} ${(e as Error).message}\n\n${usage()}\n`)
    process.exit(2)
  }
  if (flags.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  if (flags.version) {
    process.stdout.write(`${packageVersion()}\n`)
    return
  }

  const cwd = process.cwd()
  const surface = await buildSurface(process.env, cwd, { streamLimit: flags.streamLimit, ...(flags.exposeAllRpcs ? { exposeAllRpcs: true } : {}) })
  log(`${TAG} ${describeGibson(surface.current()).replaceAll("\n", "; ")}`)
  log(`${TAG} ${surface.registry.size()} tool(s) registered`)

  let closing = false
  const close = async (extra?: () => Promise<void>): Promise<void> => {
    if (closing) return
    closing = true
    if (extra) await extra().catch((e: Error) => log(`${TAG} close: ${e.message}`))
    await surface.close().catch((e: Error) => log(`${TAG} close: ${e.message}`))
  }

  if (flags.transport === "stdio") {
    // The host ends the session by closing stdio. The mission ends with it.
    process.stdin.on("close", () => void close().finally(() => process.exit(0)))
    for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void close().finally(() => process.exit(0)))
    await surface.attach(new StdioServerTransport())
    return
  }

  const http = await serveHttp(surface, flags.listen, log)
  log(`${TAG} listening on ${http.url}${surface.turn ? `; POST ${http.url.replace(/\/mcp$/, "/turn")} sets the per-turn grant` : ""}`)
  for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void close(http.close).finally(() => process.exit(0)))
}

main().catch((e: Error) => {
  log(`${TAG} fatal: ${e.message}`)
  process.exit(1)
})
