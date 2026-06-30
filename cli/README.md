# @simular-ai/sapi-cli

Command-line interface for [Sai](https://sai.simular.ai), your Simular AI agent.

`sapi` lets you drive your Sai agent from the terminal — send tasks, ask about
past conversations, attach Simulang workflows, and stream results live, without
opening the desktop app. Each message continues the same conversation as the
app, and long tasks keep running in the cloud even if you disconnect.

```bash
sapi -m summarise my unread emails and list any action items
```

## Install

Run it on demand with `npx`:

```bash
npx @simular-ai/sapi-cli --help
```

Or install globally to get the `sapi` command:

```bash
npm install -g @simular-ai/sapi-cli
sapi --version
```

Requires Node.js 18 or newer.

## Quick start

```bash
sapi login            # sign in with Google (opens your browser)
sapi machine          # pick which Sai workspace to talk to
sapi -m take a screenshot and describe what's on my screen
```

Your session is stored under `~/.sapi/` and stays valid for 72 hours,
auto-refreshing as you use it — so you only log in again once it expires.

## Authentication

`sapi login` opens a browser for Google sign-in (use the account linked to your
Sai subscription); the terminal continues automatically once you finish.

```bash
sapi login                  # default 72h session
sapi login --timeout 30m    # custom length: m (minutes), h (hours), d (days)
sapi whoami                 # show current user, uid, and auth method
sapi logout                 # clear session credentials (API keys survive)
```

For unattended use (CI, devices), generate an [API key](#api-keys) once and skip
the browser flow entirely.

## Choosing a workspace

A workspace (or "machine") is a Sai desktop registered to your account.

```bash
sapi machine
```

```
Fetching your machines...
  1. MacBook Pro    (last active 2 hours ago)
  2. Work Desktop   (last active 3 days ago)
Select a machine (1–2): 1
✓ Selected: MacBook Pro
```

The selection is saved locally and persists across sessions. With only one
machine, it's selected automatically.

## Sending messages

Send a message with `-m` / `--message` (alias `-i` / `--input`). It's variadic,
so multi-word messages need no quotes, and each message continues the same
conversation:

```bash
sapi -m find all PDFs in Downloads from this week and move them to ~/Documents/Reports
sapi -m go to my Gmail and tell me the subject lines of today's unread emails
sapi -m what was the last task you ran for me?
```

Quoting is **required** only when your message contains shell metacharacters
(`|`, `>`, `&`, `;`, `$`).

> **Messages always go through `-m`.** A bare positional message — `sapi open
> Chrome`, or even `sapi "open Chrome"` — is rejected, because the shell strips
> quotes before `sapi` sees them. The flag is also what lets you send a word
> that matches a command name: `sapi -m login` sends the text "login" rather
> than running the `login` command. Running `sapi` with no arguments prints help.

History questions are answered directly; longer tasks stream progress live and
return your shell to a prompt when complete.

### Approval prompts

Some tasks ask permission mid-run (screenshot access, shell commands, browser
automation). These appear inline:

```
⚠  Permission request: Command Approval Required
   Allow? [once / deny / always] (once):
```

Press Enter to accept the default (`once`); type `deny` to refuse. `always`
appears only for shell commands not flagged high-risk.

### Aborting with Ctrl+C

Press `Ctrl+C` while a task streams to be prompted `Abort the task on Sai?
[y/N]`. `y` stops the agent; `N` disconnects the terminal while Sai keeps
working in the background.

## Attaching files

Use `-f` to attach a file; repeat for multiple. Most useful for Simulang
workflow scripts (`.sim`), but any supported file type works. **Max 25 MB per
file.**

```bash
sapi -f ./my-workflow.sim -m run this
sapi -f ./before.png -f ./after.png -m what changed between these?
```

## Sessions

```bash
sapi new                  # start a fresh conversation
sapi sessions             # list the 20 most-recent sessions
sapi resume <sessionId>   # switch the active session (does not send a message)
```

## Abort & restart

```bash
sapi abort            # stop the current task (idempotent)
sapi restart agent    # restart just the Sai agent process
sapi restart machine  # full cloud machine restart (slower)
```

## Verbosity

Control how much `sapi` prints with `--verbose=<n>` (default 1):

| Level | What you see |
| --- | --- |
| `0` | Final response, tool errors, approvals (quiet) |
| `1` | + mid-turn narrations (default) |
| `2` | + script progress lines, routing, elapsed time |
| `3` | + raw SSE event stream (debug) |

Set a persistent default with `sapi config set verbose 2`.

## API keys

API keys are long-lived credentials for programmatic use — CI pipelines,
devices, or anywhere a browser OAuth flow is impractical. They work like GitHub
tokens: generate once, use anywhere, and they survive `sapi logout`.

```bash
sapi key generate --name ci   # requires an active sapi login
sapi key list                 # IDs + labels (no secrets)
sapi key revoke <keyId>       # revoke server-side
```

The key is stored encrypted at `~/.sapi/.ak` and used automatically. For CI,
inject it via environment variable instead (takes priority over the stored key):

```bash
export SAPI_API_KEY="sapi_..."
sapi -m run the nightly report
```

Key generation requires a Firebase session — a key cannot mint new keys. Up to
10 active keys per account.

## Configuration

```bash
sapi config set verbose 2     # default verbosity (0–3)
sapi config set timeout 10m   # default stream inactivity timeout
sapi config show
sapi config reset
```

## Environment variables

| Variable | Purpose |
| --- | --- |
| `SAPI_API_KEY` | Long-lived API key; bypasses the Firebase session entirely |
| `SAPI_API_URL` | Override the cloud-api base URL (default: `https://api.sai.simular.ai`) |

`SAPI_API_URL` is handy for pointing at a staging or local cloud-api during
development.

## Files

`sapi` stores state under `~/.sapi/` (created with `0700` permissions):

| File | Contents |
| --- | --- |
| `credentials.json` | Firebase ID token, expiry, and email |
| `session.json` | Selected machine ID |
| `.mk` | AES-256-GCM machine key (generated once at login) |
| `.rt` | Encrypted refresh token |
| `.ak` | Encrypted API key (if generated) |

## Rate limits

Enforced server-side per user on a rolling one-hour window, shared across all
clients (CLI, desktop app, API key). Exceeding a limit returns `429`.

| Action | Limit |
| --- | --- |
| Send a message | 60 / hour |
| Upload a file | 30 / hour |
| Abort a task | 20 / hour |
| Restart agent or machine | 10 / hour |
| Generate an API key | 5 / hour |

## Programmatic access

The CLI is built on the Sai HTTP API (the same REST surface under
`https://api.sai.simular.ai/v1`). You can call it directly from any language for
custom integrations — authenticate with an API key via the `Authorization:
Bearer` header.

## License

[MIT](./LICENSE) © Simular AI
