// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { create, toJson } from "@bufbuild/protobuf"
import type { Client } from "@connectrpc/connect"
import type { ComponentService } from "./clients.js"
import type { GibsonSession } from "./connect.js"
import { createMission, runMission } from "./delegate.js"
import { MissionDefinitionSchema, NodeType } from "./gen/gibson/mission/v1/mission_definition_pb.js"
import { decodeGrantClaims, openTaskHarness, type OpenTaskHarnessOptions, type TaskContext, type TaskHarness } from "./task-harness.js"
import { decodeAgentExecute, encodeAgentError, encodeAgentResult, type AgentOutcome } from "./work.js"

/**
 * A live mission: one mission per interactive session (gibson#1593, decision 9).
 *
 * Launching an interactive coding agent creates one mission whose single AGENT
 * node names this very component. The brain dispatches that node as
 * `agent_execute` work to us, and the work item carries the task grant. From
 * then on the session is a dispatched agent: `Observe`, `WorldView`,
 * `QueryNodes` and the session store all run under that grant, attributed to a
 * mission a person launched (ADR-0012). The session ends the node with
 * {@link LiveMission.end}, and the mission completes at quiescence.
 *
 * The target is the user's. A component cannot create one (the Target RPCs
 * admit USER | SERVICE identities only), so the caller passes the id of a
 * target a person created, and the mission's scope is that target's.
 */
/**
 * MissionOriginator creates AND runs the session mission and returns its id.
 * The daemon lets a component originate a mission only from inside one it was
 * dispatched to (ADR-0063), and an interactive session has no parent mission,
 * so the person at the keyboard originates it: the plugin submits the
 * definition through the CLI's login session (`gibson mission submit`), the
 * daemon dispatches the one AGENT node to this component, and the component
 * claims it. `componentOriginator` is the in-mission variant for a component
 * that already runs inside a dispatched mission.
 */
export type MissionOriginator = (definition: unknown, targetId: string) => Promise<string>

export interface LiveMissionOptions {
  /** The registered component name. Must equal what RegisterComponent used. */
  agentName: string
  /** The target the mission binds to. Scope for every observation. */
  targetId: string
  /**
   * Who creates and runs the mission. Defaults to the component itself, which
   * the daemon accepts only from inside a dispatched mission (ADR-0063).
   */
  originate?: MissionOriginator
  /** Mission name. Defaults to `<agentName> session`. */
  name?: string
  /** How long the node may run. Defaults to 8 hours. */
  timeoutSeconds?: number
  /** The goal recorded on the node's task. */
  goal?: string
  /** Give up waiting for our own dispatch after this long. Default 60s. */
  claimTimeoutMs?: number
  /** Callback dial options, forwarded to {@link openTaskHarness}. */
  harness?: Omit<OpenTaskHarnessOptions, "endpoint" | "token">
  /** Test seam. */
  clock?: () => number
}

export interface LiveMission {
  missionId: string
  workId: string
  harness: TaskHarness
  /** Complete the node. The mission completes at quiescence. */
  end(outcome?: AgentOutcome): Promise<void>
}

const DEFAULT_TIMEOUT_SECONDS = 8 * 60 * 60
const DEFAULT_CLAIM_TIMEOUT_MS = 60_000

/** The one-node definition a live mission runs, as canonical proto JSON. */
export function liveMissionDefinition(opts: LiveMissionOptions): unknown {
  const def = create(MissionDefinitionSchema, {
    name: opts.name ?? `${opts.agentName} session ${new Date((opts.clock ?? Date.now)()).toISOString()}`,
    description: "Live session: one interactive coding-agent session, one mission (gibson#1593, decision 9).",
    nodes: {
      session: {
        id: "session",
        type: NodeType.AGENT,
        name: opts.agentName,
        config: {
          case: "agentConfig",
          value: {
            agentName: opts.agentName,
            task: {
              id: "session",
              goal: opts.goal ?? "Interactive session. A person sets the goals as the session runs.",
            },
          },
        },
        timeout: { seconds: BigInt(opts.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) },
      },
    },
  })
  return toJson(MissionDefinitionSchema, def)
}

/** Read the mission id off a CreateMission response. */
function missionIdOf(info: Record<string, unknown>): string {
  const id = info.id ?? info.ID ?? info.mission_id ?? info.missionId
  if (typeof id !== "string" || !id) {
    throw new Error(`gibson-sdk: CreateMission returned no mission id: ${JSON.stringify(info)}`)
  }
  return id
}

/**
 * Create and run the session mission, then claim its dispatch.
 *
 * Work for another mission that arrives while we wait is answered with an
 * error result, not dropped: the harness blocks on every item it dispatched,
 * and a silent drop stalls that mission's node for its full timeout.
 */
/**
 * A harness on the component's own grant, over the session transport. A
 * work item that the daemon dispatched through the work queue (an
 * off-cluster, poll-mode agent) carries `context.mission_id` but no task
 * grant and no callback endpoint (gibson#1633), so there is no task token
 * to dial the harness with. The component's own grant is the credential the
 * component posture already uses for reads and findings; this makes the
 * mission's Observe/SubmitFinding calls run on the same one. No renewal:
 * the session's grant is renewed by the session itself.
 */
export function sessionHarness(session: GibsonSession, context: TaskContext): TaskHarness {
  return {
    transport: session.transport,
    client: session.clients.harness,
    endpoint: "",
    context,
    token: () => "",
    expiresAt: () => Number.POSITIVE_INFINITY,
    stop: () => {},
  }
}

/** The component creates and runs the mission itself (valid only inside a dispatched mission, ADR-0063). */
export function componentOriginator(component: Client<typeof ComponentService>): MissionOriginator {
  return async (definition, targetId) => {
    const missionId = missionIdOf(await createMission(component, definition, targetId))
    await runMission(component, missionId)
    return missionId
  }
}

export async function startLiveMission(session: GibsonSession, opts: LiveMissionOptions): Promise<LiveMission> {
  const component: Client<typeof ComponentService> = session.clients.component
  const originate = opts.originate ?? componentOriginator(component)
  const missionId = await originate(liveMissionDefinition(opts), opts.targetId)

  const clock = opts.clock ?? (() => Date.now())
  const deadline = clock() + (opts.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS)

  while (clock() < deadline) {
    const res = await component.pollWork({ instanceId: session.instance.current() })
    if (!res.workId) continue // block timeout expired with no work

    const grant = grantOf(res)
    const grantMission = grant ? decodeGrantClaims(grant).missionId : ""
    const dispatchMission = res.context?.mission_id ?? ""
    if (res.workType === "agent_execute" && (grantMission === missionId || dispatchMission === missionId)) {
      const workId = res.workId
      const harness = grant
        ? openTaskHarness({
            ...opts.harness,
            endpoint: decodeAgentExecute(res.payload ?? new Uint8Array()).callbackEndpoint || res.context?.callback_endpoint || "",
            token: grant,
          })
        : sessionHarness(session, { missionId, taskId: workId, agentName: opts.agentName })
      return {
        missionId,
        workId,
        harness,
        end: async (outcome = {}) => {
          harness.stop()
          await component.submitResult({ workId, result: encodeAgentResult(outcome) })
        },
      }
    }

    await component.submitResult({
      workId: res.workId,
      result: encodeAgentError(
        `work item ${res.workId} (${res.workType}) reached an interactive session that only serves its own live mission ${missionId}`,
      ),
    })
  }

  throw new Error(
    `gibson-sdk: mission ${missionId} was created and run, but no agent_execute dispatch for it reached ` +
      `instance ${session.instance.current()} within ${opts.claimTimeoutMs ?? DEFAULT_CLAIM_TIMEOUT_MS}ms. ` +
      `Check that agent_name ${JSON.stringify(opts.agentName)} is this component's registered name.`,
  )
}

/** The task grant a work item carries, wherever the daemon put it. */
function grantOf(res: { context?: Record<string, string>; payload?: Uint8Array; workType: string }): string {
  const fromContext = res.context?.capability_grant
  if (fromContext) return fromContext
  if (res.workType !== "agent_execute") return ""
  return decodeAgentExecute(res.payload ?? new Uint8Array()).callbackToken
}
