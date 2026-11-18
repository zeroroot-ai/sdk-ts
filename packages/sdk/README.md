# @zeroroot-ai/sdk (sdk-ts)

The TypeScript SDK for the [Gibson](https://zeroroot.ai) platform — **framework-agnostic**.
Any TS program can use it to become a Gibson component and talk to the harness.

- **Bindings** — connect-es (protobuf-es v2) generated from BSR (`buf.build/zeroroot-ai/sdk`).
- **Capability Grant auth** — Ed25519 host/agent keys, discover, register, `agent+jwt` interceptor.
- **Component lifecycle** — `RegisterComponent` + heartbeat; `connectGibson()` session.
- **Model client** — one Open Responses client (`ModelClient`) for a plain call, a tool call, a structured call and a streamed call. The daemon names the gateway with `ResolveModel`. The client trusts exactly the CA bundle that the daemon sends.
- **A2A** — an agent receives an A2A message and returns an A2A task over the work queue. It delegates to another agent through the Agent gateway.

The [`zerocool-plugins`](https://github.com/zeroroot-ai/zerocool-plugins) opencode
plugins build on this SDK. Nothing opencode-specific lives here.

## Call a model

The daemon names the gateway and the model for a slot. Ask the harness for the
one `ModelClient` of a slot. It has no code for a model provider. It sends one
Open Responses request shape to the gateway, with the task grant of the run,
and it trusts exactly the CA bundle that the daemon sends.

```ts
import { responseText, userMessage } from "@zeroroot-ai/sdk"

const model = await harness.model("primary")
const reply = await model.create({ input: [userMessage("say hello")] })
console.log(responseText(reply))

const stream = await model.stream({ input: [userMessage("say hello")] })
await stream.collect((delta) => process.stdout.write(delta))
```

`harness.resolveModel(slot)` returns the answer of the daemon without a client.
For a tool call, set `tools` and send all items back with a `functionCallOutput`
item. For a structured reply, call `createStructured` with a JSON schema.

## Serve an agent over A2A

An agent receives an A2A message and returns an A2A task. The agent opens no
port. The daemon sends the message on the work queue, with the task grant of the
work item.

```ts
import { daemonGrantRenewer, startAgentWorker, TaskState } from "@zeroroot-ai/sdk"

startAgentWorker(component, instance, {
  renewGrant: daemonGrantRenewer(session.transport),
  handler: async ({ task, harness }) => {
    // task.goal is the text of the message. task.skillItems holds the pinned skills.
    const model = await harness.model("primary")
    return { state: TaskState.TASK_STATE_COMPLETED, output: `done: ${task.goal}` }
  },
})
```

The SDK renews the task grant when it has less than 2 minutes left. A work item
with no grant fails each gateway call before the call is sent. A handler that
throws gives a work error with the code `EXECUTION_ERROR`. A handler that
returns `TaskState.TASK_STATE_INPUT_REQUIRED` and an output shows the output to
the caller as the question.

To delegate, call `harness.delegate(name, message, { bankId })`. It sends the
A2A message through the Agent gateway and returns the A2A task.

A tool result has a `toolCallId`. A finding can name the tool calls that back it
with `citeToolCalls`. The platform builds the evidence from its own record. An
agent cannot set an evidence tier.

## License

Elastic License 2.0. Zero Root AI is the licensor. It is source-available, not
open source.
