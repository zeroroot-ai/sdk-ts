// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import {
  cancelMission,
  createMission,
  createTaskMission,
  EXTENSION_KEY,
  getMissionResults,
  getMissionStatus,
  isSeamUnavailable,
  listMissions,
  newMessage,
  Role,
  runMission,
  taskStateName,
  taskToJson,
  textPart,
  waitMission,
} from "@zeroroot-ai/sdk"
import { z } from "zod"
import type { ToolDefinition } from "../registry.js"
import { defineTool } from "../tool.js"
import { failure, json, text } from "../tools/result.js"
import type { HelperContext } from "./context.js"

const UNWIRED = "This daemon has no mission management wired (gibson#1186). Complete the work directly instead."

/**
 * Delegation and missions: the network of agents in the tenant. Delegation
 * needs the task grant of a live mission, because the Agent gateway takes only
 * that grant (gibson#1366).
 */
export function delegationTools(ctx: HelperContext): ToolDefinition[] {
  const out: ToolDefinition[] = []
  const live = ctx.gibson.live

  if (live) {
    out.push(
      defineTool({
        name: "create_task_mission",
        description:
          "Originate a mission from the tenant's checked-in catalog, by name, from inside this run. " +
          "Use it to start a named piece of platform work; use delegate for a one-off task.",
        input: {
          name: z.string().describe("Catalog mission name."),
          target_id: z.string().optional().describe("Target the mission binds to. Defaults to this run's target."),
          params: z.record(z.string(), z.string()).optional().describe("Catalog parameters, by name."),
          metadata: z.record(z.string(), z.unknown()).optional().describe("Free-form metadata recorded on the mission."),
        },
        handler: async (args) => {
          try {
            return json(
              await createTaskMission(live.harness, {
                name: args.name,
                ...(args.target_id ? { targetId: args.target_id } : {}),
                ...(args.params ? { catalogParams: args.params } : {}),
                ...(args.metadata ? { metadata: args.metadata } : {}),
              } as never),
            )
          } catch (e) {
            return failure("create_task_mission failed", (e as Error).message)
          }
        },
      }),
    )
    out.push(
      defineTool({
        name: "delegate",
        description:
          "Delegate a sub-task to another Gibson agent and wait for its result. The message goes to " +
          "the agent through the Agent gateway over A2A. The result is the A2A task of the agent, " +
          "with a state such as TASK_STATE_COMPLETED or TASK_STATE_INPUT_REQUIRED. Name an agent " +
          "that you know. This server has no tool to list agents.",
        input: {
          agent: z.string().describe("Name of the agent to delegate to."),
          goal: z.string().describe("What the delegate should accomplish."),
          context: z.record(z.string(), z.unknown()).optional().describe("Target details, prior findings, or other context the delegate needs."),
          max_turns: z.number().int().min(1).optional().describe("Cap on the delegate's model turns."),
          allowed_tools: z.array(z.string()).optional().describe("Restrict the delegate to these tools."),
          bank_id: z.string().optional().describe("Send the task to a bank of always-on agents."),
        },
        handler: async (args) => {
          try {
            const envelope = {
              ...(args.context ? { context: args.context } : {}),
              ...(args.max_turns || args.allowed_tools
                ? {
                    constraints: {
                      ...(args.max_turns ? { max_turns: args.max_turns } : {}),
                      ...(args.allowed_tools ? { allowed_tools: args.allowed_tools } : {}),
                    },
                  }
                : {}),
            }
            const message = newMessage(
              Role.ROLE_USER,
              [textPart(args.goal)],
              Object.keys(envelope).length > 0 ? { metadata: { [EXTENSION_KEY]: envelope } } : {},
            )
            const task = await live.harness.delegate(args.agent, message, args.bank_id ? { bankId: args.bank_id } : {})
            return text(`${args.agent}: ${taskStateName(task)}`, JSON.stringify(taskToJson(task), null, 2))
          } catch (e) {
            return failure("delegation failed", (e as Error).message)
          }
        },
      }),
    )
  }

  if (!ctx.gibson.session) return out
  const component = ctx.gibson.session.clients.component
  const seam = (e: unknown, what: string) => (isSeamUnavailable(e) ? text(`${what} unavailable`, UNWIRED) : failure(`${what} failed`, (e as Error).message))

  out.push(
    defineTool({
      name: "create_mission",
      description: "Create a Gibson mission from a mission definition, bound to a target. The mission is not started; call run_mission to queue it.",
      input: {
        definition: z.record(z.string(), z.unknown()).describe("Mission definition object (gibson.mission.v1.MissionDefinition as JSON)."),
        target_id: z.string().describe("Identifier of the target the mission runs against."),
        opts: z.record(z.string(), z.unknown()).optional().describe("Optional mission creation options."),
      },
      handler: async (args) => {
        try {
          return json(await createMission(component, args.definition, args.target_id, args.opts))
        } catch (e) {
          return seam(e, "create mission")
        }
      },
    }),
    defineTool({
      name: "run_mission",
      description: "Queue a created Gibson mission for execution. Returns as soon as it is queued.",
      input: { mission_id: z.string().describe("Mission to run.") },
      handler: async (args) => {
        try {
          await runMission(component, args.mission_id)
          return text("queued", `Mission ${args.mission_id} is queued.`)
        } catch (e) {
          return seam(e, "run mission")
        }
      },
    }),
    defineTool({
      name: "mission_status",
      description: "Check a Gibson mission's status.",
      input: { mission_id: z.string().describe("Mission to inspect.") },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        try {
          return json(await getMissionStatus(component, args.mission_id))
        } catch (e) {
          return seam(e, "mission status")
        }
      },
    }),
    defineTool({
      name: "wait_mission",
      description: "Block until a Gibson mission reaches a terminal state. Use it only when you intend to stop and wait for the result.",
      input: {
        mission_id: z.string().describe("Mission to wait for."),
        timeout_ms: z.number().int().min(1).optional().describe("How long to block. Defaults to 5 minutes."),
      },
      handler: async (args) => {
        try {
          return json(await waitMission(component, args.mission_id, args.timeout_ms))
        } catch (e) {
          return seam(e, "wait mission")
        }
      },
    }),
    defineTool({
      name: "mission_results",
      description: "Read the final results of a completed Gibson mission.",
      input: { mission_id: z.string().describe("Mission whose results to read.") },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        try {
          return json(await getMissionResults(component, args.mission_id))
        } catch (e) {
          return seam(e, "mission results")
        }
      },
    }),
    defineTool({
      name: "cancel_mission",
      description: "Request cancellation of a running Gibson mission.",
      input: { mission_id: z.string().describe("Mission to cancel.") },
      handler: async (args) => {
        try {
          await cancelMission(component, args.mission_id)
          return text("cancel requested", `Cancellation of ${args.mission_id} is requested.`)
        } catch (e) {
          return seam(e, "cancel mission")
        }
      },
    }),
    defineTool({
      name: "list_missions",
      description: "List this tenant's missions, optionally filtered.",
      input: { filter: z.record(z.string(), z.unknown()).optional().describe("Equality filters on mission fields.") },
      annotations: { readOnlyHint: true },
      handler: async (args) => {
        try {
          return json(await listMissions(component, args.filter ?? {}))
        } catch (e) {
          return seam(e, "list missions")
        }
      },
    }),
  )
  return out
}
