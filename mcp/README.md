# @simular-ai/sai-mcp

Give your coding agent a computer. This MCP server lets Claude Code, Codex,
Cursor or any MCP client hand tasks to [Sai](https://platform.simular.ai),
Simular's computer-use agent, #1 on OSWorld 2.0 (73%). Sai uses apps and
websites the way a person does, by seeing the screen, clicking and typing, so
your agent can get work done where there is no API: web apps behind a login,
admin consoles, desktop software, forms with no import. Sai runs on a
cloud computer we host; the free plan includes one.

Run a workflow once and Sai can save it as code: later runs replay that code
and ask the model only where the screen matters, so they are faster and
cheaper, and the agent takes over when the UI changes.

You need Node.js 22.12 or newer and a Sai API key (`sapi_…`). Sign in at
[platform.simular.ai](https://platform.simular.ai) and create one under
[API Keys](https://platform.simular.ai/api-keys). It is shown once.

Docs: [platform.simular.ai/documentation](https://platform.simular.ai/documentation)

## When to use Sai

Use Sai when:

- There is no API, or the API doesn't cover the task: vendor portals, admin
  consoles, legacy web apps.
- The task needs a real browser session with someone's accounts. Sign-ins,
  passwords and phone checks go to the human as an approval link.
- The work happens in a desktop app, on Windows, macOS or Linux.
- It is a one-off, and a script would cost more to write and keep working than
  the task itself.
- You need to see what a real user sees: testing a sign-up flow, reproducing a
  bug report.
- It is a workflow you will repeat (see below).

Write code yourself when a documented API or SDK does the job, the data is
already local, or you need exact, byte-for-byte output.

## Run once, replay as code

1. Run the task once with Sai.
2. Ask: `Save this as a replayable skill named invoice_export, with vendor and month as parameters.`
3. Next time: `Run invoice_export for vendor Acme, month March.` Sai replays
   the code; when a step breaks because the UI changed, the agent takes over.

The research behind it: [Neuro-Symbolic Computer Use](https://arxiv.org/abs/2609.36927)
(Sep 2026). Learned policies cut per-run cost 15–217× and latency 3.4–5.1×, and
raised Pass^3 by 3.6–15.8 points over the base agent on OSWorld-Verified and
ScienceBoard.

## Example tasks

- `Open our staging site in Chrome, sign up with the test Gmail account, click the verification email, and tell me where the flow breaks.`
- `Log in to the vendor portal (it has no API) and list last month's invoices with their totals.`
- `Enter each row of the uploaded CSV into the supplier form at <url>, which has no import, and report the rows that failed validation.`
- `Follow the steps in this bug report in Chrome on Windows and describe exactly what happens at each step.`

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

## Watch Sai work

Each task comes with a live view: the computer's screen, Sai's steps,
permission requests you can answer, and the result.

- **Apps that show MCP Apps** (Claude desktop and web, ChatGPT, Cursor, VS
  Code): the view appears in the conversation under the task. In Claude,
  **Open in a window** pops it out so it stays in sight while you chat.
- **Everywhere else** (Claude Code, Codex): your agent gives you a
  `watch_url` link to the same view, served by this server on your own
  computer (`127.0.0.1`). Your API key never reaches the browser. Codex shows
  the view inline but keeps it offline, so open the link for the live screen.
- Or open the [Playground](https://platform.simular.ai/playground).

One view watches a computer at a time. If another one takes over the screen,
the view says so and offers **Watch here**.

## Environment

| Variable         | Required | Meaning                                                              |
| ---------------- | -------- | -------------------------------------------------------------------- |
| `SAI_API_KEY`    | yes      | Your Sai API key (`sapi_…`).                                         |
| `SAI_PUSH`       | no       | `1` turns on Claude Code channels (below). Leave it unset otherwise. |
| `SAI_LOCAL_VIEW` | no       | `0` turns off the local `watch_url` page.                            |
| `SAI_CONTROL`    | no       | `1` adds the direct control tools (below).                           |
| `SAI_OSWORLD`    | no       | `1` adds the OSWorld tools (below); implies `SAI_CONTROL`.           |

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

## Direct control (research preview)

With `SAI_CONTROL=1`, your agent can also drive the computer itself instead of
handing Sai a task: `sai_control_open`, then `sai_control_exec` blocks of Simulang
(JavaScript) that run on the computer, then `sai_control_close`. Each block
returns its value and console output, plus a screenshot as an image your
agent's own model sees. The Simulang reference is the MCP resource
`sai://simulang/reference`. Direct control must be enabled for your account.
Docs: [Direct control](https://platform.simular.ai/documentation/concepts/direct-control).

```bash
claude mcp add sai -e SAI_API_KEY=sapi_YOUR_KEY -e SAI_CONTROL=1 -- npx -y @simular-ai/sai-mcp
```

## OSWorld (research preview)

With `SAI_OSWORLD=1`, your agent can run OSWorld V2.1 tasks: `osworld_start`
sets a task up on a fresh cloud computer and returns its instruction, your agent
does the task through direct control of that computer, and `osworld_submit` grades
it (with `outcome: "fail"` when the agent concludes the task cannot be done; some
tasks are infeasible on purpose). `osworld_ask_user` answers questions for tasks that have a user, and
`osworld_abandon` ends an attempt without grading so you can start it again.
Setup and grading run on Simular's side; your agent only sees the instruction
and the computer. Needs Benchmarks access on your account.

```bash
claude mcp add sai -e SAI_API_KEY=sapi_YOUR_KEY -e SAI_OSWORLD=1 -- npx -y @simular-ai/sai-mcp
```

## Support

[support@simular.ai](mailto:support@simular.ai)
