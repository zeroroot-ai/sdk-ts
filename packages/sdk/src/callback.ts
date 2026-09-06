// SPDX-License-Identifier: Elastic-2.0
// Copyright 2026 Zero Root AI

/**
 * The task-scoped callback seam: endpoint form only.
 *
 * A dispatched agent reaches harness operations as the task, not as the
 * component that serves it. gibson mints a per-dispatch capability grant and
 * sends it on the work item as `callback_endpoint` + `callback_token`
 * (`gibson.agent.v1.ExecuteRequest`). The harness that presents that grant,
 * derives `ContextInfo` from it and renews it lives in `task-harness.ts`.
 *
 * ENDPOINT FORM. `callback_endpoint` is a bare gRPC dial target, not a URL:
 * gibson's `CallbackManager.CallbackEndpoint()` returns things like
 * `gibson:50001` or `localhost:50001`. connect-node needs a `baseUrl`, so
 * {@link callbackBaseUrl} adds a scheme when there is none. It defaults to
 * `https:` because the route is the Envoy edge in every deployment that has a
 * trust domain (gibson#1450). Plaintext is opt-in through `insecure`, for a
 * local or kind daemon started without TLS.
 */

/**
 * Strip trailing slashes without a regex.
 *
 * `replace(/\/+$/, "")` is the obvious spelling and it is quadratic on a string
 * of many slashes — the regex engine retries the `+` from each start position.
 * CodeQL flags it as a polynomial ReDoS, and it is right to: this input arrives
 * off the wire. A character scan is linear and says the same thing.
 */
function stripTrailingSlashes(s: string): string {
  let end = s.length
  while (end > 0 && s.charCodeAt(end - 1) === 47 /* "/" */) end -= 1
  return s.slice(0, end)
}

/**
 * Turn a `callback_endpoint` into a connect-node `baseUrl`.
 *
 * A value that already carries an http(s) scheme is passed through untouched
 * (minus a trailing slash), so a daemon that advertises a full URL keeps
 * working. A bare `host:port` gains a scheme.
 */
export function callbackBaseUrl(endpoint: string, insecure = false): string {
  const raw = endpoint.trim()
  if (!raw) throw new Error("gibson-sdk: callback endpoint is empty")

  if (/^https?:\/\//i.test(raw)) return stripTrailingSlashes(raw)

  // Reject anything that looks like a different protocol rather than silently
  // gluing "https://" onto it and producing an unresolvable host.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    throw new Error(
      `gibson-sdk: callback endpoint ${JSON.stringify(endpoint)} must be http(s) or a bare host:port`,
    )
  }
  return `${insecure ? "http" : "https"}://${stripTrailingSlashes(raw)}`
}

export interface TaskHarnessConfig {
  /** `ExecuteRequest.callback_endpoint` — a bare `host:port`, or a full http(s) URL. */
  endpoint: string
  /** `ExecuteRequest.callback_token` — the task-scoped capability grant. */
  token: string
  /**
   * Dial plaintext h2c when the endpoint carries no scheme. Defaults to false
   * (TLS). Only for a local daemon started without TLS.
   */
  insecure?: boolean
}
