# Changelog

## [0.2.0](https://github.com/zeroroot-ai/sdk-ts/compare/gibson-mcp-v0.1.0...gibson-mcp-v0.2.0) (2026-09-01)


### Features

* **gibson-mcp:** two tiers: helpers and discovered tools in front, the 188 generated RPC tools behind a search and call pair ([#71](https://github.com/zeroroot-ai/sdk-ts/issues/71)) ([0317f52](https://github.com/zeroroot-ai/sdk-ts/commit/0317f52762cf1f8c9180908e566c3026f80896fb))


### Bug Fixes

* **ci:** the drift guards were blind to a service that never reached the table ([#68](https://github.com/zeroroot-ai/sdk-ts/issues/68)) ([f355d0c](https://github.com/zeroroot-ai/sdk-ts/commit/f355d0c7862908ef18633631d56b354ad1ce7392))

## 0.1.0 (2026-09-01)


### Features

* **gibson-mcp:** ambient knowledge as an MCP resource and prompt, release train, and CI drift guard ([#66](https://github.com/zeroroot-ai/sdk-ts/issues/66)) ([8c24e50](https://github.com/zeroroot-ai/sdk-ts/commit/8c24e50952d13a468a5f7bb117a489538d77c6b5))
* **gibson-mcp:** generate one MCP tool per RPC of every SDK service from the proto descriptors, with a drift guard ([#63](https://github.com/zeroroot-ai/sdk-ts/issues/63)) ([62f4ab4](https://github.com/zeroroot-ai/sdk-ts/commit/62f4ab4d60737bc308aad9f4c8bbdf78b4fba45b))
* **gibson-mcp:** one tool per SDK helper, plus runtime discovery of checked-in platform tools ([#64](https://github.com/zeroroot-ai/sdk-ts/issues/64)) ([222f0ea](https://github.com/zeroroot-ai/sdk-ts/commit/222f0eaddcbe52f761a90fbcabd369587ae2a4e9))
* **gibson-mcp:** package skeleton: stdio and streamable-HTTP transports, three check-in sources, gibson_status ([#61](https://github.com/zeroroot-ai/sdk-ts/issues/61)) ([5152d5b](https://github.com/zeroroot-ai/sdk-ts/commit/5152d5b2a502a2391574df5f8dd8cbefab3ad17e))
* **gibson-mcp:** per-turn grant over streamable HTTP, SubscribeInput client, and the `ask` permission-prompt tool ([#65](https://github.com/zeroroot-ai/sdk-ts/issues/65)) ([8034ea4](https://github.com/zeroroot-ai/sdk-ts/commit/8034ea446e02d273a5f0ea8e38466c7076265c70))
* **gibson-mcp:** regenerate from BSR v0.177.0 and wire the inbox to the published job types ([#67](https://github.com/zeroroot-ai/sdk-ts/issues/67)) ([b44ff54](https://github.com/zeroroot-ai/sdk-ts/commit/b44ff548ef7a930b89b0eaff1ceb10f284b80704))
