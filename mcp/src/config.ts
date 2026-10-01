/**
 * Environment contract (docs/plans/2026-09-29-sai-api-mvp.md §7–§8).
 *
 * - SAI_API_KEY   required. Either an API key (`sapi_…`) or a Firebase ID token;
 *                 both travel as `Authorization: Bearer`.
 * - SAI_API_URL   cloud-api base URL; defaults to production.
 * - SAI_API_VERSION_TAG  staging only: sent as `x-sai-version` to reach a PR preview.
 * - SAI_PUSH      `1` → Claude Code channel mode: `sai_task_start` returns
 *                 `push: true` and the server watches the session itself.
 * - SAI_LOCAL_VIEW `0` → no local task page (`watch_url`) for hosts without MCP Apps.
 * - SAI_EVENTS_API `0` → collect the `POST /message` SSE stream instead of A1 (`wait: false`) + A2 (`GET /events`), which is the default; the flag exists for
 *                 collecting the SSE stream in-process. Off until they deploy.
 */

export const DEFAULT_API_URL = 'https://api.simular.ai'

/** Approval links open the production web app regardless of SAI_API_URL (§5). */
export const APPROVAL_URL_BASE = 'https://sai.simular.ai/approval'

export interface Config {
  apiKey: string
  apiUrl: string
  push: boolean
  eventsApi: boolean
  /** Serve the task view on 127.0.0.1 and link it from `sai_task_start` (local-view.ts). */
  localView: boolean
  /** Staging Version Tag (`x-sai-version`) for PR previews; unset in normal use. */
  versionTag?: string
}

function flag(value: string | undefined): boolean {
  return value === '1' || value === 'true'
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const apiKey = env.SAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'SAI_API_KEY is not set. Create an API key at https://platform.simular.ai/api-keys ' +
        'and export it as SAI_API_KEY.',
    )
  }
  const apiUrl = (env.SAI_API_URL?.trim() || DEFAULT_API_URL).replace(/\/+$/, '')
  return {
    apiKey,
    apiUrl,
    push: flag(env.SAI_PUSH),
    // Default ON: `wait:false` + `GET /events` is the contract callers are
    // documented against and the only mode without the stream's 5-minute
    // ceiling. `SAI_EVENTS_API=0` falls back to collecting the SSE stream, for a
    // server predating A1/A2.
    eventsApi: env.SAI_EVENTS_API === undefined ? true : flag(env.SAI_EVENTS_API),
    localView: env.SAI_LOCAL_VIEW === undefined ? true : flag(env.SAI_LOCAL_VIEW),
    ...(env.SAI_API_VERSION_TAG?.trim() && { versionTag: env.SAI_API_VERSION_TAG.trim() }),
  }
}
