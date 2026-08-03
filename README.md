# @zerocool/sdk (sdk-ts)

The TypeScript SDK for the [Gibson](https://zeroroot.ai) platform — **framework-agnostic**.
Any TS program can use it to become a Gibson component and talk to the harness.

- **Bindings** — connect-es (protobuf-es v2) generated from BSR (`buf.build/zeroroot-ai/sdk`).
- **Capability Grant auth** — Ed25519 host/agent keys, discover, register, `agent+jwt` interceptor.
- **Component lifecycle** — `RegisterComponent` + heartbeat; `connectGibson()` session.
- **LLM shim** — a local OpenAI-compatible endpoint proxying to `ComponentService.Complete`.

The [`zerocool-plugins`](https://github.com/zeroroot-ai/zerocool-plugins) opencode
plugins build on this SDK. Nothing opencode-specific lives here.

## License

MIT.
