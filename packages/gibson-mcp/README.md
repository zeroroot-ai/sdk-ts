# @zeroroot-ai/gibson-mcp

The Gibson MCP server. One tool surface for every coding agent host: Claude
Code, opencode, Cursor, Codex CLI, Gemini CLI and Windsurf. The host is a thin
adapter and holds no tools of its own.

## Install

Every host runs it through `npx`, so nothing has to be installed by hand.
This is the canonical block. It is the same for every host that reads the
`mcpServers` shape.

```json
{
  "mcpServers": {
    "gibson": {
      "command": "npx",
      "args": ["--yes", "--package", "@zeroroot-ai/gibson-mcp@latest", "gibson-mcp"]
    }
  }
}
```

| Host | Where the block goes |
|---|---|
| Claude Code | `.mcp.json` in the project, or the `zerocool` plugin, which carries it |
| opencode | the `zerocool` opencode plugin, which carries it |
| Cursor | `.cursor/mcp.json` |
| Codex CLI | `~/.codex/config.toml`, as a `[mcp_servers.gibson]` table with the same command and args |
| Gemini CLI | `~/.gemini/settings.json`, under `mcpServers` |
| Windsurf | `~/.codeium/windsurf/mcp_config.json`, under `mcpServers` |

A host is an adapter and holds no tools of its own (ADR-0008). The per-host
snippets and their smoke tests live in
[`zerocool-plugins`](https://github.com/zeroroot-ai/zerocool-plugins).

## The tool surface

Coverage is 1:1 with everything the SDK produces. **Exposure** is in two
tiers, because 188 tool descriptions on every turn cost more context than
they are worth, bury the tools an agent reaches for, and trip the tool cap
some hosts impose.

### Front tier, in `tools/list`

| Where a tool comes from | Naming | How many |
|---|---|---|
| every SDK helper | the helper's own name: `remember`, `recall`, `world_view`, `submit_finding`, `delegate` | 30 |
| every checked-in platform tool and plugin, discovered at runtime | `gibson_<tool>`, `gibson_plugin_<plugin>` | whatever the tenant has |
| the session's own tools | `gibson_status`, `gibson_login`, `gibson_connect`, `gibson_call_tool`, `ask` | 5 |
| the door to the full API | `gibson_api_search`, `gibson_api_call` | 2 |

Discovery repeats every 60 seconds and emits `tools/list_changed`, so a tool
a person enrols now is callable in the same session.

### Full tier, behind the door

Every RPC of every SDK service, generated from the proto descriptors and
named `<service>_<method>` in snake case: **188 across 12 services** today.
They are all built and all callable. They are simply not listed.

```
gibson_api_search("")                    -> the 12 services, with a count each
gibson_api_search("open a job on a bank") -> job_service_open_job, with its input schema
gibson_api_call("job_service_open_job", {...})
```

`gibson_api_search` ranks on the RPC name, the service name and the proto
comment, and returns each match with its exact tool name, its description,
its service and the **full input JSON schema**, so one search is enough to
make the call. An empty query lists the services instead, so an agent can
orient before it searches. `gibson_api_call` runs the same handler the flat
tier would register, so the two paths cannot disagree; an unknown name comes
back with the three closest.

An SDK bump regenerates the full tier. A drift guard fails CI when the
generated table and the descriptors disagree, in either direction, so
hiding a tool never means losing one.

### `--expose-all-rpcs`

Registers the full tier in `tools/list` as well, which is what the server
did before this became two tiers. Off by default. A host with a large
context window and no tool cap can take the flat 1:1 surface. The door stays
open with the flag on, because finding one RPC among 188 is still cheaper
through a search than through the list.

A posture registers only the tools its credential can reach. With no
platform the server still serves `submit_finding`, `componentize` and
`validate_component`, plus `gibson_login` and `gibson_connect`, and no RPC
tool at all: a tool with no daemon behind it answers every call with a dial
error, which reads to a model like a broken platform rather than an
unconnected session.

## Resources and prompts

| URI | What it holds |
|---|---|
| `gibson://ambient` | one GraphRAG lookup per session: what the tenant already knows about this codebase |
| `gibson://session` | the check-in source, the posture, and the mission, run and callback endpoint a session-end hook needs |

A host with a hook surface injects the ambient block itself. A host without
one calls the `gibson_ambient` prompt instead. Either way it is one lookup.

## Transports

| Flag | Where it runs | Why |
|---|---|---|
| `--transport stdio` (default) | a laptop | the host spawns the server and owns its lifetime |
| `--transport http --listen 127.0.0.1:7788` | a sandbox | one server for the life of the sandbox, so the driver can swap the grant per turn |

`--listen` accepts a loopback address only, and DNS rebinding protection is
on. `--stream-limit` (default 500) caps how many messages a server-streaming
RPC tool returns before it reports `truncated`. `--expose-all-rpcs` lists the
full RPC tier as well; see the tool surface below.

### The HTTP routes

| Route | What it does |
|---|---|
| `POST /mcp` | starts an MCP session with `initialize`; later requests carry `mcp-session-id` |
| `GET /mcp` | the session's notification stream |
| `DELETE /mcp` | ends a session |
| `GET /healthz` | liveness, plus the check-in source, the posture, the listed tool count, the reachable RPC count and the open job |
| `POST /turn` | puts a dispatch's grant in force |
| `GET /turn` | reports the turn in force |
| `DELETE /turn` | ends it |

### Per-turn grants

A member sandbox serves many dispatches over its life, and each input
message carries the task grant of its own dispatch. The driver calls
`POST /turn` before it feeds Claude a message:

```
POST /turn
{"job_id": "job-1", "grant": "<CG-JWT>", "callback_endpoint": "daemon:50001"}
-> 200 {"job_id": "job-1", "endpoint": "daemon:50001"}
```

Every tool call that follows runs under that grant. `DELETE /turn` ends the
turn, and calls fall back to the **base grant** from the launch, which is
used for the lifetime RPCs only: the inbox subscription, reading repository
credentials, and the checkpoint writes. A single request may instead carry
`x-gibson-turn-grant`, which applies to that request alone and wins over the
turn in force; that is how a driver runs two turns at once.

Both `job_id` and `grant` are required. A grant with no job attributes the
work to nothing.

`/turn` exists only where there is a task grant to swap. Elsewhere it is a
404.

## Check-in sources

The server picks one credential source at start from what is present. It never
mixes them, and it never mints identity.

1. **Dispatched grant.** `GIBSON_CG_JWT` and `GIBSON_CALLBACK_ENDPOINT` are
   set, so the daemon launched this process. The server joins the run it was
   launched for. No enrollment, no state file, no mission. This source wins
   over every other.
2. **Pre-minted token.** `GIBSON_BOOTSTRAP_TOKEN` is set and this host has no
   key yet. The server checks in once with the token. The host key carries
   every later start, and the token is spent.
3. **Enrolled host key.** The key at `GIBSON_HOST_KEY_PATH` (default
   `~/.zerocool/host.key`) is the credential.
4. **Nothing yet.** The server offers `gibson_login` and `gibson_connect`: a
   person signs in through the `gibson` CLI device flow, and the server
   enrolls the host, picks the target and starts the live mission without a
   restart.

Call `gibson_status` to see the source, the posture, the platform, the tenant,
the target and the mission.

## Postures

A platform the server cannot reach never stops a session. Each posture below
carries fewer tools than the one before it.

- `task`: a dispatched run. Reads and writes use the dispatch grant.
- `live`: checked in, and this session is a mission of its own.
- `component`: checked in, no mission. Reads and findings only.
- `standalone`: no platform. Findings go to a local log.

## Environment

| Variable | Meaning |
|---|---|
| `GIBSON_PLATFORM_URL` | the platform to check in to |
| `GIBSON_TARGET_ID` | the target the live mission binds to |
| `GIBSON_BOOTSTRAP_TOKEN` | a one-time enrollment token |
| `GIBSON_HOST_KEY_PATH` | the host key (default `~/.zerocool/host.key`) |
| `GIBSON_CA_CERT` | a private CA to trust |
| `GIBSON_CALLBACK_INSECURE` | `1` dials the callback endpoint without TLS. Local daemons only. |
| `ZEROCOOL_STATE_DIR` | the state directory (default `~/.zerocool`) |

## License

MIT.
