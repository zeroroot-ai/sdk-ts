// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { Transport as ConnectTransport } from "@connectrpc/connect"
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js"
import { loadSettings } from "./config.js"
import { DEFAULT_STREAM_LIMIT } from "./flags.js"
import { log, TAG } from "./log.js"
import { ToolRegistry, type ToolDefinition, type ToolGroup } from "./registry.js"
import type { TurnRoute } from "./http.js"
import { attachServer } from "./server.js"
import { AnswerRouter, askTool } from "./ask.js"
import { startDiscovery, type Discovery } from "./discovery.js"
import { inboxAvailable, openInbox, routeAnswers, type Inbox } from "./inbox.js"
import { helperToolsFor } from "./helpers/index.js"
import { apiTools } from "./api.js"
import { rpcCatalog, type RpcChannels, type RpcEntry } from "./rpc.js"
import { createTurnController, TURN_GRANT_HEADER, type TurnController } from "./turn.js"
import { ambientPrompt, ambientSource, resources, type AmbientSource } from "./resources.js"
import { openGibson, type Gibson } from "./session.js"
import { clearLive, stateDir, writeAmbient, writeLive } from "./state.js"
import { connectTool, loginTool, type ConnectDeps } from "./tools/connect.js"
import { statusTool } from "./tools/status.js"

/**
 * @zeroroot-ai/gibson-mcp: the one MCP server every coding agent host loads
 * (gibson#1706, decisions 1 to 4). It exposes what the SDK produces and adds
 * Gibson to the session: one live mission per session (ADR-0007 decision 3),
 * memory and knowledge, findings, tools, delegation. It never routes LLM
 * traffic and never reads a model provider key.
 *
 * The surface is one tool registry that every attached protocol server
 * reads. `upgrade` swaps the connection (after `gibson_connect`) and
 * re-registers the posture's tools, and every attached session hears
 * `tools/list_changed`.
 */
export interface BuildDeps extends ConnectDeps {
  streamLimit?: number
  /** Register the generated RPC tools in `tools/list` as well. Default off. */
  exposeAllRpcs?: boolean
  /** How often to look for newly checked-in platform tools. `0` runs one pass. */
  discoveryIntervalMs?: number
}

export interface Surface {
  registry: ToolRegistry
  /** The current connection. Changes on gibson_connect. */
  current(): Gibson
  /** Replace the connection and re-register the posture's tools. */
  upgrade(next: Gibson): Promise<void>
  /** Bind a new protocol server to a transport. */
  attach(transport: Transport): Promise<Server>
  /** Small JSON for /healthz. */
  health(): Record<string, unknown>
  /**
   * The per-turn grant control, when this posture holds a task grant. The
   * HTTP transport serves it at `/turn`; the stdio transport does not expose
   * it, because a host that spawns one process per session has one grant.
   */
  turn?: TurnRoute
  /** The member inbox, when this posture holds a task grant. */
  inbox?: Inbox
  /** End the mission, stop the heartbeat, drop the state file. Idempotent. */
  close(): Promise<void>
}

export async function buildSurface(env: NodeJS.ProcessEnv, cwd: string, deps: BuildDeps = {}): Promise<Surface> {
  const settings = await loadSettings(env)
  let gibson = await openGibson({ settings, log, env, ...deps.open })
  const registry = new ToolRegistry()
  const posture: ToolGroup = registry.group()
  const streamLimit = deps.streamLimit ?? DEFAULT_STREAM_LIMIT
  let discovery: Discovery | undefined
  let closed = false

  // A posture that holds a task grant can serve turns: the grant it started
  // with is the base, and a turn's grant replaces it for that turn's calls.
  let turns: TurnController | undefined
  let inbox: Inbox | undefined
  const answers = new AnswerRouter()
  let ambient: AmbientSource = ambientSource(gibson, env)
  // The full tier is built but usually not listed, so its size is not the
  // registry's size. /healthz reports both, because a driver checking the
  // server is up also wants to know the API is reachable.
  let fullTier = 0
  if (gibson.live) {
    turns = createTurnController({ base: gibson.live.harness, insecure: gibson.settings.callbackInsecure, log })
    registry.use((ctx, next) => {
      const raw = ctx.headers?.[TURN_GRANT_HEADER]
      const grant = Array.isArray(raw) ? raw[0] : raw
      return turns!.withGrant(grant, next)
    })
  }

  /**
   * The inbox is a lifetime RPC: it runs under the base grant, on the
   * transport the launch opened, never under a turn's. It exists only where
   * the daemon carries the inbox RPCs, so a member sandbox has an `ask` tool
   * and an ordinary dispatched run does not.
   */
  if (gibson.live && inboxAvailable(gibson.live.harness)) {
    inbox = routeAnswers(openInbox({ harness: gibson.live.harness, log }), answers, log)
  }

  const postureCtx = (): PostureContext => ({
    env,
    cwd,
    streamLimit,
    ...(deps.exposeAllRpcs ? { exposeAllRpcs: true } : {}),
    ...(deps.discoveryIntervalMs === undefined ? {} : { discoveryIntervalMs: deps.discoveryIntervalMs }),
    ...(turns ? { taskTransport: turns.transport() } : {}),
    ambient: { block: (q) => ambient.block(q) },
    onCatalog: (catalog) => {
      fullTier = catalog.length
    },
    ...(inbox
      ? {
          ask: askTool({ jobId: () => turns?.current()?.jobId, inbox, answers, log }),
        }
      : {}),
  })

  const surface: Surface = {
    registry,
    current: () => gibson,
    upgrade: async (next) => {
      discovery?.stop()
      discovery = undefined
      await registry.batchAsync(async () => {
        posture.clear()
        gibson = next
        // The block belongs to the connection it was read over. Keeping the
        // old one after a connect would hand the model another tenant's
        // context.
        ambient = ambientSource(next, env)
        discovery = await registerPosture(posture, next, postureCtx())
      })
    },
    attach: (transport) =>
      attachServer(
        {
          registry,
          instructions: instructions(),
          resources: resources(() => gibson, { block: (q) => ambient.block(q) }),
          prompts: [ambientPrompt({ block: (q) => ambient.block(q) })],
        },
        transport,
      ),
    health: () => ({
      source: gibson.source,
      posture: gibson.mode,
      tools: registry.size(),
      api_rpcs: fullTier,
      ...(turns?.current() ? { job: turns.current()!.jobId } : {}),
    }),
    ...(inbox ? { inbox } : {}),
    ...(turns
      ? {
          turn: {
            set: (t) => turns!.set({ jobId: t.jobId, grant: t.grant, endpoint: t.endpoint ?? gibson.live!.harness.endpoint, insecure: t.insecure ?? gibson.settings.callbackInsecure }),
            clear: () => turns!.clear(),
            current: () => {
              const c = turns!.current()
              return c ? { jobId: c.jobId, endpoint: c.endpoint } : undefined
            },
          } satisfies TurnRoute,
        }
      : {}),
    close: async () => {
      if (closed) return
      closed = true
      discovery?.stop()
      inbox?.stop()
      turns?.close()
      if (gibson.source !== "dispatched") await clearLive(stateDir(env), cwd).catch(() => {})
      await gibson.close()
    },
  }

  registry.batch(() => {
    registry.register(statusTool(() => gibson))
    // A dispatched run is fully decided by its launch: there is nothing to
    // log in to or connect, and no host key to write.
    if (gibson.source !== "dispatched") {
      registry.register(loginTool(surface, env, deps))
      registry.register(connectTool(surface, env, cwd, deps))
    }
  })
  discovery = await registry.batchAsync(() => registerPosture(posture, gibson, postureCtx()))
  return surface
}

export interface PostureContext {
  env: NodeJS.ProcessEnv
  cwd: string
  streamLimit: number
  /** Register the generated RPC tools in `tools/list` as well. Default off. */
  exposeAllRpcs?: boolean
  /** The session's ambient block, for the hook handoff. */
  ambient?: AmbientSource
  discoveryIntervalMs?: number
  /** The per-turn transport, when this posture serves turns. */
  taskTransport?: ConnectTransport
  /** The `ask` tool, when this posture has an inbox to ask through. */
  ask?: ToolDefinition
  /** Told the full tier this posture built, for /healthz. */
  onCatalog?: (catalog: RpcEntry[]) => void
}

/**
 * Which transports this posture holds, for the generated RPC tools.
 *
 * `taskTransport` is the per-turn transport when there is one. The harness
 * object is passed through whole, because the RPC tools also read its
 * `context` to fill `ContextInfo`; only the transport is swapped.
 */
export function channelsOf(gibson: Gibson, taskTransport?: ConnectTransport): RpcChannels {
  return {
    ...(gibson.session ? { session: gibson.session.transport } : {}),
    ...(gibson.live ? { task: taskTransport ? { ...gibson.live.harness, transport: taskTransport } : gibson.live.harness } : {}),
  }
}

/**
 * The tools a posture carries: one per RPC, one per SDK helper, one per
 * checked-in platform tool.
 *
 * A standalone posture holds no transport, so it carries no RPC tools: a
 * tool with no daemon behind it answers every call with a dial error, which
 * reads to a model like a broken platform rather than an unconnected
 * session. Its helper tools are the ones that need no platform.
 *
 * Returns the discovery poller when this posture has a catalog to poll, so
 * the caller can stop it on upgrade or close.
 */
export async function registerPosture(group: ToolGroup, gibson: Gibson, ctx: PostureContext): Promise<Discovery | undefined> {
  for (const tool of helperToolsFor(gibson, ctx.cwd, ctx.env)) group.register(tool)

  if (ctx.ask) group.register(ctx.ask)

  // Two tiers (sdk-ts#70). The generated tools are always BUILT, and the
  // drift guard proves that set is 1:1 with the descriptors. What changes
  // here is only whether they are listed: by default they sit behind
  // gibson_api_search and gibson_api_call, because 188 descriptions on every
  // turn bury the tools an agent reaches for and trip some hosts' tool caps.
  const channels = channelsOf(gibson, ctx.taskTransport)
  let catalog: RpcEntry[] = []
  if (channels.session || channels.task) {
    catalog = rpcCatalog({ channels, streamLimit: ctx.streamLimit })
    if (ctx.exposeAllRpcs) {
      for (const entry of catalog) group.register(entry.tool)
    }
    // The door is registered either way. With the flat set in front it is
    // still the cheapest way to find one RPC among 188.
    for (const tool of apiTools({ catalog, ...(ctx.exposeAllRpcs ? { exposeAll: true } : {}) })) group.register(tool)
    log(
      `${TAG} ${catalog.length} RPC tool(s) ${ctx.exposeAllRpcs ? "listed and reachable" : "reachable"} through gibson_api_search and gibson_api_call` +
        `${ctx.exposeAllRpcs ? " (--expose-all-rpcs)" : ""}`,
    )
  }
  ctx.onCatalog?.(catalog)

  await writeHandoff(gibson, ctx)

  // Discovery reads the tenant catalog, which is a ComponentService call, so
  // it needs the component check-in. A dispatched run has none.
  if (!gibson.session) return undefined
  const discovery = startDiscovery({
    group,
    session: gibson.session,
    log,
    ...(ctx.discoveryIntervalMs === undefined ? {} : { intervalMs: ctx.discoveryIntervalMs }),
  })
  try {
    const outcome = await discovery.refresh()
    log(outcome.note ? `${TAG} Gibson tool discovery: ${outcome.note}` : `${TAG} discovery: ${outcome.tools} tool(s), ${outcome.plugins} plugin(s) registered`)
  } catch (e) {
    // Discovery is a convenience. gibson_call_tool is registered either way,
    // so a failure here costs the per-tool wrappers only.
    log(`${TAG} Gibson tool discovery failed: ${(e as Error).message}`)
  }
  return discovery
}

/**
 * The files a host's hook processes read.
 *
 * A hook runs as its own process and cannot reach this server, so the
 * ambient block and the live-mission coordinates are written beside the host
 * key, one pair per working directory. A dispatched run writes nothing: its
 * launch decided everything, and there is no hook to hand anything to.
 */
async function writeHandoff(gibson: Gibson, ctx: PostureContext): Promise<void> {
  if (gibson.source === "dispatched") return
  const dir = stateDir(ctx.env)
  if (gibson.knowledge && ctx.ambient) {
    const block = await ctx.ambient.block().catch(() => "")
    if (block) await writeAmbient(dir, ctx.cwd, block).catch((e: Error) => log(`${TAG} ambient handoff failed: ${e.message}`))
  }
  if (gibson.live) {
    await writeLive(dir, ctx.cwd, {
      missionId: gibson.live.missionId,
      workId: gibson.live.workId,
      endpoint: gibson.live.harness.endpoint,
      token: gibson.live.harness.token(),
      insecure: gibson.settings.callbackInsecure,
      writtenAt: Date.now(),
    }).catch((e: Error) => log(`${TAG} live handoff failed: ${e.message}`))
  }
}

function instructions(): string {
  return (
    "Gibson tools. Call gibson_status to see how this session is connected. " +
    "Without a platform, call gibson_login and then gibson_connect to enroll this host and start a live mission. " +
    "The tools listed here are the ones used most; the platform's whole API is reachable through " +
    "gibson_api_search and gibson_api_call."
  )
}
