// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// @zeroroot-ai/gibson-mcp: the Gibson MCP server as a library. The bin is
// `gibson-mcp` (main.ts); a host adapter or a member driver embeds this.
export { buildSurface, type BuildDeps, type Surface } from "./build.js"
export { parseFlags, parseListen, usage, DEFAULT_LISTEN, DEFAULT_STREAM_LIMIT, type Flags, type Listen, type TransportKind } from "./flags.js"
export { serveHttp, type HttpHandle, type HttpSurface, type TurnRoute } from "./http.js"
export { createTurnController, dynamicTransport, TURN_GRANT_HEADER, type Turn, type TurnController } from "./turn.js"
export {
  openInbox,
  routeAnswers,
  inboxAvailable,
  toJobInput,
  principalName,
  InputKind,
  JobState,
  MIN_BACKOFF_MS,
  MAX_BACKOFF_MS,
  type Inbox,
  type JobInput,
  type AnswerSink,
} from "./inbox.js"
export { askTool, decisionFrom, AnswerRouter, type AnswerSource, type PermissionDecision } from "./ask.js"
export { attachServer, packageVersion, SERVER_NAME } from "./server.js"
export { ToolRegistry, type JsonSchema, type ToolContext, type ToolDefinition, type ToolGroup, type ToolHandler } from "./registry.js"
export { defineTool, jsonSchemaOf, type ToolSpec } from "./tool.js"
export { openGibson, type Gibson, type OpenGibsonOptions } from "./session.js"
export { rpcCatalog, rpcTools, driftBetween, snake, toolNameFor, transportFor, type Drift, type RpcChannels, type RpcEntry, type RpcToolOptions, type ServiceDoc } from "./rpc.js"
export {
  apiTools,
  closest,
  score,
  search,
  services,
  similarity,
  terms,
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  type ApiToolOptions,
  type SearchHit,
} from "./api.js"
export { messageSchema, requestSchema, MAX_DEPTH } from "./schema.js"
export { startDiscovery, toolKey, pluginKey, DISCOVERY_INTERVAL_MS, type Discovery, type DiscoveryOutcome } from "./discovery.js"
export { helperTools, helperToolsFor, helperContext, HELPER_TOOL_FOR_EXPORT, NOT_A_TOOL, TOOL_WITHOUT_EXPORT, type HelperContext } from "./helpers/index.js"
export { GENERATED_SERVICES, GENERATED_RPC_COUNT } from "./generated/tools.js"
export { decideSource, type CheckInSource, type SourceDecision, type SourceInputs } from "./source.js"
export { decideMode, type Mode, type ModeDecision } from "./mode.js"
export { loadSettings, readConfig, writeConfig, resolveSettings, DEFAULT_AGENT_NAME, type Settings, type ServerConfig } from "./config.js"
export { stateDir, readAmbient, readLive, writeAmbient, writeLive, clearLive, type LiveState } from "./state.js"
export { describeGibson } from "./tools/status.js"
export {
  ambientPrompt,
  ambientSource,
  resources,
  sessionCoordinates,
  AMBIENT_URI,
  SESSION_URI,
  DEFAULT_AMBIENT_QUERY,
  type AmbientSource,
  type PromptDefinition,
  type ResourceDefinition,
} from "./resources.js"
export { ambientBlock } from "./ambient.js"
export { text, failure, json } from "./tools/result.js"
