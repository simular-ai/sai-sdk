import { homedir } from 'os'
import { join } from 'path'
import { readFileSync, writeFileSync, chmodSync, mkdirSync, existsSync, unlinkSync } from 'fs'
import { createCipheriv, createDecipheriv, randomBytes } from 'crypto'
import {
  DEFAULT_SESSION_TIMEOUT_MS,
  FIREBASE_WEB_API_KEY,
  REFRESH_EXTENSION_MS,
} from '../config.js'

const SAPI_DIR = join(homedir(), '.sapi')
const CREDENTIALS_PATH = join(SAPI_DIR, 'credentials.json')
const SESSION_PATH = join(SAPI_DIR, 'session.json')
const CONFIG_PATH = join(SAPI_DIR, 'config.json')
const MACHINE_KEY_PATH = join(SAPI_DIR, '.mk')
const REFRESH_TOKEN_PATH = join(SAPI_DIR, '.rt')
const API_KEY_PATH = join(SAPI_DIR, '.ak')
const API_KEY_ID_PATH = join(SAPI_DIR, '.akid')
export interface Credentials {
  idToken: string
  refreshToken: string
  /** When the Firebase ID token expires (issued + 1h). Refresh before this. */
  idTokenExpiresAt: number
  /** When the whole session expires (user-configured timeout). */
  sessionExpiresAt: number
  email: string
  userId: string
  sessionTimeoutMs: number
}

export interface SessionInfo {
  machineId: string
}

function ensureSapiDir(): void {
  if (!existsSync(SAPI_DIR)) {
    mkdirSync(SAPI_DIR, { recursive: true, mode: 0o700 })
  }
}

// ─── Refresh token storage ─────────────────────────────────────────────────
//
// The refresh token is never written to credentials.json. It is AES-256-GCM
// encrypted with a per-install machine key stored at ~/.sapi/.mk (0o600).
// The ciphertext lives at ~/.sapi/.rt (0o600). Both files are separate from
// credentials.json so the token is never in the clear on disk.

function getMachineKey(): Buffer {
  if (existsSync(MACHINE_KEY_PATH)) {
    return Buffer.from(readFileSync(MACHINE_KEY_PATH, 'utf-8').trim(), 'hex')
  }
  const key = randomBytes(32)
  writeFileSync(MACHINE_KEY_PATH, key.toString('hex'), { encoding: 'utf-8', mode: 0o600 })
  return key
}

function encryptToken(token: string, key: Buffer): string {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const enc = Buffer.concat([cipher.update(token, 'utf-8'), cipher.final()])
  const tag = cipher.getAuthTag()
  // Layout: iv(24 hex chars) + tag(32 hex chars) + ciphertext(hex)
  return iv.toString('hex') + tag.toString('hex') + enc.toString('hex')
}

function decryptToken(stored: string, key: Buffer): string | null {
  try {
    const iv = Buffer.from(stored.slice(0, 24), 'hex')
    const tag = Buffer.from(stored.slice(24, 56), 'hex')
    const enc = Buffer.from(stored.slice(56), 'hex')
    const decipher = createDecipheriv('aes-256-gcm', key, iv)
    decipher.setAuthTag(tag)
    return decipher.update(enc).toString('utf-8') + decipher.final('utf-8')
  } catch {
    return null
  }
}

function storeRefreshToken(_userId: string, token: string): void {
  ensureSapiDir()
  const key = getMachineKey()
  writeFileSync(REFRESH_TOKEN_PATH, encryptToken(token, key), { encoding: 'utf-8', mode: 0o600 })
}

function loadRefreshToken(_userId: string): string | null {
  if (!existsSync(REFRESH_TOKEN_PATH)) return null
  const key = getMachineKey()
  return decryptToken(readFileSync(REFRESH_TOKEN_PATH, 'utf-8').trim(), key)
}

function deleteRefreshToken(_userId: string): void {
  if (existsSync(REFRESH_TOKEN_PATH)) {
    try {
      unlinkSync(REFRESH_TOKEN_PATH)
    } catch {
      /* ignore */
    }
  }
  if (existsSync(MACHINE_KEY_PATH)) {
    try {
      unlinkSync(MACHINE_KEY_PATH)
    } catch {
      /* ignore */
    }
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function saveCredentials(params: {
  firebaseIdToken: string
  refreshToken: string
  idTokenExpiresIn: number
  email: string
  userId: string
  sessionTimeoutMs?: number
}): Credentials {
  ensureSapiDir()
  const sessionTimeoutMs = params.sessionTimeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS
  const creds: Credentials = {
    idToken: params.firebaseIdToken,
    refreshToken: params.refreshToken,
    idTokenExpiresAt: Date.now() + params.idTokenExpiresIn * 1000,
    sessionExpiresAt: Date.now() + sessionTimeoutMs,
    email: params.email,
    userId: params.userId,
    sessionTimeoutMs,
  }
  // Write credentials.json without the refresh token
  const { refreshToken: _rt, ...stored } = creds
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(stored, null, 2), { encoding: 'utf-8' })
  chmodSync(CREDENTIALS_PATH, 0o600)
  storeRefreshToken(params.userId, params.refreshToken)
  return creds
}

export function loadCredentials(): Credentials | null {
  if (!existsSync(CREDENTIALS_PATH)) return null
  let stored: Omit<Credentials, 'refreshToken'>
  try {
    stored = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'))
  } catch {
    return null
  }

  const refreshToken = loadRefreshToken(stored.userId)
  if (!refreshToken) return null

  return { ...stored, refreshToken }
}

export function clearCredentials(): void {
  // Clears the Firebase session (credentials.json, refresh token, machine key,
  // session.json). Does NOT clear API keys — they are independent long-lived
  // credentials that survive logout. Use `sapi key revoke` to remove a key.
  deleteRefreshToken('')
  if (existsSync(CREDENTIALS_PATH)) unlinkSync(CREDENTIALS_PATH)
  if (existsSync(SESSION_PATH)) unlinkSync(SESSION_PATH)
}

// ─── API key storage ───────────────────────────────────────────────────────────
//
// API keys (sapi_<base64url>) are AES-256-GCM encrypted with the same machine
// key used for the refresh token. The SAPI_API_KEY env var overrides file storage
// entirely — useful for CI and devices where writing to disk is undesirable.

export function saveApiKey(apiKey: string, keyId?: string): void {
  ensureSapiDir()
  const key = getMachineKey()
  writeFileSync(API_KEY_PATH, encryptToken(apiKey, key), { encoding: 'utf-8', mode: 0o600 })
  if (keyId) {
    writeFileSync(API_KEY_ID_PATH, keyId, { encoding: 'utf-8', mode: 0o600 })
  }
}

export function loadApiKeyId(): string | null {
  if (!existsSync(API_KEY_ID_PATH)) return null
  return readFileSync(API_KEY_ID_PATH, 'utf-8').trim() || null
}

export function loadApiKey(): string | null {
  const envKey = process.env.SAPI_API_KEY
  if (envKey) return envKey
  if (!existsSync(API_KEY_PATH)) return null
  const key = getMachineKey()
  return decryptToken(readFileSync(API_KEY_PATH, 'utf-8').trim(), key)
}

export function clearApiKey(): void {
  for (const p of [API_KEY_PATH, API_KEY_ID_PATH]) {
    if (existsSync(p)) {
      try { unlinkSync(p) } catch { /* ignore */ }
    }
  }
}

// ─── Config storage ────────────────────────────────────────────────────────────

export interface SapiConfig {
  verbose?: number
  /** Inactivity timeout in ms for `sapi "<message>"`. Set via `sapi config set timeout`. */
  timeoutMs?: number
}

export function loadConfig(): SapiConfig {
  if (!existsSync(CONFIG_PATH)) return {}
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as SapiConfig
  } catch {
    return {}
  }
}

export function saveConfig(updates: Partial<SapiConfig>): SapiConfig {
  ensureSapiDir()
  const current = loadConfig()
  const merged = { ...current, ...updates }
  writeFileSync(CONFIG_PATH, JSON.stringify(merged, null, 2), { encoding: 'utf-8', mode: 0o600 })
  return merged
}

export function resetConfig(): void {
  if (existsSync(CONFIG_PATH)) {
    try {
      unlinkSync(CONFIG_PATH)
    } catch {
      /* ignore */
    }
  }
}

export function saveSession(session: SessionInfo): void {
  ensureSapiDir()
  // Only persist machineId — the server always resolves the active sessionId
  // from user_machines, so caching it locally would be stale after any session reset.
  writeFileSync(SESSION_PATH, JSON.stringify({ machineId: session.machineId }, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  })
}

export function loadSession(): SessionInfo | null {
  if (!existsSync(SESSION_PATH)) return null
  try {
    return JSON.parse(readFileSync(SESSION_PATH, 'utf-8')) as SessionInfo
  } catch {
    return null
  }
}

/**
 * Returns valid credentials with a fresh ID token, refreshing if necessary.
 * Throws if not logged in or the session timeout has passed.
 */
export async function requireAuth(): Promise<Credentials> {
  const creds = loadCredentials()
  if (!creds) {
    throw new Error('Not authenticated. Run `sapi login` to sign in.')
  }
  if (Date.now() > creds.sessionExpiresAt) {
    throw new Error('Session expired. Run `sapi login` to sign in again.')
  }

  // Firebase ID tokens expire after 1 hour — refresh when within 5 minutes of expiry
  if (Date.now() > creds.idTokenExpiresAt - 5 * 60 * 1000) {
    return refreshIdToken(creds)
  }

  return creds
}

async function refreshIdToken(creds: Credentials): Promise<Credentials> {
  const res = await fetch(
    `https://securetoken.googleapis.com/v1/token?key=${FIREBASE_WEB_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(creds.refreshToken)}`,
    },
  )

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: { message?: string } }
    throw new Error(
      `Token refresh failed: ${body.error?.message ?? res.statusText}. Run \`sapi login\` to sign in again.`,
    )
  }

  const data = (await res.json()) as {
    id_token: string
    refresh_token: string
    expires_in: string
  }

  // Extend the session expiry if it would otherwise expire within REFRESH_EXTENSION_MS
  const prevSessionExpiresAt = creds.sessionExpiresAt
  const newSessionExpiresAt = Math.max(prevSessionExpiresAt, Date.now() + REFRESH_EXTENSION_MS)

  const updated: Credentials = {
    ...creds,
    idToken: data.id_token,
    refreshToken: data.refresh_token,
    idTokenExpiresAt: Date.now() + parseInt(data.expires_in, 10) * 1000,
    sessionExpiresAt: newSessionExpiresAt,
  }

  // Write credentials.json without the refresh token; update secure storage
  const { refreshToken: _rt, ...stored } = updated
  writeFileSync(CREDENTIALS_PATH, JSON.stringify(stored, null, 2), { encoding: 'utf-8' })
  chmodSync(CREDENTIALS_PATH, 0o600)
  storeRefreshToken(updated.userId, data.refresh_token)

  // Only notify if the session was actually extended (skip if already had >24h remaining)
  if (newSessionExpiresAt > prevSessionExpiresAt) {
    const extensionMs = newSessionExpiresAt - prevSessionExpiresAt
    const extensionHours = Math.round(extensionMs / 3_600_000)
    const until = new Date(newSessionExpiresAt).toLocaleString()
    console.log(`Token refreshed. Session extended by ${extensionHours}h (until ${until}).`)
  }

  return updated
}
