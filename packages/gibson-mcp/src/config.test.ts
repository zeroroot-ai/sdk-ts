// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import { mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { cliCredentials, loadSettings, readConfig, resolveSettings, writeConfig } from "./config.js"

test("settings precedence: environment, then plugin config, then the CLI login session", () => {
  const creds = { gibsonURL: "https://from-cli", tenant: "primary", caCertPath: "/ca.crt" }
  const cfg = { platformURL: "https://from-config", targetId: "tgt-cfg" }
  const s = resolveSettings({ GIBSON_PLATFORM_URL: "https://from-env" }, cfg, creds)
  assert.equal(s.platformURL, "https://from-env")
  assert.equal(s.targetId, "tgt-cfg")
  assert.equal(s.caCertPath, "/ca.crt", "the CA falls through to the CLI session")
  assert.equal(s.tenant, "primary")
  const t = resolveSettings({}, {}, creds)
  assert.equal(t.platformURL, "https://from-cli")
  assert.equal(t.targetId, undefined)
})

test("the CLI credentials file yields addressing fields only", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gm-cfg-"))
  const path = join(dir, "credentials")
  await writeFile(path, JSON.stringify({ gibson_url: "https://api.x", active_tenant: "t1", ca_cert_path: "/x/ca.crt", access_token: "SECRET" }))
  const c = await cliCredentials({ GIBSON_CLI_CREDENTIALS: path })
  assert.deepEqual(c, { gibsonURL: "https://api.x", tenant: "t1", caCertPath: "/x/ca.crt" })
  assert.equal(await cliCredentials({ GIBSON_CLI_CREDENTIALS: join(dir, "missing") }), undefined)
})

test("writeConfig merges and loadSettings reads it back", async () => {
  const dir = await mkdtemp(join(tmpdir(), "gm-cfg-"))
  const env = { ZEROCOOL_STATE_DIR: dir, GIBSON_CLI_CREDENTIALS: join(dir, "none") }
  await writeConfig(env, { platformURL: "https://p" })
  await writeConfig(env, { targetId: "tgt" })
  assert.deepEqual(await readConfig(env), { platformURL: "https://p", targetId: "tgt" })
  const s = await loadSettings(env)
  assert.equal(s.platformURL, "https://p")
  assert.equal(s.targetId, "tgt")
})
