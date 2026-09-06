# sdk-ts

The TypeScript workspace for the Gibson platform. Two published packages, one
release train.

| Package | What it is |
|---|---|
| [`@zeroroot-ai/sdk`](packages/sdk) | the MIT, framework-agnostic SDK: connect-es bindings generated from the BSR, Capability Grant auth, component lifecycle, the task harness, and an OpenAI-compatible LLM shim |
| [`@zeroroot-ai/gibson-mcp`](packages/gibson-mcp) | the Gibson MCP server: one tool surface for every coding agent host, built from the same generated descriptors. Bin: `gibson-mcp`. |

```bash
pnpm install
pnpm generate    # regenerate the bindings from the BSR, then the tool table
pnpm build
pnpm typecheck
pnpm lint
pnpm test
```

Both packages are MIT.

## License and history

Elastic License 2.0. See [LICENSE](LICENSE). Zero Root AI is the licensor.

Issue and pull request numbers cited in comments and documents dated before 2026-09-05 refer to the tracker before the history reset, archived offline. They do not resolve on GitHub.
