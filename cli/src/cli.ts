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
  resumeSession,
  restartTarget,
  startNewSession,
  streamMessage,
  sendApproval,
} from './sai/client.js'
import type { MachineInfo, SessionSummary, SseEvent } from './sai/client.js'
import { classifyMessage } from './concierge/index.js'
import { queryContext } from './context/query.js'
import { uploadFile } from './upload/simulang.js'
import { CLOUD_API_URL, RESPONSE_TIMEOUT_MS } from './config.js'
import { parseDuration, formatDuration } from './cli-utils.js'

const program = new Command()

program.name('sapi').description('CLI for Sai — your Simular AI agent').version('0.1.0')

program.addHelpText(
  'after',
  `
Examples:
  $ sapi login                                   Sign in with Google (opens browser)
  $ sapi whoami                                  Show current authenticated user
  $ sapi machine                                 Choose a Sai workspace (run again to switch)
  $ sapi new                                     Start a fresh conversation on the current workspace
  $ sapi -m summarise my unread emails           Send a task to Sai (messages use -m/--message)
  $ sapi -m what have you done recently?         Ask about past activity
  $ sapi -m login                                Send a one-word message, even one matching a command name
  $ sapi -f report.pdf -m review this            Attach a file
  $ sapi -f before.png -f after.png -m what changed?  Attach multiple files
  $ sapi -v 0 -m take a screenshot               Quiet mode (suppress narrations)
  $ sapi -v 2 -m close apps and check gmail      Show script progress lines and debug info
  $ sapi -v 3 -m do a task                       Show raw SSE event stream (debug)
  $ sapi config set verbose 2                    Set default verbosity level to 2
  $ sapi abort                                   Abort the currently running task
  $ sapi sessions                                List recent conversations
  $ sapi resume <sessionId>                      Resume a previous conversation
  $ sapi restart agent                           Restart the Sai agent process
  $ sapi restart machine                         Restart the cloud machine

  $ sapi key generate --name dev                 Generate an API key
  $ SAPI_API_KEY=sapi_... sapi -m do a task      Use an API key directly

Environment:
  SAPI_API_KEY    Long-lived API key; bypasses Firebase session entirely
  SAPI_API_URL    Override cloud-api base URL (default: https://api.sai.simular.ai)

Files:
  ~/.sapi/credentials.json   Firebase ID token, expiry, and email
  ~/.sapi/session.json       Selected machine ID
  ~/.sapi/.mk                AES-256-GCM machine key (generated once at login)
  ~/.sapi/.rt                Encrypted refresh token
  ~/.sapi/.ak                Encrypted API key (if generated)`,
)

/**
 * Returns the auth token to use for API requests.
 * Priority: SAPI_API_KEY env var > ~/.sapi/.ak (encrypted) > Firebase ID token.
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
        `Already authenticated as ${existing.email} (session valid for ${remainingHuman} more). Run \`sapi logout\` first to switch accounts.`,
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
      console.log(`  Session valid for ${hours}h. Run \`sapi login\` again to refresh early.`)
      console.log(`\nNext: run \`sapi machine\` to choose a workspace.`)
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
        `  Note: your API key was not cleared. It remains valid until revoked.\n  Run \`sapi key revoke <keyId>\` to remove it, or set SAPI_API_KEY="" to ignore it.`,
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
        const label = m.name ?? m.machineId
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
      console.error('No workspace selected. Run `sapi machine` to choose one first.')
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

const configCmd = program.command('config').description('View and set sapi preferences')

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
  .description('Generate a long-lived API key (stored encrypted in ~/.sapi/.ak)')
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
      const res = await fetch(`${CLOUD_API_URL}/v1/account/keys`, {
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
      console.log(`\n✓ API key generated (id: ${keyId}) and saved to ~/.sapi/.ak`)
      console.log(`  Future sapi commands will use this key instead of your Firebase session.`)
      console.log(`  For CI or devices: export SAPI_API_KEY="${key}"`)
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
      const res = await fetch(`${CLOUD_API_URL}/v1/account/keys/${encodeURIComponent(keyId)}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${authToken}` },
      })
      if (res.status === 404) {
        const looksLikeName = !/^[A-Za-z0-9]{20}$/.test(keyId)
        console.error(
          looksLikeName
            ? `Key "${keyId}" not found. Use the key ID, not the name — run \`sapi key list\` to find it.`
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
      const res = await fetch(`${CLOUD_API_URL}/v1/account/keys`, {
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
        console.log('No API keys. Run `sapi key generate` to create one.')
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
      console.error('No workspace selected. Run `sapi machine` to choose one first.')
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
      console.error('No workspace selected. Run `sapi machine` to choose one first.')
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
      const marker = s.active ? '  ✓ (active)' : ''
      console.log(`  ${s.sessionId}  ${s.title}  (${date})${marker}`)
    }
    console.log('')
    console.log(`Run \`sapi resume <sessionId>\` to switch to a session.`)
    console.log('')
  })

// ─── resume ───────────────────────────────────────────────────────────────────

program
  .command('resume <sessionId>')
  .description('Resume a previous conversation by session ID (see `sapi sessions`)')
  .action(async (sessionId: string) => {
    let authToken: string
    try {
      authToken = await resolveAuthToken()
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }

    const session = loadSession()
    if (!session) {
      console.error('No workspace selected. Run `sapi machine` to choose one first.')
      process.exit(1)
    }

    try {
      await resumeSession(authToken, session.machineId, sessionId)
      console.log(`✓ Resumed session ${sessionId}`)
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err))
      process.exit(1)
    }
  })

// ─── restart ──────────────────────────────────────────────────────────────────

program
  .command('restart <target>')
  .description('Restart the Sai agent or cloud machine (target: agent | machine)')
  .action(async (target: string) => {
    if (target !== 'agent' && target !== 'machine') {
      console.error(
        `error: unknown restart target '${target}'\nUse: sapi restart agent  or  sapi restart machine`,
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
      console.error('No workspace selected. Run `sapi machine` to choose one first.')
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

program
  .option(
    '-f, --file <path>',
    'Attach a file to the message; repeat for multiple files',
    (val: string, prev: string[]) => [...prev, val],
    [] as string[],
  )
  .option(
    '-v, --verbose <n>',
    'Verbosity level: 0=quiet, 1=narrations, 2=+script progress lines+debug info, 3=+raw SSE (default: from `sapi config`, initially 1)',
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
  // error — sapi no longer accepts a message as a positional argument.
  .argument('[ignored...]', 'Deprecated: pass your message with --message/-m instead')
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
    // that collides with a command name (e.g. `sapi -m login` sends "login"
    // rather than running the login command).
    const messageText =
      opts.message && opts.message.length > 0
        ? opts.message.join(' ')
        : opts.input && opts.input.length > 0
          ? opts.input.join(' ')
          : undefined

    if (!messageText) {
      // A bare positional message (quoted or not) is no longer supported — the
      // shell strips quotes and splits words before sapi runs, so it can't be
      // distinguished from a command. Point the user at -m.
      if (positionalArgs && positionalArgs.length > 0) {
        const attempted = positionalArgs.join(' ')
        const known = program.commands.map((c) => c.name()).join(', ')
        console.error(
          `error: sapi doesn't take a message as a positional argument — use the --message/-m flag:\n` +
            `  sapi -m ${attempted}\n\n` +
            `(Quoting, e.g. \`sapi "${attempted}"\`, isn't supported either: the shell strips the quotes before sapi runs.)\n` +
            `Available commands: ${known}. Run \`sapi --help\` for details.`,
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

    // 2. Resolve session — must have run `sapi machine` first
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
          const label = m.name ?? m.machineId
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
        console.error('No workspace selected. Run `sapi machine` to choose one, then try again.')
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

    // 4. Concierge classification — instant heuristic, no network call
    const classification = classifyMessage(messageText)
    if (verbosity >= 2) {
      process.stderr.write(`[concierge] classified as: ${classification}\n`)
    }

    if (classification === 'context') {
      process.stderr.write('Checking context...\n')
      let answer: string | null = null
      try {
        answer = await queryContext(authToken, session.machineId, messageText)
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }

      if (answer !== null) {
        console.log(answer)
        return
      }
      // null = Haiku determined it's not actually a context question → fall through to task
      if (verbosity >= 2) {
        process.stderr.write('[concierge] reclassified as: task (forwarded by context handler)\n')
      }
    }

    // 5. Task: stream response from Sai via SSE
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
              downloadUrl: a.downloadUrl,
            }))
          : undefined,
        async (event: SseEvent) => {
          if (sigintFired) return
          switch (event.type) {
            case 'data-status':
              process.stderr.write(`\n${event.data.text}\n\n`)
              break
            case 'text-start':
              // Blank line separating preceding verbose output from the response block.
              if (lastWasVerbose) {
                process.stderr.write('\n')
                lastWasVerbose = false
              }
              break
            case 'text-delta':
              if (event.delta) process.stdout.write(event.delta)
              break
            case 'reasoning-delta':
              // Mid-turn narration between tool calls (verbosity 1+).
              if (verbosity >= 1 && event.delta.trim()) {
                process.stderr.write(`[sai] ${event.delta.trim()}\n`)
                lastWasVerbose = true
              }
              break
            case 'tool-input-start':
              toolCallIdToName.set(event.toolCallId, event.toolName)
              break
            case 'data-progress':
              // Script progress lines (verbosity 2+).
              if (verbosity >= 2) {
                process.stderr.write(`[${event.data.tool}] ${event.data.text}\n`)
                lastWasVerbose = true
              }
              break
            case 'tool-output-error': {
              // Always shown — tool failures are signal, not noise.
              const errToolName = toolCallIdToName.get(event.toolCallId) ?? 'tool'
              process.stderr.write(`[${errToolName}] ✗ ${event.errorText}\n`)
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
      process.exit(1)
    } finally {
      process.off('SIGINT', onSigint)
    }

    if (lastError) {
      console.error(lastError)
      process.exit(1)
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
  process.stderr.write('\n')
  if (approval.isLinkOnly) {
    // Requires browser/form interaction — can't be resolved from the terminal.
    process.stderr.write(`⚠  Action needed in desktop app: ${approval.title}\n`)
    if (approval.description) process.stderr.write(`   ${approval.description}\n`)
    process.stderr.write(`   Open the Sai desktop app to continue.\n\n`)
    return
  }

  process.stderr.write(`⚠  Permission request: ${approval.title}\n`)
  if (approval.description) process.stderr.write(`   ${approval.description}\n`)

  if (!process.stdin.isTTY) {
    // Non-interactive (e.g. piped/CI) — can't prompt; let the user handle it in the app.
    process.stderr.write(`   (Non-interactive terminal — approve in the desktop app.)\n\n`)
    return
  }

  const rl = createInterface({ input: process.stdin, output: process.stderr })
  const prompt = approval.allowAlways
    ? '   Allow? [once / deny / always] (once): '
    : '   Allow? [once / deny] (once): '
  const answer = await new Promise<'yes' | 'no' | 'always'>((resolve) => {
    rl.question(prompt, (raw) => {
      rl.close()
      const a = raw.trim().toLowerCase()
      if (approval.allowAlways && a === 'always') resolve('always')
      else if (a === 'deny' || a === 'no' || a === 'n' || a === 'd') resolve('no')
      else resolve('yes') // default to once on Enter / any other input
    })
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
