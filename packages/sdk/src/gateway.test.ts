// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import test from "node:test"

import { checkGatewayUrl, gatewayFetch, parseCaBundle, staticGrantHeaders } from "./gateway.js"
import { makeTestCa, startTlsServer } from "./tls-fixture.test.js"

test("checkGatewayUrl refuses plain http when a bundle is set", () => {
  checkGatewayUrl("http://x", "")
  checkGatewayUrl("http://x", undefined)
  checkGatewayUrl("https://x", "PEM")
  assert.throws(() => checkGatewayUrl("http://x", "PEM"), /https/)
})

test("parseCaBundle refuses a bundle with no certificate", () => {
  assert.throws(() => parseCaBundle("not pem"), /no certificate/)
  assert.throws(
    () => parseCaBundle("-----BEGIN CERTIFICATE-----\nAAAA\n-----END CERTIFICATE-----"),
    /not a certificate/,
  )
})

test("gatewayFetch trusts exactly the bundle and adds the headers", async () => {
  const ca = makeTestCa()
  const other = makeTestCa("other-ca")
  const seen: { headers: Record<string, unknown>; path: string }[] = []
  const gw = await startTlsServer(ca, (req, res) => {
    seen.push({ headers: req.headers, path: req.url ?? "" })
    res.setHeader("content-type", "application/json")
    res.end('{"ok":true}')
  })
  try {
    const f = gatewayFetch({
      baseUrl: gw.url,
      caPem: ca.caPem,
      fixedHeaders: { "x-fixed": "1" },
      headers: (route) => ({ "x-capability-grant": `g:${route}` }),
    })
    const res = await f(`${gw.url}/a2a/helper`, { method: "POST", body: "{}" })
    assert.deepEqual(await res.json(), { ok: true })
    assert.equal(seen[0]?.headers["x-fixed"], "1")
    assert.equal(seen[0]?.headers["x-capability-grant"], "g:/a2a/helper")
    assert.equal(seen[0]?.path, "/a2a/helper")

    // No bundle: the system roots do not trust the test CA.
    await assert.rejects(gatewayFetch({ baseUrl: gw.url })(`${gw.url}/x`))
    // Another bundle: the call fails.
    await assert.rejects(gatewayFetch({ baseUrl: gw.url, caPem: other.caPem })(`${gw.url}/x`))
  } finally {
    await gw.close()
    ca.cleanup()
    other.cleanup()
  }
})

test("gatewayFetch refuses an http URL when a bundle is set", async () => {
  const ca = makeTestCa()
  try {
    assert.throws(() => gatewayFetch({ baseUrl: "http://gateway.example", caPem: ca.caPem }), /https/)
    const f = gatewayFetch({ baseUrl: "https://gateway.example", caPem: ca.caPem })
    await assert.rejects(f("http://gateway.example/x"), /https/)
  } finally {
    ca.cleanup()
  }
})

test("gatewayFetch with no bundle sends the headers over plain http and does not follow a redirect", async () => {
  const server = createServer((req, res) => {
    if (req.url === "/redirect") {
      res.writeHead(302, { location: "http://127.0.0.1:1/elsewhere" })
      res.end()
      return
    }
    res.end(String(req.headers["x-capability-grant"]))
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const f = gatewayFetch({ baseUrl: url, headers: staticGrantHeaders(() => "tok") })
    assert.equal(await (await f(`${url}/x`)).text(), "tok")
    const redirected = await f(`${url}/redirect`)
    assert.equal(redirected.status, 302)
  } finally {
    server.close()
  }
})

test("parseCaBundle reads each certificate of a bundle, and a long run of begin lines is fast", () => {
  const ca = makeTestCa()
  const other = makeTestCa("other-ca")
  try {
    assert.equal(parseCaBundle(`${ca.caPem}\n${other.caPem}`).length, 2)
    const hostile = "-----BEGIN CERTIFICATE-----\n".repeat(50_000)
    const t0 = Date.now()
    assert.throws(() => parseCaBundle(hostile), /no certificate/)
    assert.ok(Date.now() - t0 < 2_000, "the scan is linear")
  } finally {
    ca.cleanup()
    other.cleanup()
  }
})
