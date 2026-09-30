# @simular-ai/sai-mcp

Give your coding agent a computer. This MCP server lets Claude Code, Codex,
Cursor or any MCP client hand tasks to [Sai](https://www.simular.ai), Simular's
computer-use agent. Sai does the work on a real desktop (a browser, native
apps, files) and reports back. Sai runs on a cloud computer we host; the free
plan includes one.

You need Node.js 22.12 or newer and a Sai API key (`sapi_…`). Sign in at
[platform.simular.ai](https://platform.simular.ai) and create one under
[API Keys](https://platform.simular.ai/api-keys). It is shown once.

Docs: [docs.simular.ai/sai-api](https://docs.simular.ai/sai-api/introduction)

## Install

Replace `sapi_YOUR_KEY` with your key.

### Claude Code

```bash
claude mcp add sai -e SAI_API_KEY=sapi_YOUR_KEY -- npx -y @simular-ai/sai-mcp
```

Optional: install the `sai` skill, which teaches Claude Code how to run a task
from start to finish, including when the MCP server isn't loaded:

```bash
npx -y @simular-ai/sai-mcp init-claude            # ~/.claude/skills/sai
npx -y @simular-ai/sai-mcp init-claude --project  # ./.claude/skills/sai
```

It never overwrites a `SKILL.md` you edited; `--force` does.

### Codex

```bash
codex mcp add sai --env SAI_API_KEY=sapi_YOUR_KEY -- npx -y @simular-ai/sai-mcp
```

Or in `~/.codex/config.toml`:

```toml
[mcp_servers.sai]
command = "npx"
args = ["-y", "@simular-ai/sai-mcp"]

[mcp_servers.sai.env]
SAI_API_KEY = "sapi_YOUR_KEY"
```

### Cursor

In `~/.cursor/mcp.json` (or `.cursor/mcp.json` in a project), then restart Cursor:

```json
{
  "mcpServers": {
    "sai": {
      "command": "npx",
      "args": ["-y", "@simular-ai/sai-mcp"],
      "env": { "SAI_API_KEY": "sapi_YOUR_KEY" }
    }
  }
}
```

The same block works for any client that runs stdio MCP servers.

### Try it

Ask your agent something like:

> Use Sai to open Notepad on my cloud computer, type "Hello from Sai", and tell me the window title.

## Tools

| Tool               | What it does                                                               |
| ------------------ | -------------------------------------------------------------------------- |
| `sai_machines`     | Lists your computers. Skip it when you have one.                           |
| `sai_models`       | Lists the models Sai can use on your plan.                                 |
| `sai_task_start`   | Hands Sai a task in plain English. Returns a `session_id` right away.      |
| `sai_task_wait`    | Waits for progress: `running`, `needs_approval`, `idle` (done) or `error`. |
| `sai_task_approve` | Answers a permission request: `approve`, `approve_for_task` or `deny`.     |
| `sai_task_abort`   | Stops a task.                                                              |
| `sai_upload`       | Uploads a local file so a task can use it.                                 |

A task keeps running on the computer between calls. When Sai asks for
something only you can do, such as signing in to an account, your agent gives
you a link to finish it and keeps waiting. Sai remembers earlier tasks on the
same computer; `new_session: true` starts fresh.

There is no screenshot tool: Sai sees the screen itself and reports in text.
Watch it work live in the [Playground](https://platform.simular.ai/playground).

## Environment

| Variable      | Required | Meaning                                                              |
| ------------- | -------- | -------------------------------------------------------------------- |
| `SAI_API_KEY` | yes      | Your Sai API key (`sapi_…`).                                         |
| `SAI_PUSH`    | no       | `1` turns on Claude Code channels (below). Leave it unset otherwise. |

## Claude Code channels (research preview)

With [channels](https://code.claude.com/docs/en/channels), results are pushed
into your Claude Code session instead of your agent polling for them, so it can
carry on with other work during a long task. Only Claude Code supports this;
Codex and Cursor poll, which works everywhere.

```bash
claude mcp add sai -e SAI_API_KEY=sapi_YOUR_KEY -e SAI_PUSH=1 -- npx -y @simular-ai/sai-mcp
claude --dangerously-load-development-channels server:sai
```

Only set `SAI_PUSH=1` together with that flag. Without it, pushed results are
dropped and your agent is told not to poll.

## Support

[support@simular.ai](mailto:support@simular.ai)
