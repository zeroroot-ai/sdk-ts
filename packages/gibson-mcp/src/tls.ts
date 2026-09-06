// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { readFile } from "node:fs/promises"
import tls from "node:tls"

/**
 * Trust a private CA for every TLS client in this process, at runtime.
 *
 * A self-hosted Gibson (kind, on-prem) fronts its edge with its own CA. Node
 * reads NODE_EXTRA_CA_CERTS only at start, and the connect happens mid-session,
 * so the CA is added through `tls.setDefaultCACertificates` (Node 22.15+).
 * Both `fetch` (the Capability Grant register call) and the gRPC transports
 * use the default CA set, so one call covers all of them.
 */
const trusted = new Set<string>()

export async function trustCA(path: string): Promise<void> {
  if (trusted.has(path)) return
  const pem = await readFile(path, "utf8")
  tls.setDefaultCACertificates([...tls.getCACertificates("default"), pem])
  trusted.add(path)
}
