// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { parseArgs } from "node:util"

/**
 * The bin's flags.
 *
 *  - `--transport stdio` (default): the laptop path. The host spawns the
 *    server and talks over stdin and stdout.
 *  - `--transport http --listen 127.0.0.1:<port>`: the sandbox path. The
 *    member driver runs one server for the life of the sandbox and swaps
 *    the grant per turn through it (slice A4). Only a loopback address is
 *    accepted: a control endpoint that swaps credentials never sits on a
 *    network interface.
 *  - `--stream-limit <n>`: how many messages a server-streaming RPC tool
 *    collects before it returns with `truncated: true` (slice A2).
 *  - `--expose-all-rpcs`: put the generated RPC tools in `tools/list` as
 *    well, which is what the server did before sdk-ts#70. Off by default:
 *    188 descriptions on every turn bury the tools an agent reaches for, and
 *    some hosts cap the tool count. They are always reachable through
 *    `gibson_api_search` and `gibson_api_call`, flag or no flag.
 */
export type TransportKind = "stdio" | "http"

export interface Listen {
  host: string
  port: number
}

export interface Flags {
  transport: TransportKind
  listen: Listen
  streamLimit: number
  /** Register the generated RPC tools in `tools/list` as well. */
  exposeAllRpcs: boolean
  help: boolean
  version: boolean
}

export const DEFAULT_LISTEN = "127.0.0.1:7788"
export const DEFAULT_STREAM_LIMIT = 500

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "localhost"])

export function isLoopback(host: string): boolean {
  return LOOPBACK_HOSTS.has(host) || host.startsWith("127.")
}

/** `host:port`, `[v6]:port`, or a bare port on 127.0.0.1. */
export function parseListen(raw: string): Listen {
  const s = raw.trim()
  let host: string
  let portText: string
  const v6 = /^\[([^\]]+)\]:(\d+)$/.exec(s)
  if (v6) {
    host = v6[1]!
    portText = v6[2]!
  } else if (/^\d+$/.test(s)) {
    host = "127.0.0.1"
    portText = s
  } else {
    const i = s.lastIndexOf(":")
    if (i <= 0) throw new Error(`--listen ${JSON.stringify(raw)} is not host:port`)
    host = s.slice(0, i)
    portText = s.slice(i + 1)
  }
  const port = Number(portText)
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--listen ${JSON.stringify(raw)} has no valid port`)
  if (!isLoopback(host)) {
    throw new Error(`--listen ${JSON.stringify(raw)} is not a loopback address; the HTTP transport serves localhost only`)
  }
  return { host, port }
}

export function parseFlags(argv: string[]): Flags {
  const { values } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: false,
    options: {
      transport: { type: "string", default: "stdio" },
      listen: { type: "string", default: DEFAULT_LISTEN },
      "stream-limit": { type: "string", default: String(DEFAULT_STREAM_LIMIT) },
      "expose-all-rpcs": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
      version: { type: "boolean", default: false },
    },
  })
  const transport = values.transport
  if (transport !== "stdio" && transport !== "http") {
    throw new Error(`--transport must be stdio or http, got ${JSON.stringify(transport)}`)
  }
  const streamLimit = Number(values["stream-limit"])
  if (!Number.isInteger(streamLimit) || streamLimit < 1) {
    throw new Error(`--stream-limit must be a positive integer, got ${JSON.stringify(values["stream-limit"])}`)
  }
  return {
    transport,
    listen: parseListen(values.listen),
    streamLimit,
    exposeAllRpcs: values["expose-all-rpcs"],
    help: values.help,
    version: values.version,
  }
}

export function usage(): string {
  return [
    "gibson-mcp: the Gibson MCP server.",
    "",
    "  gibson-mcp [--transport stdio]",
    `  gibson-mcp --transport http [--listen ${DEFAULT_LISTEN}]`,
    "",
    "Flags:",
    "  --transport stdio|http   stdio (default) for a host that spawns the server; http for a sandbox.",
    `  --listen host:port       loopback address for the HTTP transport (default ${DEFAULT_LISTEN}).`,
    `  --stream-limit n         messages a streaming RPC tool returns before it truncates (default ${DEFAULT_STREAM_LIMIT}).`,
    "  --expose-all-rpcs        also list every generated RPC tool in tools/list. Off by default: they are",
    "                           reachable through gibson_api_search and gibson_api_call either way.",
    "  --version                print the package version.",
    "  -h, --help               this text.",
    "",
    "Check-in source, decided from the environment, never mixed:",
    "  GIBSON_CG_JWT + GIBSON_CALLBACK_ENDPOINT   dispatched: the daemon launched this process.",
    "  GIBSON_BOOTSTRAP_TOKEN (no host key yet)   pre-minted token: first check-in, host key thereafter.",
    "  otherwise                                  enrolled: host key, or gibson_login then gibson_connect.",
  ].join("\n")
}
