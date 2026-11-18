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

## License

Elastic License 2.0. Zero Root AI is the licensor. It is source-available, not
open source.
