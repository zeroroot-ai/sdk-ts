// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import assert from "node:assert/strict"
import test from "node:test"
import type { TaskHarness } from "@zeroroot-ai/sdk"
import { AnswerRouter, askTool, decisionFrom } from "./ask.js"
import { inboxAvailable, InputKind, JobState, openInbox, principalName, routeAnswers, toJobInput, type Inbox, type JobInput } from "./inbox.js"

/** A harness whose client carries the inbox RPCs, with a scripted stream. */
function inboxHarness(script: {
  streams: JobInput[][]
  fail?: number[]
  sent?: { jobId: string; message: string; kind: InputKind }[]
  states?: { jobId: string; state: JobState }[]
}): TaskHarness {
  let attempt = -1
  let nextId = 0
  return {
    transport: {} as never,
    client: {
      subscribeInput: () => {
        attempt += 1
        const round = attempt
        return (async function* () {
          if (script.fail?.includes(round)) throw new Error(`stream ${round} dropped`)
          // The wire wraps each Input in a SubscribeInputResponse.
          for (const input of script.streams[round] ?? []) yield { input: { ...input, sender: { kind: 1, id: "1" } } }
        })()
      },
      sendInput: async (req: { jobId: string; message: string; kind: InputKind }) => {
        script.sent?.push({ jobId: req.jobId, message: req.message, kind: req.kind })
        nextId += 1
        return { input: { id: `sent-${nextId}`, jobId: req.jobId, message: req.message, kind: req.kind } }
      },
      reportJobState: async (req: { jobId: string; state: JobState }) => {
        script.states?.push({ jobId: req.jobId, state: req.state })
        return {}
      },
    } as never,
    endpoint: "daemon:50001",
    context: { missionId: "m-1", taskId: "t-1", agentName: "claude" },
    token: () => "base",
    expiresAt: () => 0,
    stop: () => {},
  }
}

const input = (jobId: string, message: string, extra: Partial<JobInput> = {}): JobInput => ({
  id: `in-${jobId}-${message.slice(0, 4)}`,
  jobId,
  message,
  grant: `grant-${jobId}`,
  sender: "1:1",
  kind: InputKind.TURN,
  sentAt: 0,
  ...extra,
})

test("a wire Input flattens, and a principal reads as kind:id", () => {
  assert.deepEqual(
    toJobInput({ id: "i-1", jobId: "j-1", message: "go", grant: "g", sender: { kind: 1, id: "u-1" }, kind: InputKind.ANSWER, sentAt: { seconds: 2n } } as never),
    { id: "i-1", jobId: "j-1", message: "go", grant: "g", sender: "1:u-1", kind: InputKind.ANSWER, sentAt: 2000 },
  )
  assert.equal(principalName(undefined), "")
  // A message the daemon sent with nothing set still reads, so one missing
  // field never takes down the pump.
  assert.equal(toJobInput(undefined).jobId, "")
  assert.equal(toJobInput(undefined).kind, InputKind.UNSPECIFIED)
})

test("a daemon without the inbox RPCs is named, not guessed at", async () => {
  const bare = { ...inboxHarness({ streams: [] }), client: {} as never }
  assert.equal(inboxAvailable(bare), false)
  const inbox = openInbox({ harness: bare })
  await assert.rejects(async () => {
    for await (const _ of inbox.messages()) break
  }, /SubscribeInput/)
  await assert.rejects(inbox.send("j-1", "hello", InputKind.TURN), /SubscribeInput/)
  await assert.rejects(inbox.reportState("j-1", JobState.WAITING), /SubscribeInput/)
})

test("the subscription reconnects after a dropped stream and loses nothing after it", async () => {
  const slept: number[] = []
  const harness = inboxHarness({ streams: [[input("j-1", "first")], [], [input("j-1", "second")]], fail: [1] })
  const inbox = openInbox({ harness, sleep: async (ms) => void slept.push(ms), minBackoffMs: 10, maxBackoffMs: 40 })
  const got: string[] = []
  for await (const m of inbox.messages()) {
    got.push(m.message)
    if (got.length === 2) break
  }
  inbox.stop()
  assert.deepEqual(got, ["first", "second"])
  assert.ok(slept.length >= 2, "a clean end of stream and a dropped one both wait before asking again")
  assert.ok(slept[1]! >= slept[0]!, "the backoff grows")
})

test("ask returns the next input for its own job and leaves another job's input alone", async () => {
  const sent: { jobId: string; message: string; kind: InputKind }[] = []
  const states: { jobId: string; state: JobState }[] = []
  const harness = inboxHarness({
    streams: [[input("j-other", "not your answer"), input("j-1", "use the second approach")]],
    sent,
    states,
  })
  const answers = new AnswerRouter()
  const inbox = routeAnswers(openInbox({ harness }), answers)
  const driver: JobInput[] = []
  void (async () => {
    for await (const m of inbox.messages()) driver.push(m)
  })()

  const tool = askTool({ jobId: () => "j-1", inbox, answers })
  const res = await tool.handler({ question: "which approach?" }, {})
  assert.equal((res.content as { text: string }[])[0]!.text, "use the second approach")
  assert.deepEqual(sent, [{ jobId: "j-1", message: "which approach?", kind: InputKind.TURN }])
  // WAITING while the question is open, WORKING once it is answered.
  assert.deepEqual(states, [
    { jobId: "j-1", state: JobState.WAITING },
    { jobId: "j-1", state: JobState.WORKING },
  ])

  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(driver.map((m) => m.jobId), ["j-other"], "an answer is consumed by its question; another job's turn is not")
  inbox.stop()
})

test("ask with no job open says so instead of waiting for an answer that cannot come", async () => {
  const answers = new AnswerRouter()
  const tool = askTool({ jobId: () => undefined, inbox: { send: async () => input("j", "x"), reportState: async () => {} }, answers })
  const res = await tool.handler({ question: "anything?" }, {})
  assert.equal(res.isError, true)
  assert.match((res.content as { text: string }[])[0]!.text, /POST \/turn/)
})

test("a permission prompt comes back in the shape Claude Code expects", async () => {
  assert.deepEqual(decisionFrom("yes, go ahead", { path: "/tmp/x" }), { behavior: "allow", updatedInput: { path: "/tmp/x" } })
  assert.deepEqual(decisionFrom("no, not that directory", {}), { behavior: "deny", message: "no, not that directory" })

  const answers = new AnswerRouter()
  const inbox: Pick<Inbox, "send" | "reportState"> = { send: async () => input("j-1", "q"), reportState: async () => {} }
  const tool = askTool({ jobId: () => "j-1", inbox, answers })
  const pending = tool.handler({ question: "may I?", tool_name: "Bash", input: { command: "rm -rf build" } }, {})
  await new Promise((r) => setTimeout(r, 10))
  answers.offer(input("j-1", "deny, use the clean script"))
  const res = await pending
  assert.deepEqual(JSON.parse((res.content as { text: string }[])[0]!.text), { behavior: "deny", message: "deny, use the clean script" })
})

test("two jobs can hold an open question at once without crossing answers", async () => {
  const answers = new AnswerRouter()
  const one = answers.next("j-1")
  const two = answers.next("j-2")
  answers.offer(input("j-2", "for two"))
  answers.offer(input("j-1", "for one"))
  assert.equal((await one).message, "for one")
  assert.equal((await two).message, "for two")
})

test("an answer that arrives before the question is asked is held, not dropped", async () => {
  const answers = new AnswerRouter()
  assert.equal(answers.offer(input("j-1", "early")), false, "nobody is waiting yet")
  answers.hold(input("j-1", "early"))
  assert.equal((await answers.next("j-1")).message, "early")
})

test("a cancelled question stops waiting rather than hanging the job", async () => {
  const answers = new AnswerRouter()
  const controller = new AbortController()
  const pending = answers.next("j-1", controller.signal)
  controller.abort()
  await assert.rejects(pending, /cancelled/)
})
