# Changelog

## 0.1.0 (2026-08-16)


### Features

* add Depth-2 helpers — findings, knowledge, tools, delegation, componentize ([#1](https://github.com/zeroroot-ai/sdk-ts/issues/1)) ([9587084](https://github.com/zeroroot-ai/sdk-ts/commit/95870844ac2594b3f5d7cafbff35f68d3800095e))
* **auth:** bind agent+jwt to its gRPC method and a stable audience ([#9](https://github.com/zeroroot-ai/sdk-ts/issues/9)) ([d582489](https://github.com/zeroroot-ai/sdk-ts/commit/d582489ab0cdd742a4b034428a27a80abb286c89))
* dispatched work runner, CG header fix, native gRPC transport ([#3](https://github.com/zeroroot-ai/sdk-ts/issues/3)) ([bb72ce6](https://github.com/zeroroot-ai/sdk-ts/commit/bb72ce640f6de950860b24afcfad7d27f1837f65))
* initial @zerocool/sdk — the TypeScript Gibson SDK ([7e57e1a](https://github.com/zeroroot-ai/sdk-ts/commit/7e57e1a4e53829385231da4193e52e29ae05995a))
* **shim:** streaming, tool calling, and structured output through the harness ([#12](https://github.com/zeroroot-ai/sdk-ts/issues/12)) ([1dc9979](https://github.com/zeroroot-ai/sdk-ts/commit/1dc9979125df7964c189ee0f81387c79f60820a6))
* **tools:** recognise a seam the daemon declined, and surface its reason ([#5](https://github.com/zeroroot-ai/sdk-ts/issues/5)) ([4915bc4](https://github.com/zeroroot-ai/sdk-ts/commit/4915bc4fdde19f183bdd33fd4fedf0d956e63dde))


### Bug Fixes

* **auth:** normalize platform URL so the CG-JWT aud matches the ext-authz pin ([#8](https://github.com/zeroroot-ai/sdk-ts/issues/8)) ([f514aab](https://github.com/zeroroot-ai/sdk-ts/commit/f514aaba0b5ca53ca01d413f1a874cdf947ca115)), closes [#7](https://github.com/zeroroot-ai/sdk-ts/issues/7)
* **ci:** pin all GitHub Actions to full commit SHAs ([#17](https://github.com/zeroroot-ai/sdk-ts/issues/17)) ([1c127eb](https://github.com/zeroroot-ai/sdk-ts/commit/1c127eb39aa526984bdcbacc5420c70978279bd8))
* **ci:** run release-please as the zeroday-sdk-fanout App ([#21](https://github.com/zeroroot-ai/sdk-ts/issues/21)) ([4d6585c](https://github.com/zeroroot-ai/sdk-ts/commit/4d6585c1a43bb11471c5f898553382d92ba84dad))
* **component:** one instance identity per process ([#6](https://github.com/zeroroot-ai/sdk-ts/issues/6)) ([5b7ee82](https://github.com/zeroroot-ai/sdk-ts/commit/5b7ee8221640fdaadade2dcaca716c013a8d3c06))
* **gen:** regenerate src/gen from BSR and add a daily drift check ([#22](https://github.com/zeroroot-ai/sdk-ts/issues/22)) ([7768688](https://github.com/zeroroot-ai/sdk-ts/commit/7768688d707b8bcf9fb546569f29421f5583a505)), closes [#20](https://github.com/zeroroot-ai/sdk-ts/issues/20)
* **release:** keep the first release pre-1.0 ([#23](https://github.com/zeroroot-ai/sdk-ts/issues/23)) ([6776ec4](https://github.com/zeroroot-ai/sdk-ts/commit/6776ec446d215a469214537988ac8b688566ba68)), closes [#15](https://github.com/zeroroot-ai/sdk-ts/issues/15)
* **shim:** send a tool result as a user turn, not a tool-role turn ([#18](https://github.com/zeroroot-ai/sdk-ts/issues/18)) ([c5614ac](https://github.com/zeroroot-ai/sdk-ts/commit/c5614ac837957aa991d0cdffa6a3fda17973bce5))
* use the bootstrap token for first check-in only, then the host key ([#2](https://github.com/zeroroot-ai/sdk-ts/issues/2)) ([988da9e](https://github.com/zeroroot-ai/sdk-ts/commit/988da9e9873611d918fb19d9ebd7aedac81fd4d4))
