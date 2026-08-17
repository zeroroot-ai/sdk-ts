import { createGrpcTransport } from "@connectrpc/connect-node"
import { createClient, type Client, type Interceptor } from "@connectrpc/connect"
import { HarnessCallbackService } from "./clients.js"

/**
 * The task-scoped callback harness (zerocool-plugins#33 follow-up).
 *
 * A dispatched agent does NOT reach harness operations the way a long-lived
 * component does. gibson mints a per-dispatch capability grant and sends it on
 * the work item as `callback_endpoint` + `callback_token`
 * (`gibson.agent.v1.ExecuteRequest`), so that the run reaches LLM, tools,
 * findings and delegation **as the task** rather than as the component that
 * happens to be serving it. Using the component's own grant instead is a real
 * authority gap: broader rights than the dispatch intends, and no per-task
 * attribution on anything the run does.
 *
 * TWO AUTH LEGS, AND THEY ARE NOT SYMMETRIC. Getting this backwards produces a
 * client that 401s on every call, so it is worth stating plainly:
 *
 *   - **Component RPCs** go through the Envoy edge and carry the Capability
 *     Grant JWT in the dedicated `x-capability-grant` header. `Authorization` is
 *     reserved there for Zitadel user/service tokens — Envoy's `jwt_authn`
 *     validates those, and a CG token in that header is not ignored, it fails
 *     validation and the call dies at the edge (see `auth/client.ts`).
 *   - **Callback RPCs** dial the daemon's own harness callback listener
 *     directly, not through `jwt_authn`, and carry the task token as
 *     `authorization: Bearer <token>`. That is the contract the Go SDK's
 *     `CallbackClient` already implements
 *     (`opensource/sdk/serve/callback_client.go:245-254`), and both ends must
 *     agree.
 *
 * ENDPOINT FORM. `callback_endpoint` is a bare gRPC dial target, not a URL —
 * gibson's `CallbackManager.CallbackEndpoint()` returns things like
 * `gibson:50001` or `localhost:50001`. connect-node needs a `baseUrl`, so
 * {@link callbackBaseUrl} adds a scheme when there is none. It defaults to
 * `https:` because the daemon's callback listener requires mTLS in every
 * deployment that has a trust domain; plaintext is opt-in via `insecure`, for a
 * local or kind daemon started without TLS.
 */

/**
 * Attach the task-scoped grant. `authorization`, NOT `x-capability-grant` — see
 * the module note. Exported so a caller building its own transport (a different
 * credential source, extra interceptors) gets the header right rather than
 * reimplementing it, and so the header itself is directly testable.
 */
export function callbackAuthInterceptor(token: string): Interceptor {
  return (next) => async (req) => {
    req.header.set("authorization", `Bearer ${token}`)
    return await next(req)
  }
}

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

/**
 * Connect a HarnessCallbackService client bound to one dispatched task.
 *
 * Use it from an agent worker's handler, with the fields
 * {@link ./work.js#AgentInvocation} decoded off the work item:
 *
 * ```ts
 * const harness = connectTaskHarness({
 *   endpoint: invocation.callbackEndpoint,
 *   token: invocation.callbackToken,
 * })
 * ```
 *
 * Returns undefined-free: a dispatch that carries no callback seam is a caller
 * error here, not something to paper over with a component-scoped fallback —
 * silently widening authority is the bug this function exists to remove. Check
 * `invocation.callbackEndpoint` before calling.
 */
export function connectTaskHarness(config: TaskHarnessConfig): Client<typeof HarnessCallbackService> {
  if (!config.token) {
    throw new Error(
      "gibson-sdk: callback token is empty — refusing to dial the harness unauthenticated " +
        "(a dispatch without a task grant must fail, not fall back to the component's own)",
    )
  }
  const transport = createGrpcTransport({
    baseUrl: callbackBaseUrl(config.endpoint, config.insecure),
    interceptors: [callbackAuthInterceptor(config.token)],
  })
  return createClient(HarnessCallbackService, transport)
}
