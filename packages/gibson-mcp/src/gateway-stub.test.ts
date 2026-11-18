// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { GatewayCalls } from "@zeroroot-ai/sdk"

/**
 * Test helper: the gateway calls of a fake task harness. A test that reaches
 * one of them has a bug, so each call throws.
 */
export const gatewayStub: GatewayCalls = {
  resolveModel: () => Promise.reject(new Error("the fake harness has no model")),
  resolveAgent: () => Promise.reject(new Error("the fake harness has no agent")),
  model: () => Promise.reject(new Error("the fake harness has no model")),
  delegate: () => Promise.reject(new Error("the fake harness has no agent")),
}
