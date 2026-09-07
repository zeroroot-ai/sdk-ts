# Changelog

## [0.12.1](https://github.com/zeroroot-ai/sdk-ts/compare/v0.12.0...v0.12.1) (2026-09-07)


### Bug Fixes

* **release:** one release PR per package so release-please can tag it ([#11](https://github.com/zeroroot-ai/sdk-ts/issues/11)) ([c7ba76e](https://github.com/zeroroot-ai/sdk-ts/commit/c7ba76e7a286c5406e772b43ce6a4b29d58ae6f3))
* **sdk:** linear-time path regex in auth client, pin and scope release workflow ([#9](https://github.com/zeroroot-ai/sdk-ts/issues/9)) ([07a7bdf](https://github.com/zeroroot-ai/sdk-ts/commit/07a7bdff36d8a6cdedc62177dc1d4768d838b693))

## [0.12.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.11.0...v0.12.0) (2026-09-01)


### Features

* **gibson-mcp:** generate one MCP tool per RPC of every SDK service from the proto descriptors, with a drift guard ([#63](https://github.com/zeroroot-ai/sdk-ts/issues/63)) ([62f4ab4](https://github.com/zeroroot-ai/sdk-ts/commit/62f4ab4d60737bc308aad9f4c8bbdf78b4fba45b))
* **gibson-mcp:** package skeleton: stdio and streamable-HTTP transports, three check-in sources, gibson_status ([#61](https://github.com/zeroroot-ai/sdk-ts/issues/61)) ([5152d5b](https://github.com/zeroroot-ai/sdk-ts/commit/5152d5b2a502a2391574df5f8dd8cbefab3ad17e))
* **gibson-mcp:** regenerate from BSR v0.177.0 and wire the inbox to the published job types ([#67](https://github.com/zeroroot-ai/sdk-ts/issues/67)) ([b44ff54](https://github.com/zeroroot-ai/sdk-ts/commit/b44ff548ef7a930b89b0eaff1ceb10f284b80704))

## [0.11.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.10.0...v0.11.0) (2026-08-30)


### Features

* **mission:** originate a checked-in catalog mission by name ([#54](https://github.com/zeroroot-ai/sdk-ts/issues/54)) ([cb56e5b](https://github.com/zeroroot-ai/sdk-ts/commit/cb56e5b0db7e6587b5ef70bf900503452edc8f79))

## [0.10.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.9.0...v0.10.0) (2026-08-30)


### Features

* **harness:** carry ApplicationFindings and the lifecycle entity observation ([#52](https://github.com/zeroroot-ai/sdk-ts/issues/52)) ([da1ab50](https://github.com/zeroroot-ai/sdk-ts/commit/da1ab501ef82b15128f0af59591ee1cc7c1d7446))

## [0.9.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.8.0...v0.9.0) (2026-08-29)


### Features

* **live-mission:** claim a queue dispatch by mission id, harness on the session grant ([#49](https://github.com/zeroroot-ai/sdk-ts/issues/49)) ([9aa1bb4](https://github.com/zeroroot-ai/sdk-ts/commit/9aa1bb4638e6a04056bf2248a02480a2f7901236))

## [0.8.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.7.1...v0.8.0) (2026-08-29)


### Features

* **live-mission:** the person originates the session mission ([#47](https://github.com/zeroroot-ai/sdk-ts/issues/47)) ([5101255](https://github.com/zeroroot-ai/sdk-ts/commit/5101255a190bf3ee3a1020a3382ba2197e135bf9))

## [0.7.1](https://github.com/zeroroot-ai/sdk-ts/compare/v0.7.0...v0.7.1) (2026-08-29)


### Bug Fixes

* bound the grant renewal timer and let it not hold the process ([#45](https://github.com/zeroroot-ai/sdk-ts/issues/45)) ([fa7c520](https://github.com/zeroroot-ai/sdk-ts/commit/fa7c520cd8745df8242a0201707e18e5bc05bc27))

## [0.7.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.6.1...v0.7.0) (2026-08-29)


### Features

* readSandboxDispatch, the sandboxed-dispatch env contract as gibson writes it ([#43](https://github.com/zeroroot-ai/sdk-ts/issues/43)) ([5c82120](https://github.com/zeroroot-ai/sdk-ts/commit/5c82120c3128ba19fc806fb8c0497f79514a6854))

## [0.6.1](https://github.com/zeroroot-ai/sdk-ts/compare/v0.6.0...v0.6.1) (2026-08-28)


### Bug Fixes

* **package:** declare the repository so provenance verifies ([#41](https://github.com/zeroroot-ai/sdk-ts/issues/41)) ([6fecd32](https://github.com/zeroroot-ai/sdk-ts/commit/6fecd328c40237e3b4cd55bc43eb828293e1858c)), closes [#36](https://github.com/zeroroot-ai/sdk-ts/issues/36)

## [0.6.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.5.0...v0.6.0) (2026-08-28)


### Features

* export WorldEntityKind beside observe() ([#39](https://github.com/zeroroot-ai/sdk-ts/issues/39)) ([f087c5a](https://github.com/zeroroot-ai/sdk-ts/commit/f087c5a87de79972bdd2c2309311e3e989f8d2ff))
* TaskHarness carries the callback endpoint it dials ([#37](https://github.com/zeroroot-ai/sdk-ts/issues/37)) ([7183641](https://github.com/zeroroot-ai/sdk-ts/commit/718364111662faa857b24748cbc9bd49609cedf5))

## [0.5.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.4.0...v0.5.0) (2026-08-28)


### Features

* task harness with grant renewal, live-mission helpers, observe() and remember() ([#34](https://github.com/zeroroot-ai/sdk-ts/issues/34)) ([bb2d0ae](https://github.com/zeroroot-ai/sdk-ts/commit/bb2d0ae851887238f013a09b54d3682c0e084cff))

## [0.4.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.3.0...v0.4.0) (2026-08-17)


### Features

* **knowledge:** componentKnowledge, the interactive counterpart ([#30](https://github.com/zeroroot-ai/sdk-ts/issues/30)) ([6643a6c](https://github.com/zeroroot-ai/sdk-ts/commit/6643a6c19a76bcf22c58e8eeb43899ea44b392c3))

## [0.3.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.2.0...v0.3.0) (2026-08-17)


### Features

* **callback:** dial the harness with the task grant, not the component's ([#27](https://github.com/zeroroot-ai/sdk-ts/issues/27)) ([6afc7a4](https://github.com/zeroroot-ai/sdk-ts/commit/6afc7a4b8b4d8ff40caa6d7fbf17ecdbf8ddfe63))
* **knowledge:** read the graph over the task-scoped harness ([#29](https://github.com/zeroroot-ai/sdk-ts/issues/29)) ([5c44cec](https://github.com/zeroroot-ai/sdk-ts/commit/5c44cec46472ec7a33f0133ceb50c2a63d7f05e9))

## [0.2.0](https://github.com/zeroroot-ai/sdk-ts/compare/v0.1.0...v0.2.0) (2026-08-17)


### Features

* **work:** serve agent_execute work — the kind=agent dispatched shape ([#24](https://github.com/zeroroot-ai/sdk-ts/issues/24)) ([3b68e95](https://github.com/zeroroot-ai/sdk-ts/commit/3b68e956b2866cd3f9e6a0971a8608c68b4b4995))

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
