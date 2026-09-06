// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import { homedir } from "node:os"
import { join } from "node:path"
import type { Gibson } from "../session.js"
import type { FindingsBackend } from "./findings.js"
import { gibsonFindingsBackend, localFindingsBackend, taskFindingsBackend } from "./findings.js"

/** What every helper tool is built from. Decided once per posture. */
export interface HelperContext {
  gibson: Gibson
  /** The working directory a componentize writes into. */
  cwd: string
  env: NodeJS.ProcessEnv
  /** Where a finding lands in this posture. */
  findings: FindingsBackend
}

export function helperContext(gibson: Gibson, cwd: string, env: NodeJS.ProcessEnv): HelperContext {
  return { gibson, cwd, env, findings: findingsBackendFor(gibson, env) }
}

/**
 * A finding always has somewhere to go. Under a task grant it is the typed
 * callback RPC; as a checked-in component it is ComponentService; with no
 * platform it is a local JSONL log, so a standalone session still records
 * what it found instead of dropping it.
 */
export function findingsBackendFor(gibson: Gibson, env: NodeJS.ProcessEnv): FindingsBackend {
  if (gibson.live) return taskFindingsBackend(gibson.live.harness)
  if (gibson.session) return gibsonFindingsBackend(gibson.session)
  return localFindingsBackend(env.ZEROCOOL_FINDINGS_LOG ?? join(homedir(), ".zerocool", "findings.jsonl"))
}
