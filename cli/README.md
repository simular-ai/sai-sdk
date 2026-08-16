# @simular-ai/sai-cli

Command-line interface for [Sai](https://sai.simular.ai), your Simular AI agent.

`sai` lets you drive your Sai agent from the terminal — send tasks, ask about
past conversations, attach Simulang workflows, and stream results live, without
opening the desktop app. Every message continues one conversation of `sai`'s
own, kept separate from the desktop app's, and long tasks keep running in the
cloud even if you disconnect.

```bash
sai -m summarise my unread emails and list any action items
```

## Install

Run it on demand with `npx`:

```bash
npx @simular-ai/sai-cli --help
```

Or install globally to get the `sai` command:

```bash
npm install -g @simular-ai/sai-cli
sai --version
```

Requires Node.js 22.12 or newer.

## Quick start

```bash
sai login            # sign in with Google (opens your browser)
sai machine          # pick which Sai workspace to talk to
sai -m take a screenshot and describe what's on my screen
```

Your session is stored under `~/.simular/cli/` and stays valid for 72 hours,
auto-refreshing as you use it — so you only log in again once it expires.

## Authentication

`sai login` opens a browser for Google sign-in (use the account linked to your
Sai subscription); the terminal continues automatically once you finish.

```bash
sai login                  # default 72h session
sai login --timeout 30m    # custom length: m (minutes), h (hours), d (days)
sai whoami                 # show current user, uid, and auth method
sai logout                 # clear session credentials (API keys survive)
```

For unattended use (CI, devices), generate an [API key](#api-keys) once and skip
the browser flow entirely.

## Choosing a workspace

A workspace (or "machine") is a Sai desktop registered to your account.

```bash
sai machine
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
so multi-word messages need no quotes, and each message continues `sai`'s
conversation (see [Sessions](#sessions)):

```bash
sai -m find all PDFs in Downloads from this week and move them to ~/Documents/Reports
sai -m go to my Gmail and tell me the subject lines of today's unread emails
sai -m "what was the last task you ran for me?"
```

Quoting is **required** when your message contains shell metacharacters
(`|`, `>`, `&`, `;`, `$`) or glob characters (`?`, `*`, `[`, `]`). The glob ones
matter more than they look: zsh is the default shell on macOS and aborts the
whole command with `no matches found` when a pattern matches no file, so an
unquoted question mark — common at the end of a question — never reaches `sai`.

> **Messages always go through `-m`.** A bare positional message — `sai open
Chrome`, or even `sai "open Chrome"` — is rejected, because the shell strips
> quotes before `sai` sees them. The flag is also what lets you send a word
> that matches a command name: `sai -m login` sends the text "login" rather
> than running the `login` command. Running `sai` with no arguments prints help.

History questions are answered directly; longer tasks stream progress live and
return your shell to a prompt when complete.

### Approval prompts

Some tasks ask permission mid-run (screenshot access, shell commands, browser
automation). These appear inline:

```
⚠  Permission request: Command Approval Required
   Allow? [once / task / deny] (once):
```

Press Enter to accept the default (`once`); type `deny` to refuse. `task` is the
desktop card's "Trust for this task" — it stops the asking for the rest of this
task and lapses when the task ends. Nothing you answer here is remembered
beyond it.

### Aborting with Ctrl+C

Press `Ctrl+C` while a task streams to be prompted `Abort the task on Sai?
[y/N]`. `y` stops the agent; `N` disconnects the terminal while Sai keeps
working in the background.

## Attaching files

Use `-f` to attach a file; repeat for multiple. Most useful for Simulang
workflow scripts (`.sim`), but any supported file type works. **Max 25 MB per
file.**

```bash
sai -f ./my-workflow.sim -m run this
sai -f ./before.png -f ./after.png -m what changed between these?
```

## Sessions

`sai` has its own conversation, separate from the desktop app — messages you
send here only ever land in it, and desktop messages never land here.

```bash
sai new                  # start a fresh conversation
sai sessions             # list the 20 most-recent sessions
```

**The conversation persists indefinitely.** It survives closing your terminal,
logging out, and upgrading `sai`, so a follow-up works whether the last message
was a minute or a month ago — `sai new` is the only thing that moves you to a
different one. Two things sit outside it: anything you sent before a `sai new`
(that conversation stays readable, it's just no longer the current one), and any
history from before `sai` had its own session, which lives in whichever desktop
conversation it landed in at the time.

Either way, you can still get at it — just ask (`sai -m "what did we decide
about the invoice script?"`) and Sai searches your past conversations.

## Abort & restart

```bash
sai abort            # stop the current task (idempotent)
sai restart agent    # restart just the Sai agent process
sai restart machine  # full cloud machine restart (slower)
```

## Verbosity

Control how much `sai` prints with `--verbose=<n>` (default 1):

| Level | What you see                                   |
| ----- | ---------------------------------------------- |
| `0`   | Final response, tool errors, approvals (quiet) |
| `1`   | + mid-turn narrations (default)                |
| `2`   | + script progress lines, routing, elapsed time |
| `3`   | + raw SSE event stream (debug)                 |

Set a persistent default with `sai config set verbose 2`.

## API keys

API keys are long-lived credentials for programmatic use — CI pipelines,
devices, or anywhere a browser OAuth flow is impractical. They work like GitHub
tokens: generate once, use anywhere, and they survive `sai logout`.

```bash
sai key generate --name ci   # requires an active sai login
sai key list                 # IDs + labels (no secrets)
sai key revoke <keyId>       # revoke server-side
```

The key is stored encrypted at `~/.simular/cli/.ak` and used automatically. For CI,
inject it via environment variable instead (takes priority over the stored key):

```bash
export SAI_API_KEY="sapi_..."
sai -m run the nightly report
```

Key generation requires a Firebase session — a key cannot mint new keys. Up to
10 active keys per account.

## Configuration

```bash
sai config set verbose 2     # default verbosity (0–3)
sai config set timeout 10m   # default stream inactivity timeout
sai config show
sai config reset
```

## Environment variables

| Variable          | Purpose                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `SAI_API_KEY`     | Long-lived API key; bypasses the Firebase session entirely. Set it to an empty string to ignore a stored key for one command    |
| `SAI_API_URL`     | Override the cloud-api base URL (default: `https://api.sai.simular.ai`)                                                         |
| `SAI_VERSION_TAG` | **Staging only.** Pin requests to a tagged staging deployment (`x-sai-version`); unknown tags fall back to the default instance |

`SAI_API_URL` is handy for pointing at a staging or local cloud-api during
development. `SAI_VERSION_TAG` then pins you to one tagged build of it — for
testing a preview deployment without moving anyone else off the default. You
don't need it against production, which serves a single deployment.

## Files

`sai` stores state under `~/.simular/cli/` (created with `0700` permissions):

| File               | Contents                                          |
| ------------------ | ------------------------------------------------- |
| `credentials.json` | Firebase ID token, expiry, and email              |
| `session.json`     | Selected machine ID                               |
| `.mk`              | AES-256-GCM machine key (generated once at login) |
| `.rt`              | Encrypted refresh token                           |
| `.ak`              | Encrypted API key (if generated)                  |

## Rate limits

Enforced server-side per user on a rolling one-hour window, shared across all
clients (CLI, desktop app, API key). Exceeding a limit returns `429`.

| Action                               | Limit     |
| ------------------------------------ | --------- |
| Send a message                       | 60 / hour |
| Upload a file                        | 30 / hour |
| Abort a task                         | 20 / hour |
| Start a new conversation (`sai new`) | 20 / hour |
| Restart agent or machine             | 10 / hour |
| Generate an API key                  | 5 / hour  |

## Programmatic access

The CLI is built on the Sai HTTP API (the same REST surface under
`https://api.sai.simular.ai/v1`). You can call it directly from any language for
custom integrations — authenticate with an API key via the `Authorization:
Bearer` header.

## Dependencies

`sai` ships as a single bundled file (`dist/cli.cjs`) and its only runtime
dependency is [`commander`](https://www.npmjs.com/package/commander); HTTP calls
use Node's built-in `fetch`. `npm audit` on an install of this package is clean.

## License

[MIT](./LICENSE) © Simular LLC
