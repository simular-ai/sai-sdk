/**
 * HTTP helpers shared across the CLI.
 *
 * Node's global fetch rejects connection-level failures with an opaque
 * `TypeError: fetch failed` and tucks the real reason onto `.cause` — a TLS
 * certificate that doesn't cover the host, a DNS lookup that didn't resolve, a
 * refused connection, etc. Surfacing only `err.message` leaves the user staring
 * at "fetch failed" with no idea whether it's their network, a bad
 * SAPI_API_URL, or a broken server. These helpers translate that into an
 * actionable message naming the host and the underlying cause.
 */

import { VERSION } from './version.js'

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Turns a fetch rejection into a descriptive Error. Pass-through for errors that
 * already carry a useful message (anything that isn't the opaque connection
 * failure) so we never bury a clearer upstream message.
 */
export function toNetworkError(url: string, err: unknown): Error {
  const host = hostOf(url)

  if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
    return new Error(`Request to ${host} timed out.`)
  }

  const cause =
    err instanceof Error
      ? (err.cause as { code?: string; message?: string } | undefined)
      : undefined

  const detail =
    cause?.code === 'ERR_TLS_CERT_ALTNAME_INVALID'
      ? "the server's TLS certificate does not cover this hostname — the API's custom domain is likely misconfigured (no managed certificate)"
      : cause?.code === 'ENOTFOUND' || cause?.code === 'EAI_AGAIN'
        ? 'the host could not be resolved (DNS failure)'
        : cause?.code === 'ECONNREFUSED'
          ? 'the connection was refused'
          : (cause?.message ?? cause?.code ?? (err instanceof Error ? err.message : String(err)))

  return new Error(
    `Could not reach the Sai API at ${host}: ${detail}. ` +
      'Check your network connection and the SAPI_API_URL setting.',
  )
}

/**
 * Routes cloud-api requests to a tagged deployment (SAI_VERSION_TAG). An unknown
 * tag falls back to the default instance at the routing layer, so any value is
 * safe. Applied only in apiFetch so it never reaches the Google/Firebase token
 * exchanges, which use `fetch` directly.
 */
function versionTagHeader(): Record<string, string> {
  const tag = process.env.SAI_VERSION_TAG?.trim()
  return tag ? { 'x-sai-version': tag } : {}
}

/**
 * Identifies this client to cloud-api, which records it per API key. Like the
 * version tag, applied only in apiFetch, never to the Google/Firebase token exchanges.
 */
const USER_AGENT = `sai-cli/${VERSION}`

/**
 * fetch wrapper that converts connection-level failures into actionable errors.
 * Successful responses (including non-2xx) pass straight through — callers still
 * handle HTTP status codes themselves.
 */
export async function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  const headers = {
    'User-Agent': USER_AGENT,
    ...(init?.headers as Record<string, string> | undefined),
    ...versionTagHeader(),
  }
  try {
    return await fetch(url, { ...init, headers })
  } catch (err) {
    throw toNetworkError(url, err)
  }
}
