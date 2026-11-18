# sdk-ts — AGENTS.md

> **Workflow rules:** see [`zeroroot-ai/.github` → `AGENTS.md`](https://github.com/zeroroot-ai/.github/blob/main/AGENTS.md) — canonical for branching / commits / PRs / releases / merging. Conventional Commits MANDATORY. Never push to main. Never force-push.

## TL;DR

A pnpm workspace with two published packages.

`packages/sdk` → `@zeroroot-ai/sdk` — the framework-agnostic TypeScript SDK for the
Gibson platform: connect-es bindings, Capability-Grant auth (Ed25519
host/agent keys, `agent+jwt` interceptor), component lifecycle
(`RegisterComponent` + heartbeat, `connectGibson()`), one Open Responses
model client (`ModelClient`), and A2A for an agent: the work payload is an A2A
message and the result is an A2A task.
`packages/gibson-mcp` → `@zeroroot-ai/gibson-mcp` — the Gibson MCP server, the
one tool surface every coding agent host loads (ADR-0158). It is
built from the same generated descriptors and rides the SDK release train.
Hosts are thin adapters in `zerocool-plugins` and hold no tools of their own.

## Commands

```bash
pnpm generate    # regen bindings from BSR (buf.build/zeroroot-ai/sdk + protovalidate), then the MCP tool table
pnpm build       # tsc, every package
pnpm typecheck   # tsc --noEmit, every package
pnpm lint        # oxlint
pnpm test        # compile tests + node --test, every package
```

Run one package with `pnpm --filter @zeroroot-ai/gibson-mcp <script>`.

pnpm/TypeScript repo: the contract surface is `package.json` scripts —
no Makefile (exempt from the org Makefile contract, same class as
dashboard).

## Gotchas

- **The MCP tool table is generated too.** `pnpm --filter @zeroroot-ai/gibson-mcp generate`
  rewrites `packages/gibson-mcp/src/generated/tools.ts` from the SDK's
  descriptors. `generated-drift.yml` fails a PR that leaves it stale, and a
  test in the package asserts the generator is deterministic.
- **Releases: two components, one train.** release-please tags the SDK
  `vX.Y.Z` (unchanged, `include-component-in-tag: false`) and gibson-mcp
  `gibson-mcp-vX.Y.Z`. The publish job reads `paths_released` and publishes
  exactly those packages. Never hand-tag.
- **Bindings come from the BSR**, not a local proto include
  (`buf.generate buf.build/zeroroot-ai/sdk`) and they live in
  `packages/sdk/src/gen`. If generated types look
  stale, check that the BSR module actually carries the release you
  expect — the tag-push publish job in `zeroroot-ai/sdk` is the
  producer.
- This is a **customer-facing, source-available surface** under the Elastic
  License 2.0, not open source. Component-dev scope only — no
  admin/operator/billing surface belongs here (ADR-0058 discipline applies to
  what the SDK exposes).

- **The model and the agent wire follow the Go SDK.** The contract with the
  daemon is the Go SDK branch `epic/aaif-alignment` (gibson#1366). The golden
  request bodies in `packages/sdk/src/testdata/openresponses` are copies of
  `openresponses/testdata` in the Go SDK. Change both or neither.
- **The SDK protos are pinned to a BSR commit on this branch (temporary).** `pnpm generate` uses the commit id in `packages/sdk/package.json`. Before the branch merges, change the pin to the release version of the Go SDK.
- **A2A types come from `@a2a-js/sdk`** (Apache-2.0, A2A v1.0). `src/a2a.ts` is
  the one place that converts an agent task and result to A2A types.
- **The gateway trust rule is in `src/gateway.ts`.** A client trusts exactly the
  PEM bundle that the daemon sends. It has no option to skip verification.

## Links

- Org-level workflow: [`AGENTS.md`](https://github.com/zeroroot-ai/.github/blob/main/AGENTS.md)
- Producer protos: [`zeroroot-ai/sdk`](https://github.com/zeroroot-ai/sdk)
- Consumer plugins: [`zeroroot-ai/zerocool-plugins`](https://github.com/zeroroot-ai/zerocool-plugins)
