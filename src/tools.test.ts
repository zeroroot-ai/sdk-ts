import { test } from "node:test"
import assert from "node:assert/strict"
import {
  callGibsonTool,
  isSeamUnavailable,
  seamReason,
  listGibsonTools,
  parseMaybeJSON,
  queryGibsonPlugin,
} from "./tools.js"

test("listGibsonTools flattens the catalog descriptors", async () => {
  const component = {
    listTools: async () => ({
      tools: [
        {
          name: "nmap",
          version: "1.0.0",
          description: "port scanner",
          tags: ["recon"],
          inputMessageType: "gibson.tool.v1.ScanRequest",
          outputMessageType: "gibson.tool.v1.ScanResponse",
        },
      ],
    }),
  }
  const { tools, unavailable } = await listGibsonTools(component as never)
  assert.equal(unavailable, undefined)
  assert.equal(tools[0].name, "nmap")
  assert.equal(tools[0].inputMessageType, "gibson.tool.v1.ScanRequest")
})

test("listGibsonTools degrades to empty when the daemon seam is unwired", async () => {
  const component = {
    listTools: async () => {
      throw Object.assign(new Error("unimplemented"), { code: "unimplemented" })
    },
  }
  const { tools, unavailable } = await listGibsonTools(component as never)
  assert.deepEqual(tools, [])
  assert.match(unavailable ?? "", /gibson#1186/)
})

test("listGibsonTools rethrows a real failure", async () => {
  const component = {
    listTools: async () => {
      throw Object.assign(new Error("backend down"), { code: "unavailable" })
    },
  }
  await assert.rejects(() => listGibsonTools(component as never), /backend down/)
})

test("callGibsonTool JSON-encodes input and decodes output", async () => {
  let captured: { toolName: string; inputJson: string; timeoutMs: bigint } | undefined
  const component = {
    callTool: async (req: { toolName: string; inputJson: string; timeoutMs: bigint }) => {
      captured = req
      return { outputJson: JSON.stringify({ ports: [80, 443] }), error: undefined }
    },
  }

  const result = await callGibsonTool(component as never, {
    name: "nmap",
    input: { host: "example.com" },
    timeoutMs: 30_000,
  })

  assert.equal(captured?.toolName, "nmap")
  assert.deepEqual(JSON.parse(captured!.inputJson), { host: "example.com" })
  assert.equal(captured?.timeoutMs, 30_000n)
  assert.deepEqual(result.output, { ports: [80, 443] })
  assert.equal(result.error, undefined)
})

test("a tool failure comes back in-band rather than as a throw", async () => {
  const component = {
    callTool: async () => ({
      outputJson: "",
      error: { code: "TOOL_NOT_FOUND", message: "no such tool", retryable: false },
    }),
  }
  const result = await callGibsonTool(component as never, { name: "ghost", input: {} })
  assert.equal(result.output, undefined)
  assert.equal(result.error?.code, "TOOL_NOT_FOUND")
  assert.equal(result.error?.retryable, false)
})

test("timeoutMs defaults to 0 so the daemon applies its own default", async () => {
  let captured: { timeoutMs: bigint } | undefined
  const component = {
    callTool: async (req: { timeoutMs: bigint }) => {
      captured = req
      return { outputJson: "{}", error: undefined }
    },
  }
  await callGibsonTool(component as never, { name: "t", input: {} })
  assert.equal(captured?.timeoutMs, 0n)
})

test("queryGibsonPlugin passes the method and params through", async () => {
  let captured: { pluginName: string; method: string; paramsJson: string } | undefined
  const component = {
    queryPlugin: async (req: { pluginName: string; method: string; paramsJson: string }) => {
      captured = req
      return { resultJson: JSON.stringify({ ok: true }), error: undefined }
    },
  }
  const result = await queryGibsonPlugin(component as never, {
    plugin: "shodan",
    method: "lookup",
    params: { ip: "1.1.1.1" },
  })
  assert.equal(captured?.pluginName, "shodan")
  assert.equal(captured?.method, "lookup")
  assert.deepEqual(JSON.parse(captured!.paramsJson), { ip: "1.1.1.1" })
  assert.deepEqual(result.output, { ok: true })
})

test("parseMaybeJSON returns raw text for a non-JSON tool output", () => {
  assert.deepEqual(parseMaybeJSON('{"a":1}'), { a: 1 })
  assert.equal(parseMaybeJSON("plain text result"), "plain text result")
  assert.equal(parseMaybeJSON(""), undefined)
})

test("isSeamUnavailable recognises both the string and numeric gRPC codes", () => {
  assert.equal(isSeamUnavailable({ code: "unimplemented" }), true)
  assert.equal(isSeamUnavailable({ code: 12 }), true)
  assert.equal(isSeamUnavailable(new Error("boom")), false)
  assert.equal(isSeamUnavailable(undefined), false)
})

test("isSeamUnavailable also covers a daemon that decided this caller may not", () => {
  // The mission seam answers failed_precondition on purpose: the RPC exists and
  // is understood, but the platform has not decided a component may originate a
  // mission. Treating it as a transient fault would make a caller retry forever.
  assert.equal(isSeamUnavailable({ code: "failed_precondition" }), true)
  assert.equal(isSeamUnavailable({ code: 9 }), true)
})

test("isSeamUnavailable does not swallow a transient fault", () => {
  // `unavailable` is the daemon being down — retrying is exactly right there,
  // so it must not be reported as a permanently missing capability.
  assert.equal(isSeamUnavailable({ code: "unavailable" }), false)
  assert.equal(isSeamUnavailable({ code: 14 }), false)
})

test("seamReason prefers the daemon's own explanation", () => {
  assert.equal(seamReason({ rawMessage: "not enabled: pending decisions" }), "not enabled: pending decisions")
  // `message` is ignored: it is "[code] " plus the same text, and degrades to
  // the bare code name when the server sent no message at all.
  assert.equal(seamReason({ message: "[failed_precondition] not enabled" }), null)
  assert.equal(seamReason({ rawMessage: "   " }), null)
  assert.equal(seamReason(undefined), null)
})
