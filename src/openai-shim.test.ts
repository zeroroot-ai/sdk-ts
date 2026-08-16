import { test } from "node:test"
import assert from "node:assert/strict"
import { startCompletionsShim, type RunningShim } from "./openai-shim.js"

/**
 * The shim is exercised over real HTTP against a fake ComponentService
 * client, matching how opencode's provider consumes it. Each test starts a
 * shim on an ephemeral port and closes it.
 */

async function withShim(component: unknown, fn: (shim: RunningShim) => Promise<void>): Promise<void> {
  const shim = await startCompletionsShim({ component: component as never, port: 0 })
  try {
    await fn(shim)
  } finally {
    await shim.close()
  }
}

function post(shim: RunningShim, body: unknown): Promise<Response> {
  return fetch(`${shim.url}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Parse an SSE body into its data frames, JSON-decoded, [DONE] excluded. */
function sseFrames(text: string): { frames: Record<string, unknown>[]; done: boolean } {
  const frames: Record<string, unknown>[] = []
  let done = false
  for (const line of text.split("\n")) {
    if (!line.startsWith("data: ")) continue
    const payload = line.slice("data: ".length)
    if (payload === "[DONE]") { done = true; continue }
    frames.push(JSON.parse(payload) as Record<string, unknown>)
  }
  return { frames, done }
}

function delta(frame: Record<string, unknown>): Record<string, unknown> {
  const choices = frame.choices as { delta: Record<string, unknown> }[]
  return choices?.[0]?.delta ?? {}
}

function finishReason(frame: Record<string, unknown>): string | null {
  const choices = frame.choices as { finish_reason: string | null }[]
  return choices?.[0]?.finish_reason ?? null
}

test("plain completion still proxies Complete", async () => {
  let captured: { slot: string; messages: { role: string; content: string }[] } | undefined
  const component = {
    complete: async (req: typeof captured) => {
      captured = req
      return {
        response: { role: "assistant", content: "hi" },
        usage: { inputTokens: 3, outputTokens: 2 },
      }
    },
  }
  await withShim(component, async (shim) => {
    const res = await post(shim, { model: "primary", messages: [{ role: "user", content: "hello" }] })
    assert.equal(res.status, 200)
    const body = (await res.json()) as { choices: { message: { content: string }; finish_reason: string }[]; usage: { total_tokens: number } }
    assert.equal(captured?.slot, "primary")
    assert.equal(body.choices[0].message.content, "hi")
    assert.equal(body.choices[0].finish_reason, "stop")
    assert.equal(body.usage.total_tokens, 5)
  })
})

test("stream: true renders CompleteStream chunks as SSE", async () => {
  const component = {
    completeStream: (_req: unknown) =>
      (async function* () {
        yield { content: "Hel", done: false }
        yield { content: "lo", done: false }
        yield { content: "", done: true, usage: { inputTokens: 7, outputTokens: 4 } }
      })(),
  }
  await withShim(component, async (shim) => {
    const res = await post(shim, { model: "primary", stream: true, messages: [{ role: "user", content: "hello" }] })
    assert.equal(res.status, 200)
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
    const { frames, done } = sseFrames(await res.text())
    assert.ok(done, "stream must terminate with [DONE]")
    assert.equal(delta(frames[0]).role, "assistant")
    const text = frames.map((f) => (delta(f).content as string) ?? "").join("")
    assert.equal(text, "Hello")
    const last = frames[frames.length - 1]
    assert.equal(finishReason(last), "stop")
    assert.deepEqual(last.usage, { prompt_tokens: 7, completion_tokens: 4, total_tokens: 11 })
  })
})

test("a mid-stream RPC failure surfaces as an in-band error frame", async () => {
  const component = {
    completeStream: (_req: unknown) =>
      (async function* () {
        yield { content: "par", done: false }
        throw new Error("upstream gone")
      })(),
  }
  await withShim(component, async (shim) => {
    const res = await post(shim, { model: "primary", stream: true, messages: [{ role: "user", content: "x" }] })
    const text = await res.text()
    const { frames, done } = sseFrames(text)
    assert.equal(done, false, "a failed stream must not claim [DONE]")
    const err = frames.find((f) => f.error) as { error: { message: string } } | undefined
    assert.match(err?.error.message ?? "", /upstream gone/)
  })
})

test("tools route to CompleteWithTools and map back as tool_calls", async () => {
  let captured: { tools: { name: string; description: string; inputSchemaJson: string }[] } | undefined
  const component = {
    completeWithTools: async (req: typeof captured) => {
      captured = req
      return {
        response: { role: "assistant", content: "" },
        toolCalls: [{ id: "call_1", name: "http_probe", argumentsJson: '{"url":"https://example.com"}' }],
        finishReason: "tool_calls",
        usage: { inputTokens: 11, outputTokens: 6 },
      }
    },
  }
  const params = { type: "object", properties: { url: { type: "string" } } }
  await withShim(component, async (shim) => {
    const res = await post(shim, {
      model: "primary",
      messages: [{ role: "user", content: "probe example.com" }],
      tools: [{ type: "function", function: { name: "http_probe", description: "probe a url", parameters: params } }],
    })
    assert.equal(res.status, 200)
    const body = (await res.json()) as {
      choices: { message: { tool_calls: { id: string; type: string; function: { name: string; arguments: string } }[] }; finish_reason: string }[]
    }
    assert.equal(captured?.tools[0].name, "http_probe")
    assert.deepEqual(JSON.parse(captured!.tools[0].inputSchemaJson), params)
    const call = body.choices[0].message.tool_calls[0]
    assert.equal(call.id, "call_1")
    assert.equal(call.type, "function")
    assert.equal(call.function.name, "http_probe")
    assert.deepEqual(JSON.parse(call.function.arguments), { url: "https://example.com" })
    assert.equal(body.choices[0].finish_reason, "tool_calls")
  })
})

test("stream + tools synthesizes one SSE turn from the unary RPC", async () => {
  const component = {
    completeWithTools: async (_req: unknown) => ({
      response: { role: "assistant", content: "" },
      toolCalls: [{ id: "call_9", name: "http_probe", argumentsJson: "{}" }],
      finishReason: "tool_calls",
      usage: { inputTokens: 1, outputTokens: 1 },
    }),
  }
  await withShim(component, async (shim) => {
    const res = await post(shim, {
      model: "primary",
      stream: true,
      messages: [{ role: "user", content: "go" }],
      tools: [{ type: "function", function: { name: "http_probe" } }],
    })
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/)
    const { frames, done } = sseFrames(await res.text())
    assert.ok(done)
    const calls = delta(frames[0]).tool_calls as { index: number; id: string; function: { name: string } }[]
    assert.equal(calls[0].index, 0)
    assert.equal(calls[0].id, "call_9")
    assert.equal(calls[0].function.name, "http_probe")
    assert.equal(finishReason(frames[frames.length - 1]), "tool_calls")
  })
})

test("response_format json_schema routes to CompleteStructured", async () => {
  let captured: { schemaJson: string } | undefined
  const component = {
    completeStructured: async (req: typeof captured) => {
      captured = req
      return { resultJson: '{"severity":"high"}', usage: { inputTokens: 2, outputTokens: 2 } }
    },
  }
  const schema = { type: "object", properties: { severity: { type: "string" } } }
  await withShim(component, async (shim) => {
    const res = await post(shim, {
      model: "primary",
      messages: [{ role: "user", content: "classify" }],
      response_format: { type: "json_schema", json_schema: { name: "triage", schema } },
    })
    const body = (await res.json()) as { choices: { message: { content: string } }[] }
    assert.deepEqual(JSON.parse(captured!.schemaJson), schema)
    assert.deepEqual(JSON.parse(body.choices[0].message.content), { severity: "high" })
  })
})

test("tool history flattens deterministically into role+content messages", async () => {
  let captured: { messages: { role: string; content: string }[] } | undefined
  const component = {
    complete: async (req: typeof captured) => {
      captured = req
      return { response: { role: "assistant", content: "done" }, usage: {} }
    },
  }
  await withShim(component, async (shim) => {
    await post(shim, {
      model: "primary",
      messages: [
        { role: "user", content: "probe example.com" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "http_probe", arguments: '{"url":"https://example.com"}' } }],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"status":200}' },
      ],
    })
    const [, assistant, toolResult] = captured!.messages
    assert.equal(assistant.role, "assistant")
    assert.match(assistant.content, /\[tool_calls\]/)
    assert.match(assistant.content, /http_probe/)
    assert.match(toolResult.content, /^\[tool_result call_1\]/)
    assert.match(toolResult.content, /"status":200/)
  })
})

test("a tool result never travels as a tool-role turn", async () => {
  // LLMMessage has no tool_call_id, and providers reject a tool-role message
  // without one — so a tool-role turn would fail the second step of every
  // agent loop. Nothing the shim emits may carry role "tool".
  let captured: { messages: { role: string; content: string }[] } | undefined
  const component = {
    complete: async (req: typeof captured) => {
      captured = req
      return { response: { role: "assistant", content: "done" }, usage: {} }
    },
  }
  await withShim(component, async (shim) => {
    await post(shim, {
      model: "primary",
      messages: [
        { role: "user", content: "probe example.com" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "call_1", type: "function", function: { name: "http_probe", arguments: "{}" } }],
        },
        { role: "tool", tool_call_id: "call_1", content: '{"status":200}' },
        { role: "tool", content: "an id-less result" },
      ],
    })
    const roles = captured!.messages.map((m) => m.role)
    assert.deepEqual(roles, ["user", "assistant", "user", "user"])
    assert.match(captured!.messages[3].content, /^\[tool_result\] /)
  })
})

test("an RPC failure before headers is a 502 with the error in-band", async () => {
  const component = {
    complete: async () => {
      throw new Error("no slot named primary")
    },
  }
  await withShim(component, async (shim) => {
    const res = await post(shim, { model: "primary", messages: [{ role: "user", content: "x" }] })
    assert.equal(res.status, 502)
    const body = (await res.json()) as { error: { message: string } }
    assert.match(body.error.message, /no slot named primary/)
  })
})
