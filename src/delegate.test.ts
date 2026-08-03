import { test } from "node:test"
import assert from "node:assert/strict"
import {
  createMission,
  delegateToAgent,
  listAgents,
  newTask,
  runMission,
  waitMission,
  type Result,
} from "./delegate.js"

/**
 * Golden tests for the delegation wire format.
 *
 * `agent.Task` and `agent.Result` carry no JSON tags in Go, so they marshal with
 * Go field names — `ID`, `Goal`, `Context`, `Constraints`, `Status`, `Output`.
 * Emitting camelCase here would decode as a zero-value Task on the Go side
 * without any error, so the casing is asserted explicitly.
 */

test("newTask emits Go field names, not camelCase", () => {
  const task = newTask("enumerate the login flow")
  assert.ok("ID" in task, "Task.ID must be capitalised")
  assert.ok("Goal" in task, "Task.Goal must be capitalised")
  assert.ok(!("id" in task), "lowercase id would decode as a zero value in Go")
  assert.ok(!("goal" in task))
})

test("newTask mirrors the Go SDK by duplicating the goal into Context", () => {
  const task = newTask("find the auth bypass")
  assert.equal(task.Goal, "find the auth bypass")
  assert.equal(task.Context?.goal, "find the auth bypass")
})

test("caller context merges with the goal rather than replacing it", () => {
  const task = newTask("scan", { Context: { target: "example.com" } })
  assert.equal(task.Context?.goal, "scan")
  assert.equal(task.Context?.target, "example.com")
})

test("constraints keep their Go field names", () => {
  const task = newTask("scan", { Constraints: { MaxTurns: 5, AllowedTools: ["nmap"] } })
  const encoded = JSON.parse(JSON.stringify(task))
  assert.equal(encoded.Constraints.MaxTurns, 5)
  assert.deepEqual(encoded.Constraints.AllowedTools, ["nmap"])
})

test("delegateToAgent JSON-encodes the task and decodes the result", async () => {
  const goResult: Result = {
    Status: "success",
    Output: { summary: "done" },
    Findings: ["finding-1"],
  }
  let captured: { agentName: string; taskJson: Uint8Array } | undefined
  const component = {
    delegateToAgent: async (req: { workId: string; agentName: string; taskJson: Uint8Array }) => {
      captured = req
      return { resultJson: new TextEncoder().encode(JSON.stringify(goResult)) }
    },
  }

  const task = newTask("enumerate endpoints")
  const result = await delegateToAgent(component as never, "recon-agent", task)

  assert.equal(captured?.agentName, "recon-agent")
  assert.deepEqual(JSON.parse(new TextDecoder().decode(captured!.taskJson)), task)
  assert.equal(result.Status, "success")
  assert.deepEqual(result.Findings, ["finding-1"])
})

test("delegateToAgent surfaces an empty result as an error", async () => {
  const component = {
    delegateToAgent: async () => ({ resultJson: new Uint8Array() }),
  }
  await assert.rejects(
    () => delegateToAgent(component as never, "ghost-agent", newTask("x")),
    /empty result/,
  )
})

test("listAgents degrades to an empty list when the daemon seam is unwired", async () => {
  const component = {
    listAgents: async () => {
      throw Object.assign(new Error("unimplemented"), { code: "unimplemented" })
    },
  }
  const discovery = await listAgents(component as never)
  assert.deepEqual(discovery.agents, [])
  assert.match(discovery.unavailable ?? "", /gibson#1186/)
})

test("listAgents rethrows errors that are not Unimplemented", async () => {
  const component = {
    listAgents: async () => {
      throw Object.assign(new Error("permission denied"), { code: "permission_denied" })
    },
  }
  await assert.rejects(() => listAgents(component as never), /permission denied/)
})

test("createMission encodes the definition and opts as JSON bytes", async () => {
  let captured: { missionDefinitionJson: Uint8Array; targetId: string; optsJson?: Uint8Array } | undefined
  const component = {
    createMission: async (req: {
      missionDefinitionJson: Uint8Array
      targetId: string
      optsJson?: Uint8Array
    }) => {
      captured = req
      return { missionJson: new TextEncoder().encode(JSON.stringify({ id: "mission-1" })) }
    },
  }

  const info = await createMission(component as never, { name: "recon" }, "target-7", { dryRun: true })

  assert.equal(info.id, "mission-1")
  assert.equal(captured?.targetId, "target-7")
  assert.deepEqual(JSON.parse(new TextDecoder().decode(captured!.missionDefinitionJson)), { name: "recon" })
  assert.deepEqual(JSON.parse(new TextDecoder().decode(captured!.optsJson!)), { dryRun: true })
})

test("createMission omits optsJson entirely when no opts are given", async () => {
  let captured: Record<string, unknown> | undefined
  const component = {
    createMission: async (req: Record<string, unknown>) => {
      captured = req
      return { missionJson: new Uint8Array() }
    },
  }
  await createMission(component as never, { name: "recon" }, "target-7")
  assert.ok(!("optsJson" in captured!), "an absent opts must not become an empty JSON object")
})

test("runMission passes the mission id through", async () => {
  let captured: { missionId: string } | undefined
  const component = {
    runMission: async (req: { missionId: string }) => {
      captured = req
      return {}
    },
  }
  await runMission(component as never, "mission-1")
  assert.equal(captured?.missionId, "mission-1")
})

test("waitMission converts the timeout to the proto's int64", async () => {
  let captured: { timeoutMs: bigint } | undefined
  const component = {
    waitMission: async (req: { missionId: string; timeoutMs: bigint }) => {
      captured = req
      return { resultJson: new TextEncoder().encode(JSON.stringify({ Status: "success" })) }
    },
  }
  const result = await waitMission(component as never, "mission-1", 60_000)
  assert.equal(captured?.timeoutMs, 60_000n)
  assert.equal(result.Status, "success")
})
