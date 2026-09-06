// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import { decideSource } from "./source.js"

test("the dispatched grant wins, and the host key and the token are ignored and logged", () => {
  const d = decideSource({ grant: "jwt", callbackEndpoint: "d:50001", bootstrapToken: "once", hostKeyExists: true })
  assert.equal(d.source, "dispatched")
  assert.equal(d.notes.length, 2)
  assert.ok(d.notes.some((n) => /host key is ignored/.test(n)))
  assert.ok(d.notes.some((n) => /token is ignored/.test(n)))
})

test("half a dispatch is no dispatch, and says which half is missing", () => {
  const noEndpoint = decideSource({ grant: "jwt", hostKeyExists: false })
  assert.equal(noEndpoint.source, "none")
  assert.match(noEndpoint.notes.join(" "), /GIBSON_CG_JWT is set without GIBSON_CALLBACK_ENDPOINT/)
  const noGrant = decideSource({ callbackEndpoint: "d:50001", hostKeyExists: false })
  assert.equal(noGrant.source, "none")
  assert.match(noGrant.notes.join(" "), /GIBSON_CALLBACK_ENDPOINT is set without GIBSON_CG_JWT/)
})

test("a bootstrap token is used only when this host has no key", () => {
  assert.equal(decideSource({ bootstrapToken: "once", hostKeyExists: false }).source, "bootstrap")
  const enrolled = decideSource({ bootstrapToken: "once", hostKeyExists: true })
  assert.equal(enrolled.source, "enrolled")
  assert.match(enrolled.notes.join(" "), /cannot be replayed/)
})

test("nothing present is `none`: the server offers the device flow", () => {
  const d = decideSource({ hostKeyExists: false })
  assert.equal(d.source, "none")
  assert.deepEqual(d.notes, [])
})
