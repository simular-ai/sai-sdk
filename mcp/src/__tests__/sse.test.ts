import { describe, expect, it } from 'vitest'
import { parseFrame, parseSse } from '../sse.js'

describe('parseFrame', () => {
  it('parses data frames and ignores comments, [DONE] and junk', () => {
    expect(parseFrame('data: {"type":"finish"}')).toEqual({ type: 'finish' })
    expect(parseFrame(': keepalive')).toBeUndefined()
    expect(parseFrame('data: [DONE]')).toBeUndefined()
    expect(parseFrame('data: {not json')).toBeUndefined()
    expect(parseFrame('data: {"noType":1}')).toBeUndefined()
  })
})

describe('parseSse', () => {
  it('reassembles frames split across chunks', async () => {
    const encoder = new TextEncoder()
    const chunks = [
      'data: {"type":"text-delta","id":"a","de',
      'lta":"hi"}\n\ndata: {"type":"fini',
      'sh"}\n\ndata: [DONE]\n\n',
    ]
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const chunk of chunks) c.enqueue(encoder.encode(chunk))
        c.close()
      },
    })
    const events = []
    for await (const e of parseSse(body)) events.push(e)
    expect(events).toEqual([{ type: 'text-delta', id: 'a', delta: 'hi' }, { type: 'finish' }])
  })
})
