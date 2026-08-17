import { createInterface } from 'readline'
import { Command } from 'commander'
import { performGoogleOAuth } from './auth/google-oauth.js'
import {
  saveCredentials,
  loadCredentials,
  clearCredentials,
  saveSession,
  loadSession,
  requireAuth,
  saveApiKey,
  loadApiKey,
  clearApiKey,
  loadConfig,
  saveConfig,
  resetConfig,
  loadApiKeyId,
} from './auth/token-store.js'
import {
  verifyAuth,
  abortCurrentTask,
  listMachines,
  listSessions,
  restartTarget,
  startNewSession,
  streamMessage,
  sendApproval,
  startConciergePoll,
} from './sai/client.js'
import type { MachineInfo, SessionSummary, SseEvent } from './sai/client.js'
import { uploadFile } from './upload/simulang.js'
import { CLOUD_API_URL, RESPONSE_TIMEOUT_MS } from './config.js'
import { apiFetch } from './http.js'
import {
  parseDuration,
  formatDuration,
  parseChoiceSelection,
  sanitizeTerminalText,
} from './cli-utils.js'
import type { ChoiceSelectionResult } from './cli-utils.js'

// keep subcommand options from being consumed by same-named root options
const program = new Command().enablePositionalOptions()

program.name('sai').description('CLI for Sai — your Simular AI agent').version('0.2.1-rc.1')

program.addHelpText(
  'after',
  `
Examples:
  $ sai login                                   Sign in with Google (opens browser)
  $ sai whoami                                  Show current authenticated user
  $ sai machine                                 Choose a Sai workspace (run again to switch)
  $ sai -m summarise my unread emails           Send a task to Sai (messages use -m/--message)
  $ sai -m what have you done recently?         Ask about past activity
  $ sai -m login                                Send a one-word message, even one matching a command name
  $ sai -f report.pdf -m review this            Attach a file
  $ sai -f before.png -f after.png -m what changed?  Attach multiple files
  $ sai -v 0 -m take a screenshot               Quiet mode (suppress narrations)
  $ sai -v 2 -m close apps and check gmail      Show script progress lines and debug info
  $ sai -v 3 -m do a task                       Show raw SSE event stream (debug)
  $ sai config set verbose 2                    Set default verbosity level to 2
  $ sai abort                                   Abort the currently running task
  $ sai sessions                                List recent conversations
  $ sai new                                     Start a fresh conversation on the current workspace
  $ sai restart agent                           Restart the Sai agent process
  $ sai restart machine                         Restart the cloud machine

  $ sai key generate --name dev                 Generate an API key
  $ SAI_API_KEY=sapi_... sai -m do a task      Use an API key directly

Environment:
  SAI_API_KEY      Long-lived API key; bypasses Firebase session entirely
                   Set to "" to ignore a stored key for one command
  SAI_API_URL      Override cloud-api base URL (default: https://api.sai.simular.ai)
  SAI_VERSION_TAG  Staging only — pin requests to a tagged staging deployment
                   (x-sai-version). Not needed against production.

Files:
  ~/.simular/cli/credentials.json   Firebase ID token, expiry, and email
  ~/.simular/cli/session.json       Selected machine ID
  ~/.simular/cli/.mk                AES-256-GCM machine key (generated once at login)
  ~/.simular/cli/.rt                Encrypted refresh token
  ~/.simular/cli/.ak                Encrypted API key (if generated)`,
)

/**
 * Returns the auth token to use for API requests.
 * Priority: SAI_API_KEY env var > ~/.simular/cli/.ak (encrypted) > Firebase ID token.
 * When using an API key the Firebase session check is skipped — the API key is
 * long-lived and doesn't require periodic refresh.
 */
async function resolveAuthToken(): Promise<string> {
  const apiKey = loadApiKey()
  if (apiKey) return apiKey
  const creds = await requireAuth()
  return creds.idToken
}

// ─── login ────────────────────────────────────────────────────────────────────

program
  .command('login')
  .description('Authenticate with your Simular account via Google sign-in')
  .option(
    '--timeout <duration>',
    'Session timeout before re-auth is required (e.g. 24h, 7d)',
    '72h',
  )
  .action(async (opts: { timeout: string }) => {
    const existing = loadCredentials()
    if (existing && Date.now() < existing.sessionExpiresAt) {
      const remainingMin = Math.round((existing.sessionExpiresAt - Date.now()) / 60_000)
      const remainingHuman =
        remainingMin >= 60 ? `${Math.round(remainingMin / 60)}h` : `${remainingMin}m`
      console.log(
        `Already authenticated as ${existing.email} (session valid for ${remainingHuman} more). Run \`sai logout\` first to switch accounts.`,
      )
      return
    }

    // --timeout defaults to '72h'; fall back to 72h (with a warning) on bad input
    // so sessionTimeoutMs is always a concrete number.
    const DEFAULT_SESSION_MS = 72 * 3_600_000
    let sessionTimeoutMs = DEFAULT_SESSION_MS
    if (opts.timeout) {
      const parsed = parseDuration(opts.timeout)
      if (parsed === null) {
        console.error(
          `Invalid timeout format "${opts.timeout}". Use a number followed by s, m, h, or d (e.g. 24h, 7d). Defaulting to 72h.`,
        )
      } else {
        sessionTimeoutMs = parsed
      }
    }

    try {
      const result = await performGoogleOAuth()
      const creds = saveCredentials({ ...result, sessionTimeoutMs })
      const hours = Math.round(sessionTimeoutMs / 3_600_000)
      console.log(`\n✓ Authenticated as ${creds.email}`)
      console.log(`  Session valid for ${hours}h. Run \`sai login\` again to refresh early.`)
      console.log(`\nNext: run \`sai machine\` to choose a workspace.`)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(`\nLogin failed: ${msg}`)
      process.exit(1)
    }
  })

// ─── whoami ───────────────────────────────────────────────────────────────────

program
  .command('whoami')
  .description('Show the current authenticated user and verify credentials')
  .action(async () => {
    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    try {
      const { userId, authType } = await verifyAuth(authToken)
      const creds = loadCredentials()
      const identity = creds?.email ? `${creds.email} (${userId})` : userId
      const method = authType === 'apiKey' ? 'API key' : 'Firebase session'
      console.log(`Authenticated as ${identity} via ${method}`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

// ─── logout ───────────────────────────────────────────────────────────────────

program
  .command('logout')
  .description('Clear stored credentials and session')
  .action(() => {
    const creds = loadCredentials()
    if (!creds) {
      console.log('Not signed in.')
      return
    }
    clearCredentials()
    console.log(`Signed out (was ${creds.email}).`)
    const hasKey = loadApiKey()
    if (hasKey) {
      console.log(
        `  Note: your API key was not cleared. It remains valid until revoked.\n  Run \`sai key revoke <keyId>\` to remove it, or set SAI_API_KEY="" to ignore it.`,
      )
    }
  })

// ─── machine ──────────────────────────────────────────────────────────────────

program
  .command('machine')
  .description('Select which Sai workspace (machine) to send messages to')
  .action(async () => {
    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    let machines: MachineInfo[]
    try {
      process.stdout.write('Fetching your machines...\n')
      machines = await listMachines(authToken)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    if (machines.length === 0) {
      console.error(
        'No machines found. Open the Sai desktop app on a computer to set up a workspace first.',
      )
      process.exit(1)
    }

    const currentSession = loadSession()
    const currentMachineId = currentSession?.machineId

    let chosen: MachineInfo
    if (machines.length === 1) {
      chosen = machines[0]
      console.log(`\nOnly one machine found — selecting automatically:\n`)
    } else {
      console.log('')
      machines.forEach((m, i) => {
        const label = sanitizeTerminalText(m.name ?? m.machineId)
        const age = m.updatedAt ? `  (last active ${formatAge(m.updatedAt)})` : ''
        const selected = m.machineId === currentMachineId ? '  ✓' : ''
        console.log(`  ${i + 1}. ${label}${age}${selected}`)
      })
      console.log('')
      const idx = await promptNumber(
        `Select a machine (1–${machines.length}): `,
        1,
        machines.length,
      )
      chosen = machines[idx - 1]
    }

    saveSession({ machineId: chosen.machineId })
    const label = chosen.name ?? chosen.machineId
    console.log(`\n✓ Selected: ${label}`)
  })

// ─── new ──────────────────────────────────────────────────────────────────────

program
  .command('new')
  .description('Start a fresh conversation on the current workspace')
  .action(async () => {
    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const session = loadSession()
    if (!session) {
      console.error('No workspace selected. Run `sai machine` to choose one first.')
      process.exit(1)
    }

    try {
      const sessionId = await startNewSession(authToken, session.machineId)
      console.log(`✓ New conversation started (${sessionId})`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

// ─── config ───────────────────────────────────────────────────────────────────

const configCmd = program.command('config').description('View and set sai preferences')

configCmd
  .command('set <key> <value>')
  .description('Set a config value (keys: verbose, timeout)')
  .action((key: string, value: string) => {
    if (key === 'verbose') {
      const n = parseInt(value, 10)
      if (isNaN(n) || n < 0 || n > 3) {
        console.error('verbose must be 0, 1, 2, or 3')
        process.exit(1)
      }
      saveConfig({ verbose: n })
      console.log(`✓ Default verbosity set to ${n}`)
    } else if (key === 'timeout') {
      const ms = parseDuration(value)
      if (ms === null) {
        console.error(
          `Invalid timeout format "${value}". Use a number followed by s, m, h, or d (e.g. 30s, 5m, 2h).`,
        )
        process.exit(1)
      }
      saveConfig({ timeoutMs: ms })
      console.log(`✓ Default inactivity timeout set to ${value}`)
    } else {
      console.error(`Unknown config key: "${key}". Available keys: verbose, timeout`)
      process.exit(1)
    }
  })

configCmd
  .command('show')
  .description('Show current config values')
  .action(() => {
    const cfg = loadConfig()
    const verboseVal = cfg.verbose ?? 1
    const verboseSrc = cfg.verbose === undefined ? 'default' : 'custom'
    console.log(`verbose = ${verboseVal}  (${verboseSrc})`)
    const timeoutVal = cfg.timeoutMs !== undefined ? formatDuration(cfg.timeoutMs) : '5m'
    const timeoutSrc = cfg.timeoutMs === undefined ? 'default' : 'custom'
    console.log(`timeout = ${timeoutVal}  (${timeoutSrc})`)
  })

configCmd
  .command('reset')
  .description('Reset all config to defaults')
  .action(() => {
    resetConfig()
    console.log('✓ Config reset to defaults.')
  })

// ─── key ──────────────────────────────────────────────────────────────────────

const keyCmd = program.command('key').description('Manage API keys for programmatic access')

keyCmd
  .command('generate')
  .description('Generate a long-lived API key (stored encrypted in ~/.simular/cli/.ak)')
  .option('--name <label>', 'Human-readable label for this key')
  .action(async (opts: { name?: string }) => {
    // Key generation requires a Firebase ID token — API keys are explicitly rejected
    // server-side to prevent a compromised key from minting new ones. Always use
    // requireAuth() directly here, never the stored API key.
    let authToken: string
    try {
      const creds = await requireAuth()
      authToken = creds.idToken
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    try {
      const res = await apiFetch(`${CLOUD_API_URL}/v1/account/keys`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ name: opts.name }),
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(`Failed to generate key (${res.status}): ${body.error ?? res.statusText}`)
      }
      const { key, keyId } = (await res.json()) as { key: string; keyId: string; name?: string }
      saveApiKey(key, keyId)
      console.log(`\n✓ API key generated (id: ${keyId}) and saved to ~/.simular/cli/.ak`)
      console.log(`  Future sai commands will use this key instead of your Firebase session.`)
      console.log(`  For CI or devices: export SAI_API_KEY="${key}"`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

keyCmd
  .command('revoke <keyId>')
  .description('Revoke an API key by its ID (see key list for IDs)')
  .action(async (keyId: string) => {
    let authToken: string
    try {
      authToken = (await requireAuth()).idToken
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    try {
      const res = await apiFetch(`${CLOUD_API_URL}/v1/account/keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (res.status === 404) {
        const looksLikeName = !/^[A-Za-z0-9]{20}$/.test(keyId)
        console.error(
          looksLikeName
            ? `Key "${keyId}" not found. Use the key ID, not the name — run \`sai key list\` to find it.`
            : `Key "${keyId}" not found.`,
        )
        process.exit(1)
      }
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(`Failed to revoke key (${res.status}): ${body.error ?? res.statusText}`)
      }
      if (loadApiKeyId() === keyId) {
        clearApiKey()
        console.log(`✓ Key ${keyId} revoked and removed from local storage.`)
      } else {
        console.log(`✓ Key ${keyId} revoked.`)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

keyCmd
  .command('list')
  .description('List API keys for your account')
  .action(async () => {
    let authToken: string
    try {
      authToken = (await requireAuth()).idToken
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    try {
      const res = await apiFetch(`${CLOUD_API_URL}/v1/account/keys`, {
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(`Failed to list keys (${res.status}): ${body.error ?? res.statusText}`)
      }
      const { keys } = (await res.json()) as {
        keys: { keyId: string; name: string | null; createdAt: number }[]
      }
      if (keys.length === 0) {
        console.log('No API keys. Run `sai key generate` to create one.')
        return
      }
      console.log('')
      for (const k of keys) {
        const label = k.name ?? '(unnamed)'
        const date = new Date(k.createdAt).toLocaleDateString()
        console.log(`  ${k.keyId}  ${label}  (created ${date})`)
      }
      console.log('')
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

// ─── abort ────────────────────────────────────────────────────────────────────

program
  .command('abort')
  .description('Abort the currently running task on your workspace')
  .action(async () => {
    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const session = loadSession()
    if (!session) {
      console.error('No workspace selected. Run `sai machine` to choose one first.')
      process.exit(1)
    }

    try {
      const result = await abortCurrentTask(authToken, session.machineId)
      if (result.aborted) {
        console.log('✓ Task aborted.')
      } else {
        console.log(`Nothing to abort (${result.reason ?? 'already idle'}).`)
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

// ─── sessions ─────────────────────────────────────────────────────────────────

program
  .command('sessions')
  .description('List recent conversations on the current workspace')
  .action(async () => {
    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const session = loadSession()
    if (!session) {
      console.error('No workspace selected. Run `sai machine` to choose one first.')
      process.exit(1)
    }

    let sessions: SessionSummary[]
    try {
      sessions = await listSessions(authToken, session.machineId)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    if (sessions.length === 0) {
      console.log('No sessions found for this workspace.')
      return
    }

    console.log('')
    for (const s of sessions) {
      const date = new Date(s.updatedAt).toLocaleString()
      const marker = s.active ? '  ✓ (this CLI)' : ''
      // Titles are agent-generated, and a channel session's is derived from the
      // inbound thread — i.e. from text a third party wrote. Sanitize like the
      // approval cards (see handleApprovalEvent).
      console.log(`  ${s.sessionId}  ${sanitizeTerminalText(s.title)}  (${date})${marker}`)
    }
    console.log('')
    console.log('Ask Sai about an older conversation and it will look it up.')
    console.log('')
  })

// ─── restart ──────────────────────────────────────────────────────────────────

program
  .command('restart <target>')
  .description('Restart the Sai agent or cloud machine (target: agent | machine)')
  .action(async (target: string) => {
    if (target !== 'agent' && target !== 'machine') {
      console.error(
        `error: unknown restart target '${target}'\nUse: sai restart agent  or  sai restart machine`,
      )
      process.exit(1)
    }

    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const session = loadSession()
    if (!session) {
      console.error('No workspace selected. Run `sai machine` to choose one first.')
      process.exit(1)
    }

    try {
      console.log(`Restarting ${target}...`)
      await restartTarget(authToken, session.machineId, target)
      if (target === 'agent') {
        console.log('✓ Agent restart initiated. It should be back within 30 seconds.')
      } else {
        console.log('✓ Machine restart initiated. This usually takes 2–3 minutes.')
      }
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

// ─── Default: send a message ─────────────────────────────────────────────────

// Commands that were removed rather than deprecated. They land here as stray
// positionals (Commander has no command to match), where the generic "use -m"
// error would misdirect — `sai -m resume abc123` would send the text as a task.
// Keyed by the retired verb, giving the reason and the replacement instead.
const RETIRED_COMMAND_HELP: Record<string, string> = {
  resume:
    'sai resume was removed — the CLI now has its own conversation, separate from the desktop app,\n' +
    'so there is no other session to switch to.\n\n' +
    'To revisit an older conversation, just ask — e.g. `sai -m "what did we decide about the invoice script?"` —\n' +
    'and Sai will search your past conversations. To start fresh, run `sai new`.',
}

program
  .option(
    '-f, --file <path>',
    'Attach a file to the message; repeat for multiple files',
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    '-v, --verbose <n>',
    'Verbosity level: 0=quiet, 1=narrations, 2=+script progress lines+debug info, 3=+raw SSE (default: from `sai config`, initially 1)',
  )
  .option(
    '--timeout <duration>',
    'Inactivity timeout: exit if no new output is received for this long (e.g. 2m, 10m, 1h). Default: 5m.',
  )
  .option(
    '-m, --message <text...>',
    'Message to send to Sai. The explicit, unambiguous form — use it to send a single word that matches a command name (e.g. -m "login"), or a multi-word message without quoting.',
  )
  .option('-i, --input <text...>', 'Alias for --message.')
  // Stray positional tokens are captured only so we can show a helpful "use -m"
  // error — sai doesn't accept a message as a positional argument.
  .argument('[ignored...]', 'Not supported: send your message with --message/-m instead')
  .action(async (positionalArgs: string[]) => {
    const opts = program.opts<{
      file: string[]
      verbose: string | undefined
      timeout: string | undefined
      message: string[] | undefined
      input: string[] | undefined
    }>()
    const cfgVerbose = loadConfig().verbose ?? 1
    const verbosity = (
      opts.verbose !== undefined
        ? Math.min(3, Math.max(0, parseInt(opts.verbose, 10) || 0))
        : Math.min(3, Math.max(0, cfgVerbose))
    ) as 0 | 1 | 2 | 3

    const cfgTimeoutMs = loadConfig().timeoutMs ?? RESPONSE_TIMEOUT_MS
    if (opts.timeout && parseDuration(opts.timeout) === null) {
      console.error(
        `Invalid timeout format "${opts.timeout}". Use a number followed by s, m, h, or d (e.g. 30s, 5m, 2h).`,
      )
      process.exit(1)
    }
    const timeoutMs = opts.timeout ? (parseDuration(opts.timeout) ?? cfgTimeoutMs) : cfgTimeoutMs

    // Messages are sent ONLY via the -m/--message flag (or its -i/--input alias).
    // The flag accepts multiple words without quoting and lets you send a word
    // that collides with a command name (e.g. `sai -m login` sends "login"
    // rather than running the login command).
    const messageText =
      opts.message && opts.message.length > 0
        ? opts.message.join(' ')
        : opts.input && opts.input.length > 0
          ? opts.input.join(' ')
          : undefined

    if (!messageText) {
      // A bare positional message (quoted or not) isn't supported — the
      // shell strips quotes and splits words before sai runs, so it can't be
      // distinguished from a command. Point the user at -m.
      if (positionalArgs && positionalArgs.length > 0) {
        // A retired command (e.g. `sai resume <id>`) reaches here as a stray
        // positional. Give its own reason + replacement rather than the generic
        // "use -m" message, which would wrongly suggest re-sending it as a task.
        const retiredHelp = RETIRED_COMMAND_HELP[positionalArgs[0].toLowerCase()]
        if (retiredHelp) {
          console.error(retiredHelp)
          process.exit(1)
        }
        const attempted = positionalArgs.join(' ')
        const known = program.commands.map((c) => c.name()).join(', ')
        console.error(
          `error: sai doesn't take a message as a positional argument — use the --message/-m flag:\n` +
            `  sai -m ${attempted}\n\n` +
            `(Quoting, e.g. \`sai "${attempted}"\`, isn't supported either: the shell strips the quotes before sai runs.)\n` +
            `Available commands: ${known}. Run \`sai --help\` for details.`,
        )
        process.exit(1)
      }
      // Nothing at all → show help.
      program.help()
      return
    }

    // 1. Auth check
    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    // 2. Resolve session — must have run `sai machine` first
    let session = loadSession()
    if (!session) {
      // Auto-select if only one machine exists, otherwise prompt
      let machines: MachineInfo[]
      try {
        process.stdout.write('No machine selected. Fetching machines...\n')
        machines = await listMachines(authToken)
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
      if (machines.length === 0) {
        console.error(
          'No machines found. Open the Sai desktop app on a computer to set up a workspace first.',
        )
        process.exit(1)
      }
      let chosen: MachineInfo
      if (machines.length === 1) {
        chosen = machines[0]
        const label = chosen.name ?? chosen.machineId
        process.stdout.write(`Using: ${label}\n`)
      } else if (process.stdin.isTTY) {
        process.stdout.write('\n')
        machines.forEach((m, i) => {
          const label = sanitizeTerminalText(m.name ?? m.machineId)
          const age = m.updatedAt ? `  (last active ${formatAge(m.updatedAt)})` : ''
          process.stdout.write(`  ${i + 1}. ${label}${age}\n`)
        })
        process.stdout.write('\n')
        const idx = await promptNumber(
          `Select a machine (1–${machines.length}): `,
          1,
          machines.length,
        )
        chosen = machines[idx - 1]
        process.stdout.write(`✓ Selected: ${chosen.name ?? chosen.machineId}\n\n`)
      } else {
        console.error('No workspace selected. Run `sai machine` to choose one, then try again.')
        process.exit(1)
      }
      session = { machineId: chosen.machineId }
      saveSession(session)
    }

    // 3. Upload attachment(s) if -f was provided
    const attachments: Awaited<ReturnType<typeof uploadFile>>[] = []
    for (const filePath of opts.file) {
      process.stdout.write(`Uploading ${filePath}...`)
      try {
        attachments.push(await uploadFile(authToken, filePath))
        process.stdout.write(' done\n')
      } catch (err) {
        console.error(`\n${err instanceof Error ? err.message : String(err)}`)
        process.exit(1)
      }
    }

    // 4. Send to Sai. Agent output streams over SSE; the server concierge
    //    reply (if any) arrives on the concierge_messages side track and is
    //    polled in parallel below.
    process.stderr.write('Sending to Sai...\n')
    let lastError: string | undefined
    const startMs = Date.now()
    const toolCallIdToName = new Map<string, string>()
    // Tracks whether the last output to stderr was a non-chunk line so we can
    // insert a blank line before the next final response block.
    let lastWasVerbose = false

    // Register a SIGINT handler only for the duration of the stream.
    // On Ctrl+C, ask whether to abort the task server-side or just disconnect.
    let sigintFired = false
    const onSigint = (): void => {
      sigintFired = true
      promptAbort(authToken, session!.machineId)
        .then((code) => process.exit(code))
        .catch(() => process.exit(130))
    }
    process.once('SIGINT', onSigint)

    // Merge concierge side-track replies with the agent stream (poll while SSE open).
    const stopConciergePoll = startConciergePoll({
      authToken,
      machineId: session.machineId,
      sinceMs: startMs,
      onConcierge: (content) => {
        if (sigintFired) return
        process.stderr.write(`\n${sanitizeTerminalText(content)}\n\n`)
        lastWasVerbose = true
      },
    })

    try {
      await streamMessage(
        authToken,
        session.machineId,
        messageText,
        timeoutMs,
        attachments.length > 0
          ? attachments.map((a) => ({
              path: a.path,
              name: a.name,
              mime: a.mime,
              size: a.size,
              fileId: a.fileId,
            }))
          : undefined,
        async (event: SseEvent) => {
          if (sigintFired) return
          switch (event.type) {
            case 'data-status':
              process.stderr.write(`\n${sanitizeTerminalText(event.data.text)}\n\n`)
              break
            case 'text-start':
              // Blank line separating preceding verbose output from the response block.
              if (lastWasVerbose) {
                process.stderr.write('\n')
                lastWasVerbose = false
              }
              break
            case 'text-delta':
              if (event.delta) process.stdout.write(sanitizeTerminalText(event.delta))
              break
            case 'reasoning-delta':
              // Mid-turn narration between tool calls (verbosity 1+).
              if (verbosity >= 1 && event.delta.trim()) {
                process.stderr.write(`[sai] ${sanitizeTerminalText(event.delta.trim())}\n`)
                lastWasVerbose = true
              }
              break
            case 'tool-input-start':
              toolCallIdToName.set(event.toolCallId, event.toolName)
              break
            case 'data-progress':
              // Script progress lines (verbosity 2+).
              if (verbosity >= 2) {
                process.stderr.write(
                  `[${event.data.tool}] ${sanitizeTerminalText(event.data.text)}\n`,
                )
                lastWasVerbose = true
              }
              break
            case 'tool-output-error': {
              // Always shown — tool failures are signal, not noise.
              const errToolName = toolCallIdToName.get(event.toolCallId) ?? 'tool'
              process.stderr.write(`[${errToolName}] ✗ ${sanitizeTerminalText(event.errorText)}\n`)
              lastWasVerbose = true
              break
            }
            case 'finish':
              process.stdout.write('\n')
              if (verbosity >= 2) {
                const elapsed = ((Date.now() - startMs) / 1000).toFixed(1)
                process.stderr.write(`[debug] completed in ${elapsed}s\n`)
              }
              break
            case 'error':
              lastError = event.errorText
              break
            case 'data-approval-request':
              await handleApprovalEvent(authToken, event.data)
              break
          }
        },
        verbosity >= 3,
      )
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      // Prefer exitCode over process.exit so finally can abort the concierge
      // poll; process.exit mid-fetch crashes with 0xC0000409 on Windows.
      process.exitCode = 1
      return
    } finally {
      stopConciergePoll()
      process.off('SIGINT', onSigint)
    }

    if (lastError) {
      console.error(lastError)
      process.exitCode = 1
    }
  })

program.parse()

// ─── Helpers ──────────────────────────────────────────────────────────────────

function promptNumber(question: string, min: number, max: number): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    function ask(): void {
      rl.question(question, (answer) => {
        const n = parseInt(answer.trim(), 10)
        if (!isNaN(n) && n >= min && n <= max) {
          rl.close()
          process.stdin.unref()
          resolve(n)
        } else {
          process.stdout.write(`Please enter a number between ${min} and ${max}.\n`)
          ask()
        }
      })
    }
    ask()
  })
}

/** Prompts the user to abort the server-side task on Ctrl+C. Returns the exit code. */
async function promptAbort(authToken: string, machineId: string): Promise<number> {
  process.stderr.write('\n')
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'Disconnected. Sai may still be working on your message — check the desktop app.\n',
    )
    return 130
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const abort = await new Promise<boolean>((resolve) => {
    rl.question('Abort the task on Sai? [y/N]: ', (raw) => {
      rl.close()
      const a = raw.trim().toLowerCase()
      resolve(a === 'y' || a === 'yes')
    })
  })

  if (!abort) {
    process.stderr.write(
      'Sai will continue working in the background.\n' +
        'Note: any approval prompts will no longer appear here — use the desktop app to respond.\n',
    )
    return 130
  }

  process.stderr.write('Aborting...')
  try {
    const result = await abortCurrentTask(authToken, machineId)
    process.stderr.write(result.aborted ? ' done.\n' : ' (task was already idle).\n')
  } catch (err) {
    process.stderr.write(` failed: ${err instanceof Error ? err.message : String(err)}\n`)
  }
  return 0
}

function formatAge(ms: number): string {
  const diff = Date.now() - ms
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)} minutes ago`
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)} hours ago`
  return `${Math.round(diff / 86_400_000)} days ago`
}

async function handleApprovalEvent(
  authToken: string,
  approval: Extract<SseEvent, { type: 'data-approval-request' }>['data'],
): Promise<void> {
  // Card content (description, command, labels) is agent-composed — sanitize
  // before printing so an embedded ANSI escape can't rewrite the prompt the
  // user is approving against.
  const title = sanitizeTerminalText(approval.title)
  const description = approval.description ? sanitizeTerminalText(approval.description) : ''

  process.stderr.write('\n')
  if (approval.isLinkOnly) {
    // Requires browser/form interaction — can't be resolved from the terminal.
    process.stderr.write(`⚠  Action needed in desktop app: ${title}\n`)
    if (description) process.stderr.write(`   ${description}\n`)
    process.stderr.write(`   Open the Sai desktop app to continue.\n\n`)
    return
  }

  // Full card content: generic title, then the summary (description), then —
  // for exec approvals — the exact command that will run. The user approves
  // against the command itself, not a paraphrase.
  process.stderr.write(`⚠  Permission request: ${title}\n`)
  if (description) process.stderr.write(`   ${description}\n`)
  if (approval.command) {
    const commandBlock = sanitizeTerminalText(approval.command)
      .split('\n')
      .map((line, i) => (i === 0 ? `   $ ${line}` : `     ${line}`))
      .join('\n')
    process.stderr.write(`${commandBlock}\n`)
    if (approval.cwd) process.stderr.write(`   (in ${sanitizeTerminalText(approval.cwd)})\n`)
  }

  if (!process.stdin.isTTY) {
    // Non-interactive (e.g. piped/CI) — can't prompt; let the user handle it in the app.
    process.stderr.write(`   (Non-interactive terminal — approve in the desktop app.)\n\n`)
    return
  }

  // Choice (askChoice) request: present each question and send the answer(s) as
  // `selections`. Never fall through to the yes/no prompt below — /approve
  // rejects an approved choice that carries no selections, so a bare "yes"
  // leaves the approval pending and the agent blocked until it expires.
  const questions = choiceQuestions(approval)
  if (questions) {
    await handleChoiceApproval(authToken, approval, questions)
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const prompt = approval.allowAlways
    ? '   Allow? [once / deny / always] (once): '
    : '   Allow? [once / deny] (once): '
  // Fail closed: only an explicit affirmative (or bare Enter, the advertised
  // default) approves. Unrecognized input re-prompts — a typo must never
  // approve a command.
  const answer = await new Promise<'yes' | 'no' | 'always'>((resolve) => {
    const ask = (): void => {
      rl.question(prompt, (raw) => {
        const a = raw.trim().toLowerCase()
        if (approval.allowAlways && a === 'always') {
          rl.close()
          resolve('always')
        } else if (a === '' || a === 'once' || a === 'yes' || a === 'y' || a === 'allow') {
          rl.close()
          resolve('yes')
        } else if (a === 'deny' || a === 'no' || a === 'n' || a === 'd') {
          rl.close()
          resolve('no')
        } else {
          process.stderr.write(
            '   Please answer "once", "deny"' +
              (approval.allowAlways ? ', or "always".\n' : ', or press Enter for once.\n'),
          )
          ask()
        }
      })
    }
    ask()
  })

  try {
    await sendApproval(authToken, approval.approvalId, answer)
    const label = answer === 'always' ? 'Always allowed' : answer === 'yes' ? 'Allowed' : 'Denied'
    process.stderr.write(`   ✓ ${label}.\n\n`)
  } catch (err) {
    process.stderr.write(
      `   Failed to send response: ${err instanceof Error ? err.message : String(err)}\n\n`,
    )
  }
}

interface ChoiceQuestion {
  message: string
  options: Array<{ value: string; label: string }>
  multiple: boolean
  allowOther: boolean
}

/**
 * The questions an askChoice approval is asking, or undefined when this isn't
 * one. Prefers the server's `questions` list and falls back to the legacy
 * single-question `options`/`multiple` pair, so a new CLI against an older
 * server still answers the shape that server can describe. A `choice` with
 * neither is still returned — as one free-text question, the only answer that
 * can resolve it — rather than dropped into a yes/no prompt /approve rejects.
 */
function choiceQuestions(
  approval: Extract<SseEvent, { type: 'data-approval-request' }>['data'],
): ChoiceQuestion[] | undefined {
  if (approval.approvalType !== 'choice') return undefined
  if (approval.questions && approval.questions.length > 0) {
    return approval.questions.map((q) => ({
      message: q.message,
      options: q.options ?? [],
      multiple: q.multiple === true,
      allowOther: q.allowOther === true || (q.options ?? []).length === 0,
    }))
  }
  const options = approval.options ?? []
  return [
    {
      message: approval.title,
      options,
      multiple: approval.multiple === true,
      allowOther: options.length === 0,
    },
  ]
}

/** Prompt one question of an askChoice batch. Resolves to the picks, or cancel. */
async function askChoiceQuestion(
  question: ChoiceQuestion,
  position: { index: number; total: number },
): Promise<ChoiceSelectionResult> {
  // Question text and labels are agent-composed — sanitize before printing
  // (see handleApprovalEvent).
  const options = question.options.map((o) => ({
    value: o.value,
    label: sanitizeTerminalText(o.label),
  }))
  // The title above already carries a single question's text; only a batch
  // needs each one spelled out (and numbered, so the user can see the shape).
  if (position.total > 1) {
    process.stderr.write(
      `   Question ${position.index + 1}/${position.total}: ${sanitizeTerminalText(question.message)}\n`,
    )
  }
  options.forEach((o, i) => process.stderr.write(`     ${i + 1}. ${o.label}\n`))

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  // Nothing to pick from is a plain free-text ask; otherwise name the pick, and
  // mention typing only where a typed answer is actually accepted.
  const pick = question.multiple ? 'Pick number(s), comma-separated' : 'Pick a number'
  const prompt =
    options.length === 0
      ? '   Your answer (or "cancel"): '
      : question.allowOther
        ? `   ${pick}, type your own answer, or "cancel": `
        : `   ${pick}, or "cancel": `
  // Invalid input re-prompts (mirrors the messaging channel's re-ask) — a typo
  // must not cancel the agent's question. Only an explicit cancel/empty reply
  // does. Unreachable when the question takes a typed answer: anything that
  // isn't an index is then the answer itself.
  return new Promise<ChoiceSelectionResult>((resolve) => {
    const ask = (): void => {
      rl.question(prompt, (raw) => {
        const result = parseChoiceSelection(raw, options, question.multiple, question.allowOther)
        if (result.kind === 'invalid') {
          process.stderr.write(`   Enter a number between 1 and ${options.length}, or "cancel".\n`)
          ask()
          return
        }
        rl.close()
        resolve(result)
      })
    }
    ask()
  })
}

/**
 * Present an askChoice request and resolve it with the user's answer(s).
 * Sent as `selections` — one inner array per question, in order, as /approve
 * requires — carrying option VALUES for a pick and the typed text for a
 * free-text answer, matching the in-app choice card. Cancelling any question
 * denies the whole request, the same as closing the card.
 */
async function handleChoiceApproval(
  authToken: string,
  approval: Extract<SseEvent, { type: 'data-approval-request' }>['data'],
  questions: ChoiceQuestion[],
): Promise<void> {
  const selections: string[][] = []
  const labels: string[] = []
  for (const [index, question] of questions.entries()) {
    const parsed = await askChoiceQuestion(question, { index, total: questions.length })
    if (parsed.kind === 'cancel') {
      try {
        await sendApproval(authToken, approval.approvalId, 'no')
        process.stderr.write(`   ✓ Cancelled.\n\n`)
      } catch (err) {
        process.stderr.write(
          `   Failed to send response: ${err instanceof Error ? err.message : String(err)}\n\n`,
        )
      }
      return
    }
    if (parsed.kind !== 'select') return
    selections.push(parsed.values)
    labels.push(parsed.labels.join(', '))
  }

  try {
    await sendApproval(authToken, approval.approvalId, 'yes', selections)
    process.stderr.write(`   ✓ Answered: ${labels.join(' | ')}.\n\n`)
  } catch (err) {
    process.stderr.write(
      `   Failed to send response: ${err instanceof Error ? err.message : String(err)}\n\n`,
    )
  }
}
