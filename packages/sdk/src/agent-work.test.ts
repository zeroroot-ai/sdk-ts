// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"

import {
  EXTENSION_KEY,
  Role,
  TaskState,
  WorkMessageError,
  decodeWorkMessage,
  encodeTask,
  loadPinnedSkills,
  newMessage,
  resultToTask,
  taskFromMessage,
  textPart,
  type AgentTask,
} from "./a2a.js"
import type { InstanceRef } from "./component.js"
import { decodeAgentWork, startAgentWorker, type AgentInvocation } from "./work.js"

/**
 * The agent wire (gibson#1366). The work payload is one A2A v1.0 Message in
 * A2A JSON. The result is one A2A v1.0 Task in A2A JSON. The Gibson context
 * rides under one extension key. The field names and the state names are the
 * ones of the contract, so a daemon that follows it reads what we send.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

/** A work message as the daemon sends it. */
function workMessage(over: Record<string, unknown> = {}, ext?: Record<string, unknown>): Uint8Array {
  return enc.encode(
    JSON.stringify({
      messageId: "m-1",
      role: "ROLE_USER",
      taskId: "task-1",
      contextId: "ctx-1",
      parts: [{ text: "scan the host" }, { text: "port 22 only" }],
      ...(ext ? { metadata: { [EXTENSION_KEY]: ext } } : {}),
      ...over,
    }),
  )
}

test("the goal is the text of all text parts, joined with a newline", () => {
  const { task, message } = decodeAgentWork(workMessage())
  assert.equal(task.goal, "scan the host\nport 22 only")
  assert.equal(task.id, "task-1")
  assert.equal(task.contextId, "ctx-1")
  assert.equal(message.role, Role.ROLE_USER)
  assert.equal(task.message, message)
})

test("a part that is not text is kept in the message and not in the goal", () => {
  const { task } = decodeAgentWork(workMessage({ parts: [{ text: "look" }, { data: { port: 22 } }] }))
  assert.equal(task.goal, "look")
  assert.equal(task.message.parts.length, 2)
})

test("the extension envelope fills the run, the skills, the limits and the free-form maps", () => {
  const { task } = decodeAgentWork(
    workMessage(
      {},
      {
        mission_run_id: "mr-1",
        agent_run_id: "ar-1",
        run_number: 3,
        job_id: "job-1",
        trace_id: "trace-1",
        parent_span_id: "span-1",
        pinned_skills: ["skill:review"],
        constraints: { max_turns: 5, max_tokens: 1000, allowed_tools: ["a"], blocked_tools: ["b"] },
        context: { target: "10.0.0.1" },
        metadata: { priority: 2 },
      },
    ),
  )
  assert.deepEqual(task.run, {
    missionRunId: "mr-1",
    agentRunId: "ar-1",
    runNumber: 3,
    jobId: "job-1",
    traceId: "trace-1",
    parentSpanId: "span-1",
  })
  assert.deepEqual(task.pinnedSkills, ["skill:review"])
  assert.deepEqual(task.constraints, { maxTurns: 5, maxTokens: 1000, allowedTools: ["a"], blockedTools: ["b"] })
  assert.deepEqual(task.context, { target: "10.0.0.1" })
  assert.deepEqual(task.metadata, { priority: 2 })
})

test("a message with no extension key still makes a task", () => {
  const { task } = decodeAgentWork(workMessage())
  assert.deepEqual(task.pinnedSkills, [])
  assert.equal(task.run.missionRunId, "")
  assert.equal(task.job, undefined)
})

test("the job of the envelope decodes as a JobSpec in protojson form", () => {
  const { task } = decodeAgentWork(workMessage({}, { job: { jobId: "job-9" } }))
  assert.ok(task.job)
})

test("a message with no taskId or no contextId is refused", () => {
  assert.throws(() => decodeAgentWork(workMessage({ taskId: "" })), /no taskId/)
  assert.throws(() => decodeAgentWork(workMessage({ contextId: "" })), /no contextId/)
  assert.throws(() => decodeAgentWork(enc.encode('{"messageId":"m","role":"ROLE_USER","parts":[]}')), WorkMessageError)
})

test("a payload that is not an A2A message is refused", () => {
  assert.throws(() => decodeWorkMessage(enc.encode("not json")), WorkMessageError)
  assert.throws(() => decodeWorkMessage(enc.encode("[]")), WorkMessageError)
  assert.throws(() => decodeWorkMessage(enc.encode("")), WorkMessageError)
})

function taskOf(over: Partial<AgentTask> = {}): AgentTask {
  return { ...decodeAgentWork(workMessage()).task, ...over }
}

function wire(task: ReturnType<typeof resultToTask>): Record<string, unknown> {
  return JSON.parse(dec.decode(encodeTask(task))) as Record<string, unknown>
}

test("a result with no state is completed, and the output is an artifact named output", () => {
  const out = wire(resultToTask(taskOf(), { output: { files: 2 } }))
  assert.equal(out.id, "task-1")
  assert.equal(out.contextId, "ctx-1")
  assert.equal((out.status as { state: string }).state, "TASK_STATE_COMPLETED")
  const artifacts = out.artifacts as { name: string; parts: unknown[] }[]
  assert.equal(artifacts.length, 1)
  assert.equal(artifacts[0]?.name, "output")
  assert.deepEqual(artifacts[0]?.parts, [{ data: { files: 2 } }])
})

test("a string output is a text part and a byte output is a raw part", () => {
  const text = wire(resultToTask(taskOf(), { output: "done" }))
  assert.deepEqual((text.artifacts as { parts: unknown[] }[])[0]?.parts, [{ text: "done" }])
  const raw = wire(resultToTask(taskOf(), { output: new Uint8Array([1, 2, 3]) }))
  assert.deepEqual((raw.artifacts as { parts: unknown[] }[])[0]?.parts, [{ raw: "AQID" }])
})

test("the history starts with the message of the work item", () => {
  const history = [newMessage(Role.ROLE_AGENT, [textPart("working")], { taskId: "task-1", contextId: "ctx-1" })]
  const out = wire(resultToTask(taskOf(), { history }))
  const h = out.history as { role: string; parts: { text: string }[] }[]
  assert.equal(h.length, 2)
  assert.equal(h[0]?.role, "ROLE_USER")
  assert.equal(h[1]?.role, "ROLE_AGENT")
})

test("input required puts the output in the status message, so the caller sees the question", () => {
  const out = wire(resultToTask(taskOf(), { state: TaskState.TASK_STATE_INPUT_REQUIRED, output: "which port?" }))
  const status = out.status as { state: string; message: { parts: { text: string }[] } }
  assert.equal(status.state, "TASK_STATE_INPUT_REQUIRED")
  assert.equal(status.message.parts[0]?.text, "which port?")
  assert.equal(out.artifacts, undefined)
})

test("an error makes the task failed with the error text in the status message", () => {
  const out = wire(
    resultToTask(taskOf(), { error: { code: "SCAN_FAILED", message: "host down", retryable: true, component: "scanner" } }),
  )
  const status = out.status as { state: string; message: { parts: { text: string }[] } }
  assert.equal(status.state, "TASK_STATE_FAILED")
  assert.match(status.message.parts[0]?.text ?? "", /host down/)
  const ext = (out.metadata as Record<string, { error: { code: string; retryable: boolean } }>)[EXTENSION_KEY]
  assert.equal(ext?.error.code, "SCAN_FAILED")
  assert.equal(ext?.error.retryable, true)
})

test("finding ids and metadata ride in the extension of the task", () => {
  const out = wire(resultToTask(taskOf(), { findings: ["f-1", "f-2"], metadata: { branch: "fix/ci" } }))
  assert.deepEqual((out.metadata as Record<string, unknown>)[EXTENSION_KEY], {
    finding_ids: ["f-1", "f-2"],
    metadata: { branch: "fix/ci" },
  })
})

test("a task with no findings, metadata or error has no extension metadata", () => {
  assert.equal(wire(resultToTask(taskOf(), { output: "x" })).metadata, undefined)
})

test("the SDK writes only the A2A state names", () => {
  for (const [state, name] of [
    [TaskState.TASK_STATE_COMPLETED, "TASK_STATE_COMPLETED"],
    [TaskState.TASK_STATE_FAILED, "TASK_STATE_FAILED"],
    [TaskState.TASK_STATE_CANCELED, "TASK_STATE_CANCELED"],
    [TaskState.TASK_STATE_REJECTED, "TASK_STATE_REJECTED"],
    [TaskState.TASK_STATE_INPUT_REQUIRED, "TASK_STATE_INPUT_REQUIRED"],
    [TaskState.TASK_STATE_AUTH_REQUIRED, "TASK_STATE_AUTH_REQUIRED"],
  ] as const) {
    assert.equal((wire(resultToTask(taskOf(), { state })).status as { state: string }).state, name)
  }
})

test("loadPinnedSkills makes a function call and an output for each skill", async () => {
  const calls: [string, string][] = []
  const items = await loadPinnedSkills(async (name, input) => {
    calls.push([name, input])
    return '{ "body": "skill text" }'
  }, ["skill:review", "skill:plan"])
  assert.deepEqual(calls, [
    ["invoke_tool", '{"id":"skill:review"}'],
    ["invoke_tool", '{"id":"skill:plan"}'],
  ])
  assert.deepEqual(items[0], {
    type: "function_call",
    call_id: "pinned_skill_0",
    name: "invoke_tool",
    arguments: '{"id":"skill:review"}',
    status: "completed",
  })
  assert.deepEqual(items[1], { type: "function_call_output", call_id: "pinned_skill_0", output: '{"body":"skill text"}' })
  assert.equal(items.length, 4)
})

test("loadPinnedSkills names the skill that failed", async () => {
  await assert.rejects(
    loadPinnedSkills(async () => {
      throw new Error("NOT_FOUND: no such skill")
    }, ["skill:gone"]),
    /"skill:gone".*NOT_FOUND/,
  )
})

// ── the loop ────────────────────────────────────────────────────────────────

function fixedRef(id: string): InstanceRef {
  return { current: () => id, heartbeatIntervalMs: () => 15_000, renew: async () => id }
}

/** Resolves once, then parks every later poll until stop() abandons the loop. */
function pollOnce(work: { workId: string; workType: string; payload: Uint8Array; timeoutMs?: bigint }) {
  let delivered = false
  return async () => {
    if (!delivered) {
      delivered = true
      return { ...work, context: { mission_id: "m-1" } }
    }
    return new Promise<never>(() => {})
  }
}

interface Submitted {
  workId: string
  result: Uint8Array
  error?: { code: string; message: string; retryable: boolean }
}

function fakeComponent(
  work: { workId: string; workType: string; payload: Uint8Array; timeoutMs?: bigint },
  extra: Record<string, unknown> = {},
) {
  const submitted: Submitted[] = []
  let done!: () => void
  const finished = new Promise<void>((r) => (done = r))
  const component = {
    pollWork: pollOnce(work),
    submitResult: async (req: Submitted) => {
      submitted.push(req)
      done()
      return {}
    },
    ...extra,
  }
  return { component, submitted, finished }
}

test("an agent work item flows claim -> handler -> A2A Task", async () => {
  const { component, submitted, finished } = fakeComponent({
    workId: "w1",
    workType: "execute",
    payload: workMessage({}, { agent_run_id: "ar-1" }),
    timeoutMs: 900_000n,
  })
  let seen: AgentInvocation | undefined
  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async (item) => {
      seen = item
      return { state: TaskState.TASK_STATE_INPUT_REQUIRED, output: "which port?" }
    },
  })
  await finished
  stop()

  assert.equal(seen?.goal, "scan the host\nport 22 only")
  assert.equal(seen?.task.run.agentRunId, "ar-1")
  assert.equal(seen?.context.mission_id, "m-1")
  assert.equal(seen?.timeoutMs, 900_000)
  assert.ok(seen?.signal)
  assert.equal(submitted.length, 1)
  assert.equal(submitted[0]?.error, undefined)
  const task = JSON.parse(dec.decode(submitted[0]?.result)) as { id: string; contextId: string; status: { state: string } }
  assert.equal(task.id, "task-1")
  assert.equal(task.contextId, "ctx-1")
  assert.equal(task.status.state, "TASK_STATE_INPUT_REQUIRED")
})

test("pinned skills load before the handler runs", async () => {
  const toolCalls: { workId: string; toolName: string; inputJson: string }[] = []
  const { component, submitted, finished } = fakeComponent(
    { workId: "w2", workType: "execute", payload: workMessage({}, { pinned_skills: ["skill:review"] }) },
    {
      callTool: async (req: { workId: string; toolName: string; inputJson: string }) => {
        toolCalls.push(req)
        return { outputJson: '{"body":"skill text"}' }
      },
    },
  )
  let items = 0
  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async (item) => {
      items = item.task.skillItems.length
      return {}
    },
  })
  await finished
  stop()
  assert.equal(items, 2, "a function call and a function call output")
  assert.equal(toolCalls[0]?.toolName, "invoke_tool")
  assert.equal(toolCalls[0]?.workId, "w2")
  assert.deepEqual(JSON.parse(toolCalls[0]?.inputJson ?? ""), { id: "skill:review" })
  assert.equal(submitted[0]?.error, undefined)
})

test("a pinned skill that fails to load stops the run", async () => {
  const { component, submitted, finished } = fakeComponent(
    { workId: "w3", workType: "execute", payload: workMessage({}, { pinned_skills: ["skill:gone"] }) },
    { callTool: async () => ({ outputJson: "", error: { code: "NOT_FOUND", message: "no such skill" } }) },
  )
  let ran = false
  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async () => {
      ran = true
      return {}
    },
    onError: () => {},
  })
  await finished
  stop()
  assert.equal(ran, false, "the agent must not start")
  assert.equal(submitted[0]?.error?.code, "PINNED_SKILL_LOAD_FAILED")
  assert.equal(submitted[0]?.error?.retryable, false)
  assert.match(submitted[0]?.error?.message ?? "", /skill:gone/)
})

test("a bad payload is answered with DESERIALIZATION_ERROR, not left to time out", async () => {
  const { component, submitted, finished } = fakeComponent({
    workId: "w4",
    workType: "execute",
    payload: enc.encode("not json"),
  })
  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async () => ({}),
    onError: () => {},
  })
  await finished
  stop()
  assert.equal(submitted[0]?.error?.code, "DESERIALIZATION_ERROR")
})

test("a handler that throws is answered with EXECUTION_ERROR and no Task", async () => {
  const { component, submitted, finished } = fakeComponent({ workId: "w5", workType: "execute", payload: workMessage() })
  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async () => {
      throw new Error("opencode exited 1")
    },
    onError: () => {},
  })
  await finished
  stop()
  assert.equal(submitted[0]?.error?.code, "EXECUTION_ERROR")
  assert.equal(submitted[0]?.error?.message, "opencode exited 1")
  assert.equal(submitted[0]?.result.length, 0)
})

test("an output with no JSON form is answered with SERIALIZATION_ERROR", async () => {
  const { component, submitted, finished } = fakeComponent({ workId: "w6", workType: "execute", payload: workMessage() })
  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async () => ({ output: { n: 1n } }),
    onError: () => {},
  })
  await finished
  stop()
  assert.equal(submitted[0]?.error?.code, "SERIALIZATION_ERROR")
})

test("taskFromMessage keeps the message that it was built from", () => {
  const msg = newMessage(Role.ROLE_USER, [textPart("hi")], { taskId: "t", contextId: "c" })
  assert.equal(taskFromMessage(msg).message, msg)
})
