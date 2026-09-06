# sdk-ts — AGENTS.md

> **Workflow rules:** see [`zeroroot-ai/.github` → `AGENTS.md`](https://github.com/zeroroot-ai/.github/blob/main/AGENTS.md) — canonical for branching / commits / PRs / releases / merging. Conventional Commits MANDATORY. Never push to main. Never force-push.

## TL;DR

A pnpm workspace with two published packages.

`packages/sdk` → `@zeroroot-ai/sdk` — the MIT, framework-agnostic TypeScript SDK for the
Gibson platform: connect-es bindings, Capability-Grant auth (Ed25519
host/agent keys, `agent+jwt` interceptor), component lifecycle
(`RegisterComponent` + heartbeat, `connectGibson()`), and a local
OpenAI-compatible LLM shim proxying to `ComponentService.Complete`.
`packages/gibson-mcp` → `@zeroroot-ai/gibson-mcp` — the Gibson MCP server, the
one tool surface every coding agent host loads (gibson#1706, ADR-0008). It is
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
  producer (see sdk#459 for its failure mode).
- This is a **customer-facing OSS surface** (MIT). Component-dev scope
  only — no admin/operator/billing surface belongs here (ADR-0058
  discipline applies to what the SDK exposes).

## Links

- Org-level workflow: [`AGENTS.md`](https://github.com/zeroroot-ai/.github/blob/main/AGENTS.md)
- Producer protos: [`zeroroot-ai/sdk`](https://github.com/zeroroot-ai/sdk)
- Consumer plugins: [`zeroroot-ai/zerocool-plugins`](https://github.com/zeroroot-ai/zerocool-plugins)
