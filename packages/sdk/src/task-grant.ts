// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

import type { Client, Transport } from "@connectrpc/connect"
import { createClient } from "@connectrpc/connect"
import { DaemonService } from "./gen/gibson/daemon/v1/daemon_pb.js"
import { GATEWAY_GRANT_HEADER, NoGatewayGrantError, type HeaderFunc } from "./gateway.js"
import { decodeGrantClaims } from "./task-harness.js"

/** The SDK renews a task grant when it has less than this time left. */
export const GRANT_RENEW_BEFORE_MS = 2 * 60 * 1000

/** Get a new task grant for the task of the current grant. */
export type GrantRenewer = (current: string) => Promise<string>

/**
 * The task grant of one work item. The daemon gives it in
 * `PollWorkResponse.task_grant`. The SDK sends it in `x-capability-grant` on
 * each call to a gateway. Within 2 minutes of the expiry it calls
 * `RenewCapabilityGrant` first. If the renewal fails and the grant has not
 * ended, it keeps the grant. If the grant has ended, `get` throws an error that
 * names the renewal failure. A work item with no grant gives
 * {@link NoGatewayGrantError}.
 */
export class TaskGrant {
  private token: string
  private inFlight: Promise<string> | undefined

  constructor(
    token: string,
    private readonly renew?: GrantRenewer,
    private readonly now: () => number = Date.now,
  ) {
    this.token = token
  }

  /** Return the grant to send now. */
  async get(): Promise<string> {
    if (!this.token) throw new NoGatewayGrantError()
    const claims = decodeGrantClaims(this.token)
    const expiresAt = claims.exp * 1000
    if (!claims.exp || this.now() + GRANT_RENEW_BEFORE_MS < expiresAt) return this.token
    if (!this.renew) return this.token
    this.inFlight ??= this.renew(this.token).finally(() => {
      this.inFlight = undefined
    })
    try {
      this.token = await this.inFlight
      return this.token
    } catch (cause) {
      // A grant that has not ended still works. One that has ended does not.
      if (this.now() < expiresAt) return this.token
      throw new Error(`the task grant has ended and the renewal failed: ${(cause as Error).message}`, { cause })
    }
  }

  /** A {@link HeaderFunc} that sends the current grant in `x-capability-grant`. */
  headers(): HeaderFunc {
    return async () => ({ [GATEWAY_GRANT_HEADER]: await this.get() })
  }
}

/**
 * Make a renewer that calls `DaemonService.RenewCapabilityGrant`. It reads
 * `agent_id`, `mission_id` and `task_id` from the claims `sub`, `mission_id`
 * and `task_id` of the current grant. It presents the current grant in
 * `x-capability-grant` on that one call. That header replaces the per-RPC
 * token of the connection for the call.
 */
export function daemonGrantRenewer(transport: Transport): GrantRenewer {
  const daemon: Client<typeof DaemonService> = createClient(DaemonService, transport)
  return async (current) => {
    const claims = decodeGrantClaims(current)
    const res = await daemon.renewCapabilityGrant(
      { agentId: claims.sub, missionId: claims.missionId, taskId: claims.taskId },
      { headers: { [GATEWAY_GRANT_HEADER]: current } },
    )
    if (!res.capabilityGrant) throw new Error("RenewCapabilityGrant returned no grant")
    return res.capabilityGrant
  }
}
