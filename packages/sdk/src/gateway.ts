// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { X509Certificate } from "node:crypto"
import http from "node:http"
import https from "node:https"
import { Readable } from "node:stream"

/**
 * The HTTP rules for a call to a Gibson gateway.
 *
 * The model client and the A2A delegation client share them. The gateway
 * serves TLS with a private CA, and a sandbox has no bundle for it. The daemon
 * sends the bundle as PEM. The client trusts exactly that bundle. When the
 * daemon sends none, the client uses the system roots. There is no option to
 * skip verification.
 */

/**
 * Return the headers to add to a call. The route is the path of the request
 * URL. The agent uses this to send its grant in the header `x-capability-grant`.
 */
export type HeaderFunc = (route: string) => Record<string, string> | Promise<Record<string, string>>

/** The header that carries the grant on a call to a gateway. */
export const GATEWAY_GRANT_HEADER = "x-capability-grant"

/** The error of a gateway call with no task grant. The call fails before it is sent. */
export class NoGatewayGrantError extends Error {
  constructor() {
    super("no task grant: the agent has no task grant to send to the gateway")
    this.name = "NoGatewayGrantError"
  }
}

/** Send the same grant on each call. The task grant of a callback agent works this way. */
export function staticGrantHeaders(token: () => string): HeaderFunc {
  return () => ({ [GATEWAY_GRANT_HEADER]: token() })
}

/**
 * Refuse a plain http URL when a CA bundle is set. The bundle only makes sense
 * for TLS, and the client does not send a grant in the clear.
 */
export function checkGatewayUrl(baseUrl: string, caPem: string | undefined): void {
  if (caPem && !baseUrl.startsWith("https://")) {
    throw new Error("gibson-sdk: a gateway client with a CA bundle needs an https URL")
  }
}

const PEM_BEGIN = "-----BEGIN CERTIFICATE-----"
const PEM_END = "-----END CERTIFICATE-----"

/**
 * Split a PEM bundle into its certificates. It throws when the bundle holds no
 * certificate, or when one block is not a certificate. The scan is linear. A
 * bundle comes from the daemon, and a regular expression on it could run slow.
 */
export function parseCaBundle(caPem: string): string[] {
  const blocks: string[] = []
  let from = 0
  for (;;) {
    const start = caPem.indexOf(PEM_BEGIN, from)
    if (start < 0) break
    const end = caPem.indexOf(PEM_END, start + PEM_BEGIN.length)
    if (end < 0) break
    blocks.push(caPem.slice(start, end + PEM_END.length))
    from = end + PEM_END.length
  }
  if (blocks.length === 0) {
    throw new Error("gibson-sdk: the CA bundle of the gateway holds no certificate")
  }
  for (const block of blocks) {
    try {
      new X509Certificate(block)
    } catch (cause) {
      throw new Error("gibson-sdk: the CA bundle of the gateway holds a block that is not a certificate", { cause })
    }
  }
  return blocks
}

export interface GatewayFetchOptions {
  /** The gateway URL. It decides the scheme rule when a bundle is set. */
  baseUrl: string
  /** The PEM bundle that the daemon sent. Empty means the system roots. */
  caPem?: string
  /** Sent unchanged on each call. The route of the gateway matches on them. */
  fixedHeaders?: Record<string, string>
  /** Adds the headers of each call, for example the grant. */
  headers?: HeaderFunc
}

/**
 * Make a `fetch` function for one gateway.
 *
 * With a bundle, the function sends each call through a dedicated `https.Agent`
 * that has `ca` set to exactly that bundle. Node then trusts no other root for
 * this gateway. With no bundle, the function uses the system roots. It adds the
 * fixed headers and the headers of the {@link HeaderFunc} to each request. It
 * does not follow a redirect, because a redirect could carry the grant to
 * another host.
 */
export function gatewayFetch(opts: GatewayFetchOptions): typeof fetch {
  checkGatewayUrl(opts.baseUrl, opts.caPem)
  const ca = opts.caPem ? parseCaBundle(opts.caPem) : undefined
  const agent = ca ? new https.Agent({ ca, minVersion: "TLSv1.2" }) : undefined

  return async (input, init) => {
    const request = new Request(input, init)
    const url = new URL(request.url)
    if (ca && url.protocol !== "https:") {
      throw new Error("gibson-sdk: a gateway client with a CA bundle needs an https URL")
    }
    const headers = new Headers(request.headers)
    for (const [k, v] of Object.entries(opts.fixedHeaders ?? {})) headers.set(k, v)
    if (opts.headers) {
      for (const [k, v] of Object.entries(await opts.headers(url.pathname))) headers.set(k, v)
    }
    const body = request.body ? Buffer.from(await request.arrayBuffer()) : undefined
    return await send(url, request.method, headers, body, request.signal, agent)
  }
}

function send(
  url: URL,
  method: string,
  headers: Headers,
  body: Buffer | undefined,
  signal: AbortSignal,
  agent: https.Agent | undefined,
): Promise<Response> {
  return new Promise<Response>((resolve, reject) => {
    const outgoing: Record<string, string> = {}
    headers.forEach((v, k) => {
      outgoing[k] = v
    })
    if (body) outgoing["content-length"] = String(body.length)
    const lib = url.protocol === "https:" ? https : http
    const req = lib.request(url, { method, headers: outgoing, ...(agent ? { agent } : {}), signal }, (res) => {
      const responseHeaders = new Headers()
      for (const [k, v] of Object.entries(res.headers)) {
        if (Array.isArray(v)) for (const item of v) responseHeaders.append(k, item)
        else if (v !== undefined) responseHeaders.set(k, v)
      }
      const status = res.statusCode ?? 0
      const noBody = status === 204 || status === 205 || status === 304
      resolve(
        new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>), {
          status,
          statusText: res.statusMessage ?? "",
          headers: responseHeaders,
        }),
      )
    })
    req.on("error", reject)
    req.end(body)
  })
}
