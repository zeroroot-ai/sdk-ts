// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { execFileSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import type { RequestListener } from "node:http"
import { createServer as createHttpsServer, type Server } from "node:https"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

/**
 * Test helper: a private CA and a TLS server that it signs.
 *
 * The helper makes the keys with the `openssl` program at test time, so no
 * private key is kept in the repository. The CA and the server live for one
 * day. The server certificate names `localhost` and `127.0.0.1`.
 */

export interface TestCa {
  /** The PEM of the CA certificate. A client trusts exactly this. */
  caPem: string
  /** Make a server certificate that this CA signs. */
  issue(): { key: string; cert: string }
  cleanup(): void
}

function openssl(dir: string, ...args: string[]): void {
  execFileSync("openssl", args, { cwd: dir, stdio: "pipe" })
}

/** Make a CA. It throws when the `openssl` program is not installed. */
export function makeTestCa(name = "test-ca"): TestCa {
  const dir = mkdtempSync(join(tmpdir(), "sdk-ts-ca-"))
  openssl(
    dir, "req", "-x509", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
    "-keyout", "ca.key", "-out", "ca.pem", "-days", "1", "-subj", `/CN=${name}`,
    "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign",
  )
  writeFileSync(join(dir, "ext.cnf"), "subjectAltName=DNS:localhost,IP:127.0.0.1\n")
  return {
    caPem: readFileSync(join(dir, "ca.pem"), "utf8"),
    issue() {
      openssl(
        dir, "req", "-newkey", "ec", "-pkeyopt", "ec_paramgen_curve:prime256v1", "-nodes",
        "-keyout", "srv.key", "-out", "srv.csr", "-subj", "/CN=localhost",
      )
      openssl(
        dir, "x509", "-req", "-in", "srv.csr", "-CA", "ca.pem", "-CAkey", "ca.key", "-CAcreateserial",
        "-out", "srv.pem", "-days", "1", "-extfile", "ext.cnf",
      )
      return { key: readFileSync(join(dir, "srv.key"), "utf8"), cert: readFileSync(join(dir, "srv.pem"), "utf8") }
    },
    cleanup() {
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Start a TLS server that a CA signs. `url` uses the host `localhost`. */
export async function startTlsServer(
  ca: TestCa,
  handler: RequestListener,
): Promise<{ url: string; server: Server; close(): Promise<void> }> {
  const server = createHttpsServer(ca.issue(), handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const port = (server.address() as AddressInfo).port
  return {
    url: `https://localhost:${port}`,
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections()
        server.close(() => resolve())
      }),
  }
}
