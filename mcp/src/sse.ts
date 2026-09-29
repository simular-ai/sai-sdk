import type { SseEvent } from './types.js'

/**
 * Parses an AI SDK UI message stream (`data: {...}\n\n` frames) into events.
 * Comment lines (`: keepalive`) and the `[DONE]` sentinel are dropped;
 * malformed frames are skipped rather than aborting the stream.
 */
export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop() ?? ''
      for (const part of parts) {
        const event = parseFrame(part)
        if (event) yield event
      }
    }
    const tail = parseFrame(buffer)
    if (tail) yield tail
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

export function parseFrame(part: string): SseEvent | undefined {
  const line = part.trim()
  if (!line.startsWith('data: ')) return undefined
  const json = line.slice('data: '.length)
  if (json === '[DONE]') return undefined
  try {
    const parsed = JSON.parse(json) as { type?: unknown }
    if (typeof parsed.type !== 'string') return undefined
    return parsed as SseEvent
  } catch {
    return undefined
  }
}
