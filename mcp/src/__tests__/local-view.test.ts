import { request } from 'node:http'
import { describe, expect, it, vi } from 'vitest'

import { LocalView } from '../local-view.js'

function http(
  url: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: Record<string, unknown>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { method: init.method ?? 'GET', headers: init.headers }, (res) => {
      let body = ''
      res.on('data', (c: Buffer) => (body += c.toString()))
      res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end(init.body)
  })
}

async function setup() {
  const call = vi.fn().mockResolvedValue({ content: [{ type: 'text', text: '{}' }] })
  const view = new LocalView({ html: () => '<html>view</html>', call, log: () => {} })
  const page = new URL(await view.urlFor('s1', 'm1', 'k1'))
  const origin = page.origin
  const token = page.searchParams.get('t')!
  const tool = (body: unknown, headers: Record<string, string> = {}) =>
    http(`${origin}/tool`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: origin,
        'x-sai-token': token,
        ...headers,
      },
      body: JSON.stringify(body),
    })
  return { call, page, origin, token, tool }
}

describe('local task view', () => {
  it('links a 127.0.0.1 page for the task, with a token', async () => {
    const { page, token } = await setup()
    expect(page.hostname).toBe('127.0.0.1')
    expect(page.pathname).toBe('/task')
    expect(page.searchParams.get('s')).toBe('s1')
    expect(page.searchParams.get('m')).toBe('m1')
    expect(page.searchParams.get('k')).toBe('k1')
    expect(token).toMatch(/^[0-9a-f]{48}$/)
  })

  it('serves the page only with the token, with a CSP and no Referer', async () => {
    const { page, origin } = await setup()
    const ok = await http(page.href)
    expect(ok.status).toBe(200)
    expect(ok.body).toBe('<html>view</html>')
    expect(ok.headers['content-security-policy']).toContain("default-src 'none'")
    expect(ok.headers['referrer-policy']).toBe('no-referrer')
    expect((await http(`${origin}/task?s=s1&t=nope`)).status).toBe(403)
  })

  it('rejects a foreign Host (DNS rebinding)', async () => {
    const { page } = await setup()
    const res = await http(page.href, { headers: { Host: `evil.example:${page.port}` } })
    expect(res.status).toBe(421)
  })

  it('runs an allowed tool for this origin and token', async () => {
    const { call, tool } = await setup()
    const res = await tool({ name: 'sai_view_poll', arguments: { session_id: 's1' } })
    expect(res.status).toBe(200)
    expect(call).toHaveBeenCalledWith('sai_view_poll', { session_id: 's1' })
  })

  it('refuses another origin, a bad token, non-JSON, and other tools', async () => {
    const { call, tool } = await setup()
    const body = { name: 'sai_task_approve', arguments: { approval_id: 'a', decision: 'approve' } }
    expect((await tool(body, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await tool(body, { 'x-sai-token': 'x'.repeat(48) })).status).toBe(403)
    expect((await tool(body, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await tool({ name: 'sai_task_start', arguments: { task: 'x' } })).status).toBe(404)
    expect(call).not.toHaveBeenCalled()
  })
})
