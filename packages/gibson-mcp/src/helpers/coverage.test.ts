// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import * as sdk from "@zeroroot-ai/sdk"
import { createRouterTransport } from "@connectrpc/connect"
import type { GibsonSession, LiveMission, TaskHarness } from "@zeroroot-ai/sdk"
import type { Gibson } from "../session.js"
import { helperToolsFor } from "./index.js"

/**
 * Which SDK export each helper tool comes from, and why the rest are not
 * tools.
 *
 * The MCP surface is 1:1 with everything the SDK produces (gibson#1706,
 * decision 2). The RPC half is generated, so it cannot fall behind. The
 * helper half is hand-signed, so this table is what keeps it honest: a guard
 * test lists the SDK's exports and fails when one is in neither map, which
 * means a new helper cannot land in the SDK without a decision here.
 *
 * A reason is required, not optional. "Not a tool" with no reason is how a
 * surface quietly loses half of itself.
 */

/** SDK export -> the tool built on it. Several exports may back one tool. */
const HELPER_TOOL_FOR_EXPORT: Record<string, string> = {
  buildComponentManifest: "componentize",
  callGibsonTool: "gibson_call_tool",
  cancelMission: "cancel_mission",
  createMission: "create_mission",
  createTaskMission: "create_task_mission",
  delegateToAgent: "delegate",
  enrollComponent: "enroll_component",
  findSimilarAttacks: "similar_attacks",
  findSimilarFindings: "similar_findings",
  getAttackChains: "attack_chains",
  getFindings: "get_findings",
  getMissionResults: "mission_results",
  getMissionStatus: "mission_status",
  getRelatedFindings: "related_findings",
  listAgents: "list_agents",
  listGibsonPlugins: "list_gibson_plugins",
  listGibsonTools: "list_gibson_tools",
  listMissions: "list_missions",
  newFinding: "submit_finding",
  observe: "observe",
  parseMaybeJSON: "parse_gibson_output",
  queryGibsonPlugin: "query_plugin",
  queryKnowledge: "recall",
  remember: "remember",
  runMission: "run_mission",
  submitFinding: "submit_finding",
  validateComponentSpec: "validate_component",
  waitMission: "wait_mission",
}

/** SDK export -> why it is not a tool. */
const NOT_A_TOOL: Record<string, string> = {
  // Check-in and identity. The source is decided at start and the server
  // never mints identity (ADR-0045), so no tool may reach these.
  CapabilityGrantClient: "the check-in client; the credential source is decided at start, never by a tool",
  connectGibson: "the check-in itself, done once at start",
  createGibsonClients: "builds the service clients at start",
  discover: "reads the platform discovery document at check-in",
  generateAgentKey: "key material; the server never mints identity (ADR-0045)",
  jwkThumbprint: "key material",
  loadOrGenerateHostKey: "key material",
  publicKeyJWK: "key material",
  signAgentJWT: "key material",
  signHostJWT: "key material",
  registerComponentAs: "registers the component at check-in, before any tool exists",
  registerInstance: "registers this process as one instance at check-in",
  startHeartbeat: "the check-in keeps its own registration alive",
  normalizePlatformURL: "canonicalizes the platform URL at check-in",

  // Transport and grant plumbing. Every tool call already rides these.
  callbackBaseUrl: "turns a dial target into a base URL at start",
  contextFromGrant: "derives ContextInfo from the grant; every tool call already carries it",
  decodeGrantClaims: "reads the addressing claims off the grant at start",
  grantInterceptor: "puts the current grant on every request",
  NoSandboxIdentityError: "the error of a process with no setec identity socket",
  openTaskHarness: "opens the callback transport at start",
  sandboxIdentityInterceptor: "puts a new setec identity token on every request",
  sandboxIdentityToken: "gets a new setec identity token for the interceptor",
  sandboxHarness: "opens a dispatched run's harness at start",

  // The fork contract (D74). A forked process claims its own dispatch at
  // start, before any tool runs. This server is never a fork source.
  ForkedError: "the error a fork gets in place of the result of the call",
  Watcher: "records the sandbox id at start to see a fork later",
  forkable: "reads the launch at start",
  isForkUnclaimed: "recognizes a refusal of the daemon",
  park: "the wait of a fork source after its result",
  parkTimeout: "reads the launch at start",
  point: "checks for a fork after a call",
  sandboxId: "reads the hostname of the sandbox",
  dispatchEnvFromClaim: "the launch of a fork, read at start",
  parkAfterResult: "the end of a forkable run; this server is never one",
  sessionHarness: "the component-grant harness, chosen at start",
  readSandboxDispatch: "reads the dispatch contract off the environment at start",
  taskFromB64: "decodes the dispatched task at start",
  taskKnowledge: "chooses which grant recall reads over",
  componentKnowledge: "chooses which grant recall reads over",

  // The session mission is started by the check-in, not by a tool
  // (ADR-0157: one live mission per session).
  componentOriginator: "who creates the session mission; decided at check-in",
  liveMissionDefinition: "the definition the session mission is created from at start",
  startLiveMission: "starts the session mission at check-in",

  // Serving work. This server is a client of the platform, not a worker.
  startWorker: "a served tool's own poll loop; this server serves no work",
  startAgentWorker: "a served agent's own poll loop; this server serves no work",
  decodeAgentExecute: "decodes a work payload inside a worker loop",
  decodeToolInput: "decodes a work payload inside a worker loop",
  encodeAgentError: "encodes a worker's result",
  encodeAgentResult: "encodes a worker's result",
  encodeToolError: "encodes a worker's result",
  encodeToolOutput: "encodes a worker's result",

  // The model stays on the host's own provider (ADR-0157). The LLM shim is
  // the opencode adapter's business and never a tool.
  startCompletionsShim: "the local OpenAI-compatible shim; a host adapter starts it, and the model never routes through this server",

  // Encoding and formatting the tools already do for the caller.
  calculateRiskScore: "arithmetic on a severity and a confidence; no round trip is worth it",
  decodeJSONBytes: "byte decoding inside other helpers",
  decodeProperties: "decodes a graph property bag inside recall",
  decodeValue: "decodes one graph value inside recall",
  encodeFinding: "submit_finding encodes the finding for you",
  formatKnowledgeForPrompt: "recall already formats its own hits",
  validateFinding: "submit_finding validates before it submits",
  newTask: "builds delegate's argument",
  buildCreateMissionRequest: "shapes the request create_task_mission sends",
  isSeamUnavailable: "classifies a daemon error inside other helpers",
  seamReason: "reads the daemon's own explanation inside other helpers",
}

/**
 * Tools with no single SDK export behind them, and where they come from.
 * The guard walks this direction too, so a tool cannot appear with no
 * account of itself.
 */
const TOOL_WITHOUT_EXPORT: Record<string, string> = {
  world_view: "HarnessCallbackService.WorldView through the task harness, formatted for reading",
  run_history: "KnowledgeSource.runHistory, which is an interface method rather than a free function",
  application_findings: "KnowledgeSource.applicationFindings, which is an interface method rather than a free function",
  gibson_status: "the server's own posture, which is not an SDK concept",
  gibson_login: "the gibson CLI device flow",
  gibson_connect: "the gibson CLI enrollment and the check-in, driven in the session",
}

/**
 * The guard that keeps the helper half of the 1:1 surface honest. The RPC
 * half is generated and cannot fall behind; a helper is hand-signed, so a
 * new SDK export has to be decided about here before it can land.
 */
function sdkFunctionExports(): string[] {
  return Object.entries(sdk)
    .filter(([, v]) => typeof v === "function")
    .map(([k]) => k)
    .sort()
}

function fakeHarness(): TaskHarness {
  return {
    transport: createRouterTransport(() => {}),
    client: {} as never,
    endpoint: "d:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "gibson-mcp" },
    token: () => "tok",
    expiresAt: () => 0,
    stop: () => {},
  }
}

function fakeSession(): GibsonSession {
  return {
    transport: createRouterTransport(() => {}),
    clients: { component: {}, harness: {} } as never,
    componentScope: "scope-1",
    instance: { current: () => "i", heartbeatIntervalMs: () => 1000, renew: async () => "i" },
    instanceId: "i",
    stop: () => {},
  }
}

function gibson(parts: Partial<Gibson>): Gibson {
  return {
    source: "enrolled",
    mode: "live",
    reason: "",
    agentName: "gibson-mcp",
    hostKeyPath: "/tmp/host.key",
    settings: { callbackInsecure: false, hostKeyPath: "/tmp/host.key", agentName: "gibson-mcp" },
    close: async () => {},
    ...parts,
  }
}

const live = (): LiveMission => ({ missionId: "m-1", workId: "w-1", harness: fakeHarness(), end: async () => {} })

/** The widest posture: checked in, with a live mission. */
function everyHelperTool(): string[] {
  const session = fakeSession()
  const g = gibson({ session, live: live(), knowledge: sdk.taskKnowledge(fakeHarness()) })
  return helperToolsFor(g, "/tmp", {}).map((t) => t.name).sort()
}

test("every SDK function export is either a tool or on the list, with a reason", () => {
  const missing: string[] = []
  for (const name of sdkFunctionExports()) {
    if (HELPER_TOOL_FOR_EXPORT[name] || NOT_A_TOOL[name]) continue
    missing.push(name)
  }
  assert.deepEqual(
    missing,
    [],
    "these SDK exports are neither a tool nor on the notATool list; add them to src/helpers/coverage.ts with a tool or a reason",
  )
})

test("no export is in both maps, and every reason says something", () => {
  for (const name of Object.keys(HELPER_TOOL_FOR_EXPORT)) {
    assert.equal(NOT_A_TOOL[name], undefined, `${name} is both a tool and not a tool`)
  }
  for (const [name, reason] of Object.entries(NOT_A_TOOL)) {
    assert.ok(reason.trim().length > 10, `${name} needs a real reason, not "${reason}"`)
  }
})

test("both maps name real SDK exports, so a rename cannot leave a stale entry", () => {
  const exports = new Set(sdkFunctionExports())
  for (const name of [...Object.keys(HELPER_TOOL_FOR_EXPORT), ...Object.keys(NOT_A_TOOL)]) {
    assert.ok(exports.has(name), `${name} is in the coverage table but the SDK no longer exports it`)
  }
})

test("every tool the table promises is actually registered in the widest posture", () => {
  const registered = new Set(everyHelperTool())
  const promised = new Set(Object.values(HELPER_TOOL_FOR_EXPORT))
  process.stderr.write(`[helpers] ${registered.size} helper tools from ${promised.size} named by the coverage table\n`)
  for (const name of promised) {
    assert.ok(registered.has(name), `the table names ${name} but no posture registers it`)
  }
})

test("every registered helper tool traces back to an export or is accounted for", () => {
  const promised = new Set(Object.values(HELPER_TOOL_FOR_EXPORT))
  for (const name of everyHelperTool()) {
    if (promised.has(name)) continue
    assert.ok(TOOL_WITHOUT_EXPORT[name], `${name} is registered but nothing accounts for it; add it to TOOL_WITHOUT_EXPORT with where it comes from`)
  }
})

test("a posture registers only the helpers its grant can reach", () => {
  const standalone = helperToolsFor(gibson({ mode: "standalone" }), "/tmp", {}).map((t) => t.name).sort()
  // With no platform a finding still has somewhere to go, and componentize
  // needs nothing but a disk.
  assert.deepEqual(standalone, ["componentize", "submit_finding", "validate_component"])

  const dispatched = helperToolsFor(
    gibson({ source: "dispatched", mode: "task", live: live(), knowledge: sdk.taskKnowledge(fakeHarness()) }),
    "/tmp",
    {},
  ).map((t) => t.name)
  assert.ok(dispatched.includes("remember"), "a dispatched run holds a mission, so it can write memories")
  assert.ok(dispatched.includes("world_view"))
  assert.ok(!dispatched.includes("delegate"), "delegation is a ComponentService call and a dispatched run has no component client")
  assert.ok(!dispatched.includes("enroll_component"))
})
