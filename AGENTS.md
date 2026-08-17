# sdk-ts — AGENTS.md

> **Workflow rules:** see [`zeroroot-ai/.github` → `AGENTS.md`](https://github.com/zeroroot-ai/.github/blob/main/AGENTS.md) — canonical for branching / commits / PRs / releases / merging. Conventional Commits MANDATORY. Never push to main. Never force-push.

## TL;DR

`@zeroroot-ai/sdk` — the MIT, framework-agnostic TypeScript SDK for the
Gibson platform: connect-es bindings, Capability-Grant auth (Ed25519
host/agent keys, `agent+jwt` interceptor), component lifecycle
(`RegisterComponent` + heartbeat, `connectGibson()`), and a local
OpenAI-compatible LLM shim proxying to `ComponentService.Complete`.
The `zerocool-plugins` opencode plugins build on this SDK; nothing
opencode-specific lives here.

## Commands

```bash
pnpm generate    # regen bindings from BSR (buf.build/zeroroot-ai/sdk + protovalidate)
pnpm build       # tsc
pnpm typecheck   # tsc --noEmit
pnpm test        # compile tests + node --test
```

pnpm/TypeScript repo: the contract surface is `package.json` scripts —
no Makefile (exempt from the org Makefile contract, same class as
dashboard).

## Gotchas

- **Bindings come from the BSR**, not a local proto include
  (`buf.generate buf.build/zeroroot-ai/sdk`). If generated types look
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
