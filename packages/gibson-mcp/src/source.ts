// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * The check-in source: how this server gets its credential (gibson#1706,
 * decision 4). Three, chosen by what is present at start, never mixed.
 *
 *  - `dispatched`: the daemon launched the process. `GIBSON_CG_JWT` and
 *    `GIBSON_CALLBACK_ENDPOINT` are the only credential. The server joins
 *    the run it was launched for: no enrollment, no state file, no mission.
 *  - `bootstrap`: a person minted a one-time bootstrap token earlier and this
 *    host has no key yet. The server checks in unattended with it once, and
 *    the host key carries every later start.
 *  - `enrolled`: the host key exists. The server checks in with it.
 *  - `none`: nothing is present. The server exposes `gibson_login` and
 *    `gibson_connect`, the device flow through the `gibson` CLI, and a person
 *    enrolls the host in the session.
 *
 * Priority: dispatched wins. The server never mints identity (ADR-0045).
 */
export type CheckInSource = "dispatched" | "bootstrap" | "enrolled" | "none"

export interface SourceInputs {
  grant?: string
  callbackEndpoint?: string
  bootstrapToken?: string
  hostKeyExists: boolean
}

export interface SourceDecision {
  source: CheckInSource
  /** What was present but ignored, one line each, for the log. */
  notes: string[]
}

export function decideSource(i: SourceInputs): SourceDecision {
  const notes: string[] = []
  if (i.grant && i.callbackEndpoint) {
    if (i.hostKeyExists) notes.push("a host key exists, but the dispatched grant wins; the host key is ignored")
    if (i.bootstrapToken) notes.push("GIBSON_BOOTSTRAP_TOKEN is set, but the dispatched grant wins; the token is ignored")
    return { source: "dispatched", notes }
  }
  if (i.grant) notes.push("GIBSON_CG_JWT is set without GIBSON_CALLBACK_ENDPOINT; the grant is ignored")
  if (i.callbackEndpoint) notes.push("GIBSON_CALLBACK_ENDPOINT is set without GIBSON_CG_JWT; the endpoint is ignored")
  if (i.hostKeyExists) {
    if (i.bootstrapToken) {
      notes.push("GIBSON_BOOTSTRAP_TOKEN is set, but this host has a key; the token is ignored (a one-time token cannot be replayed)")
    }
    return { source: "enrolled", notes }
  }
  if (i.bootstrapToken) return { source: "bootstrap", notes }
  return { source: "none", notes }
}
