// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { formatKnowledgeForPrompt, type KnowledgeSource } from "@zeroroot-ai/sdk"

/** How many hits the ambient block carries. Small: it is prompt overhead on every session. */
const AMBIENT_LIMIT = 5

/**
 * One GraphRAG lookup per session, read by a session-start hook or the gibson://ambient resource. A
 * knowledge failure never breaks a start: the agent works without prior
 * context, it just works less well.
 */
export async function ambientBlock(knowledge: KnowledgeSource, seedQuery: string): Promise<string> {
  try {
    const hits = await knowledge.query({ text: seedQuery, topK: AMBIENT_LIMIT })
    const body = formatKnowledgeForPrompt(hits)
    return body ? `Prior context from the Gibson knowledge graph (recall for more):\n${body}` : ""
  } catch {
    return ""
  }
}
