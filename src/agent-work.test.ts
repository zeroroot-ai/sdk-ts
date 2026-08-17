import assert from "node:assert/strict"
import test from "node:test"

import type { InstanceRef } from "./component.js"
import {
  decodeAgentExecute,
  encodeAgentError,
  encodeAgentResult,
  startAgentWorker,
  type AgentInvocation,
} from "./work.js"

/**
 * The `agent_execute` wire contract (zerocool-plugins#33).
 *
 * Every assertion here is anchored to what gibson actually does with the bytes,
 * in `internal/engine/harness/implementation.go:1236-1250`:
 *
 *   resp := &agentpb.ExecuteResponse{}
 *   protojson.UnmarshalOptions{DiscardUnknown: true}.Unmarshal(resultBytes, resp)
 *   if e := resp.GetError(); e != nil && (e.GetMessage() != "" || e.GetCode() != "") { fail }
 *   result := agent.ProtoToResult(resp.GetResult())
 *
 * so a change that still typechecks but breaks one of those reads fails here.
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

/** protojson as Go emits it: lowerCamelCase keys, int64 as a *string*. */
function agentPayload(over: Record<string, unknown> = {}): Uint8Array {
  return enc.encode(
    JSON.stringify({
      task: { id: "t-1", goal: "fix the failing pipeline" },
      timeoutMs: "900000",
      callbackEndpoint: "https://daemon:8443",
      callbackToken: "cb-token",
      missionRunId: "mr-1",
      agentRunId: "ar-1",
      runNumber: 3,
      traceId: "trace-1",
      parentSpanId: "span-1",
      ...over,
    }),
  )
}

test("decodeAgentExecute reads the task, the callback seam and the provenance", () => {
  const req = decodeAgentExecute(agentPayload())
  assert.equal(req.task?.goal, "fix the failing pipeline")
  assert.equal(req.callbackEndpoint, "https://daemon:8443")
  assert.equal(req.callbackToken, "cb-token")
  assert.equal(req.missionRunId, "mr-1")
  assert.equal(req.agentRunId, "ar-1")
  assert.equal(req.runNumber, 3)
})

test("decodeAgentExecute reads int64 timeout_ms sent as a JSON string", () => {
  // protojson encodes int64 as a string. Reading it as a number would silently
  // yield NaN and a handler would run with no deadline.
  assert.equal(decodeAgentExecute(agentPayload()).timeoutMs, 900_000n)
})

test("decodeAgentExecute accepts the proto field names too", () => {
  const payload = enc.encode(
    JSON.stringify({ callback_endpoint: "https://x", mission_run_id: "mr-2", run_number: 1 }),
  )
  const req = decodeAgentExecute(payload)
  assert.equal(req.callbackEndpoint, "https://x")
  assert.equal(req.missionRunId, "mr-2")
})

test("decodeAgentExecute ignores fields a newer daemon adds", () => {
  // gibson unmarshals our response with DiscardUnknown: true; the request leg
  // gets the same tolerance, so a schema bump does not crash every worker.
  const req = decodeAgentExecute(agentPayload({ somethingAddedLater: { nested: true } }))
  assert.equal(req.task?.goal, "fix the failing pipeline")
})

test("decodeAgentExecute treats an empty payload as an empty request, not a throw", () => {
  assert.equal(decodeAgentExecute(new Uint8Array()).callbackEndpoint, "")
})

test("encodeAgentResult reports SUCCESS with the output as a JSON string value", () => {
  const out = JSON.parse(dec.decode(encodeAgentResult({ output: { files: 2 } }))) as {
    result: { status: string; output: { stringValue: string } }
  }
  assert.equal(out.result.status, "RESULT_STATUS_SUCCESS")
  assert.deepEqual(JSON.parse(out.result.output.stringValue), { files: 2 })
})

test("encodeAgentResult carries finding ids and metadata onto the Result", () => {
  const out = JSON.parse(
    dec.decode(encodeAgentResult({ findingIds: ["f-1", "f-2"], metadata: { branch: "fix/ci" } })),
  ) as { result: { findingIds: string[]; metadata: Record<string, { stringValue: string }> } }
  assert.deepEqual(out.result.findingIds, ["f-1", "f-2"])
  assert.equal(out.result.metadata.branch.stringValue, "fix/ci")
})

test("encodeAgentResult marks a self-reported failure FAILED without an error object", () => {
  // An unreachable goal is an outcome, not a crash: it must not trip gibson's
  // `resp.GetError()` gate, which would report it as a delegation failure.
  const out = JSON.parse(dec.decode(encodeAgentResult({ success: false, output: "gave up" }))) as {
    result: { status: string }
    error?: unknown
  }
  assert.equal(out.result.status, "RESULT_STATUS_FAILED")
  assert.equal(out.error, undefined)
})

test("encodeAgentError sets BOTH code and message", () => {
  // gibson's gate is `e.GetMessage() != "" || e.GetCode() != ""`. An error with
  // neither reads as success, which would report a crashed run as a completed one.
  const out = JSON.parse(dec.decode(encodeAgentError("boom"))) as {
    error: { code: string; message: string }
  }
  assert.equal(out.error.message, "boom")
  assert.equal(out.error.code, "AGENT_EXECUTION_FAILED")
})

// ── the loop ────────────────────────────────────────────────────────────────

function fixedRef(id: string): InstanceRef {
  return { current: () => id, heartbeatIntervalMs: () => 15_000, renew: async () => id }
}

/** Resolves once, then parks every later poll until stop() abandons the loop. */
function pollOnce(work: { workId: string; workType: string; payload: Uint8Array }) {
  let delivered = false
  return async () => {
    if (!delivered) {
      delivered = true
      return { ...work, context: {} }
    }
    return new Promise<never>(() => {})
  }
}

test("an agent work item flows claim -> handler -> submitResult", async () => {
  const submitted: { workId: string; result: Uint8Array }[] = []
  let done!: () => void
  const finished = new Promise<void>((r) => (done = r))

  const component = {
    pollWork: pollOnce({ workId: "w1", workType: "agent_execute", payload: agentPayload() }),
    submitResult: async (req: { workId: string; result: Uint8Array }) => {
      submitted.push(req)
      done()
      return {}
    },
  }

  let seen: AgentInvocation | undefined
  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async (item) => {
      seen = item
      return { output: { goal: item.goal } }
    },
  })
  await finished
  stop()

  assert.equal(seen?.goal, "fix the failing pipeline")
  assert.equal(seen?.callbackToken, "cb-token")
  assert.equal(seen?.timeoutMs, 900_000)
  assert.equal(submitted[0]?.workId, "w1")
  const body = JSON.parse(dec.decode(submitted[0]!.result)) as {
    result: { status: string; output: { stringValue: string } }
  }
  assert.equal(body.result.status, "RESULT_STATUS_SUCCESS")
  assert.deepEqual(JSON.parse(body.result.output.stringValue), { goal: "fix the failing pipeline" })
})

test("a handler that throws is answered in band, not left to time out", async () => {
  const submitted: { workId: string; result: Uint8Array }[] = []
  let done!: () => void
  const finished = new Promise<void>((r) => (done = r))

  const component = {
    pollWork: pollOnce({ workId: "w2", workType: "agent_execute", payload: agentPayload() }),
    submitResult: async (req: { workId: string; result: Uint8Array }) => {
      submitted.push(req)
      done()
      return {}
    },
  }

  const stop = startAgentWorker(component as never, fixedRef("i1"), {
    handler: async () => {
      throw new Error("opencode exited 1")
    },
    onError: () => {},
  })
  await finished
  stop()

  const body = JSON.parse(dec.decode(submitted[0]!.result)) as { error: { message: string; code: string } }
  assert.equal(body.error.message, "opencode exited 1")
  assert.equal(body.error.code, "AGENT_EXECUTION_FAILED")
})
