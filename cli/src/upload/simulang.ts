import { readFileSync, statSync } from 'fs'
import { basename } from 'path'
import { CLOUD_API_URL } from '../config.js'
import { apiFetch } from '../http.js'
import { errorDetail } from '../sai/client.js'

export interface UploadedFile {
  path: string
  name: string
  mime: string
  size: number
  fileId: string
}

const MAX_FILE_BYTES = 25 * 1024 * 1024 // 25MB

/**
 * Uploads a local file to Firebase Storage via the cloud-api upload endpoint.
 * Returns the attachment metadata to include in a message.
 *
 * The server derives MIME type from the filename extension — the Content-Type
 * header sent here is ignored server-side and is always application/octet-stream.
 */
export async function uploadFile(authToken: string, filePath: string): Promise<UploadedFile> {
  const name = basename(filePath)

  let stat: ReturnType<typeof statSync>
  try {
    stat = statSync(filePath)
  } catch {
    throw new Error(`File not found: "${filePath}"`)
  }

  if (stat.size > MAX_FILE_BYTES) {
    throw new Error(
      `File "${name}" is too large (${Math.round(stat.size / (1024 * 1024))}MB). Maximum is 25MB.`,
    )
  }

  let buffer: Buffer
  try {
    buffer = readFileSync(filePath)
  } catch (err) {
    throw new Error(
      `Cannot read "${filePath}": ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  const res = await apiFetch(`${CLOUD_API_URL}/v1/agents/upload`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'x-filename': encodeURIComponent(name),
      Authorization: `Bearer ${authToken}`,
    },
    body: buffer as unknown as BodyInit,
    signal: AbortSignal.timeout(60_000),
  })

  if (!res.ok) {
    const body: unknown = await res.json().catch(() => ({}))
    throw new Error(`Upload failed (${res.status}): ${errorDetail(body, res.statusText)}`)
  }

  return (await res.json()) as UploadedFile
}
