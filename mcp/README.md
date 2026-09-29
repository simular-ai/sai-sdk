# @simular-ai/sai-mcp

MCP server that lets a coding agent — Claude Code, Codex, Cursor, or any MCP
client — delegate work to [Sai](https://sai.simular.ai), Simular's
computer-use agent. Sai operates a real desktop (browser, native apps, files,
your logged-in accounts) on a machine registered to your account; this server
exposes that as six tools over stdio.

Requires Node.js 22.12 or newer and a Sai API key
(`sapi_…`, created at <https://sai.simular.ai/settings/api-keys>).

## Install

### Claude Code

```bash
claude mcp add sai -e SAI_API_KEY=sapi_... -- npx -y @simular-ai/sai-mcp
```

Optionally install the `sai` skill too (same as `simulang init-claude`). It
teaches the loop, and covers sessions where the MCP server is not loaded by
falling back to plain HTTP:

```bash
npx -y @simular-ai/sai-mcp init-claude            # ~/.claude/skills/sai
npx -y @simular-ai/sai-mcp init-claude --project  # ./.claude/skills/sai
npx -y @simular-ai/sai-mcp init-claude --check    # exit 1 when missing or stale
```

It never overwrites a `SKILL.md` you edited; `--force` does.

### Codex

`~/.codex/config.toml`:

```toml
[mcp_servers.sai]
command = "npx"
args = ["-y", "@simular-ai/sai-mcp"]

[mcp_servers.sai.env]
SAI_API_KEY = "sapi_..."
```

### Cursor

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "sai": {
      "command": "npx",
      "args": ["-y", "@simular-ai/sai-mcp"],
      "env": { "SAI_API_KEY": "sapi_..." }
    }
  }
}
```

The same JSON block works for any client that speaks stdio MCP.

## Environment

| Variable         | Required | Meaning                                                                                                                                            |
| ---------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SAI_API_KEY`    | yes      | A Sai API key (`sapi_…`) or a Firebase ID token. Sent as `Authorization: Bearer`.                                                                  |
| `SAI_API_URL`    | no       | Cloud API base URL. Default: production (`https://simular-cloud-api-149671192594.us-central1.run.app`).                                            |
| `SAI_PUSH`       | no       | `1` enables channel push (see below). Only with `--dangerously-load-development-channels server:sai`; otherwise results are dropped.               |
| `SAI_EVENTS_API` | no       | `1` switches to the `wait:false` + `GET /v1/agents/events` transport once cloud-api ships it. Default off: the SSE stream is collected in-process. |

## Tools

| Tool               | Input                                               | Output                                                                                       |
| ------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `sai_machines`     | —                                                   | `{ machines: [{ machineId, name, kind?, online? }], default? }` — `default` when exactly one |
| `sai_task_start`   | `{ task, machine_id?, file_ids?, new_session? }`    | `{ session_id, machine_id, queued, push }`                                                   |
| `sai_task_wait`    | `{ session_id, timeout_s? (90, max 110), cursor? }` | `{ status, events, text, approval?, cursor, error? }`                                        |
| `sai_task_approve` | `{ approval_id, decision, selections? }`            | `{ ok: true }` or `{ ok: false, reason: 'link_only', approval_url }`                         |
| `sai_task_abort`   | `{ session_id }`                                    | `{ ok, aborted, reason? }`                                                                   |
| `sai_upload`       | `{ path }`                                          | `{ file_id, name, mime, size }`                                                              |

`decision` is `approve` (this one request), `approve_for_task` (trust similar
requests for the rest of the task) or `deny`. `status` is `running`,
`needs_approval`, `idle` or `error`.

There is no screenshot tool: Sai sees the screen itself and reports back in
text.

## The loop

The server's `instructions` teach the model this loop; it is what you will see
it do:

1. `sai_machines` once — skip when the machine id is already known.
2. `sai_task_start { task }` → `session_id`. The task keeps running on the
   machine.
3. `sai_task_wait { session_id }` and repeat while `status` is `running`,
   passing back the `cursor` each time (each call blocks up to `timeout_s`,
   under Claude Code's two-minute tool limit).
   - `needs_approval`: read `approval`. If `isLinkOnly` is false, decide with
     `sai_task_approve`. If it is true (OAuth consent, credentials, phone
     verification) the model hands `approval.approvalUrl` to you and keeps
     waiting.
   - `idle`: `text` is Sai's answer.
   - `error`: `error` says what went wrong.
4. `sai_task_abort` to stop a task you no longer want.

One conversation per machine persists on Sai's `api` channel across calls, so
follow-up tasks can refer to earlier ones. `new_session: true` starts clean.

Files: `sai_upload` a local file first, then pass its `file_id` in
`sai_task_start.file_ids` (uploads are remembered for the lifetime of the
server process).

## Channels (Claude Code, research preview)

Claude Code [channels](https://code.claude.com/docs/en/channels) let a server
push events into the session instead of being polled. This server always
declares the `claude/channel` capability; with `SAI_PUSH=1` it also acts on it:
`sai_task_start` returns `push: true`, the model stops calling
`sai_task_wait`, and the server delivers `needs_approval`, `idle` and `error`
as `<channel source="sai" session_id=… event=… approval_id=… approval_url=…>`
notifications while Claude carries on with other work.

Constraints of the preview:

- Only Claude Code supports channels; Codex and Cursor poll (the default).
- Channels are allow-listed. Add the server with push on and load it as a
  development channel, which skips the allowlist after a confirmation prompt
  (the organization `channelsEnabled` policy still applies):

  ```bash
  claude mcp add sai -e SAI_API_KEY=sapi_... -e SAI_PUSH=1 -- npx -y @simular-ai/sai-mcp
  claude --dangerously-load-development-channels server:sai
  ```

  Never set `SAI_PUSH=1` without that flag: the model is told not to poll and
  the pushed results are dropped.

- Anthropic auth only.

Polling is the baseline and works everywhere; push is an optimisation for
long tasks.

## Development

From the monorepo root:

```bash
npm run test -w @simular-ai/sai-mcp       # vitest
npm run typecheck -w @simular-ai/sai-mcp
npm run build -w @simular-ai/sai-mcp      # dist/server.js (esbuild bundle)
SAI_API_KEY=... node packages/sai-mcp/dist/server.js   # run over stdio
```

Point at staging with `SAI_API_URL=https://staging.cloud-api.simular.cloud`.

## Releasing

Same as `sai-cli` (see `.github/workflows/publish-sai-mcp.yml`): bump `version`
in `package.json` and `SERVER_VERSION` in `src/server.ts`, merge, then
`git tag sai-mcp-vX.Y.Z && git push origin sai-mcp-vX.Y.Z`. CI publishes to npm
with trusted publishing (OIDC) and creates a GitHub release.
