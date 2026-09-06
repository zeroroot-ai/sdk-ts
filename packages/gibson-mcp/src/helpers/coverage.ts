// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

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
export const HELPER_TOOL_FOR_EXPORT: Record<string, string> = {
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
export const NOT_A_TOOL: Record<string, string> = {
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
  registerAgent: "registers the component at check-in, before any tool exists",
  registerComponentAs: "registers the component at check-in, before any tool exists",
  registerInstance: "registers this process as one instance at check-in",
  startHeartbeat: "the check-in keeps its own registration alive",
  normalizePlatformURL: "canonicalizes the platform URL at check-in",

  // Transport and grant plumbing. Every tool call already rides these.
  callbackBaseUrl: "turns a dial target into a base URL at start",
  contextFromGrant: "derives ContextInfo from the grant; every tool call already carries it",
  decodeGrantClaims: "reads the addressing claims off the grant at start",
  grantInterceptor: "puts the current grant on every request",
  openTaskHarness: "opens the callback transport at start",
  sandboxHarness: "opens a dispatched run's harness at start",
  sessionHarness: "the component-grant harness, chosen at start",
  readSandboxDispatch: "reads the dispatch contract off the environment at start",
  taskFromB64: "decodes the dispatched task at start",
  taskKnowledge: "chooses which grant recall reads over",
  componentKnowledge: "chooses which grant recall reads over",

  // The session mission is started by the check-in, not by a tool
  // (ADR-0007 decision 3: one live mission per session).
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

  // The model stays on the host's own provider (ADR-0007). The LLM shim is
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
  enrollmentSupported: "a fixed explanation, printed in enroll_component's answer",
  isSeamUnavailable: "classifies a daemon error inside other helpers",
  seamReason: "reads the daemon's own explanation inside other helpers",
}

/**
 * Tools with no single SDK export behind them, and where they come from.
 * The guard walks this direction too, so a tool cannot appear with no
 * account of itself.
 */
export const TOOL_WITHOUT_EXPORT: Record<string, string> = {
  world_view: "HarnessCallbackService.WorldView through the task harness, formatted for reading",
  run_history: "KnowledgeSource.runHistory, which is an interface method rather than a free function",
  application_findings: "KnowledgeSource.applicationFindings, which is an interface method rather than a free function",
  gibson_status: "the server's own posture, which is not an SDK concept",
  gibson_login: "the gibson CLI device flow",
  gibson_connect: "the gibson CLI enrollment and the check-in, driven in the session",
}
