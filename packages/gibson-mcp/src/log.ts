// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/** The server logs to stderr only: stdout is the stdio MCP channel. */
export const TAG = "[gibson-mcp]"

export type Log = (line: string) => void

export const log: Log = (line) => {
  process.stderr.write(`${line}\n`)
}
