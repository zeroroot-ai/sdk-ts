// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

// @zeroroot-ai/sdk — typed access to the Gibson daemon.
// connect-es bindings are generated from BSR (buf.build/zeroroot-ai/sdk) under ./gen.
export * from "./clients.js"
export * from "./component.js"
export * from "./connect.js"
export * from "./auth/index.js"
export * from "./openai-shim.js"
// Depth-2 surfaces (zerocool-plugins#7-#11).
export * from "./finding.js"
export * from "./knowledge.js"
export * from "./tools.js"
export * from "./delegate.js"
export * from "./componentize.js"
export * from "./work.js"
export * from "./callback.js"
export * from "./task-knowledge.js"
// Originating a checked-in catalog mission by name (gibson#1688, ADR-0018).
export * from "./task-mission.js"
// Live sessions (zeroroot-ai/sdk-ts#33): task harness with renewal, one mission per session.
export * from "./task-harness.js"
export * from "./live-mission.js"
export * from "./observe.js"
export * from "./sandbox.js"
