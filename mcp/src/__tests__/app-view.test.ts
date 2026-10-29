import { describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'

import {
  LIVE_ORIGINS,
  MCP_APP_MIME,
  TASK_VIEW_URI,
  playgroundUrl,
  registerTaskView,
} from '../app-view.js'
import { SaiApi } from '../api.js'
import { TaskLog } from '../task-log.js'
import {
  applyPoll,
  headline,
  humanTool,
  initialView,
  inlineMarkdown,
  isDone,
  type TaskView,
} from '../ui/view-model.js'

async function connect(
  wait = vi.fn(),
  liveScreen = vi.fn().mockResolvedValue({ websocketUrl: 'wss://x', width: 1, height: 1 }),
  tasks = new TaskLog(),
) {
  const server = new McpServer({ name: 'sai', version: 'test' })
  registerTaskView(server, {
    wait,
    apiUrl: 'https://api.simular.ai',
    run: async (fn) => {
      const r = await fn()
      return {
        content: [{ type: 'text', text: JSON.stringify(r) }],
        structuredContent: r as Record<string, unknown>,
      }
    },
    liveScreen,
    tasks,
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  const client = new Client({ name: 'host', version: 'test' })
  await Promise.all([server.connect(a), client.connect(b)])
  return { client, wait, liveScreen }
}

describe('MCP Apps task view (server)', () => {
  it('serves the view as an MCP App resource allowing only the live-screen proxy', async () => {
    const { client } = await connect()
    const res = await client.readResource({ uri: TASK_VIEW_URI })
    const c = res.contents[0] as {
      mimeType: string
      text: string
      _meta?: { ui?: { csp?: unknown } }
    }
    expect(c.mimeType).toBe(MCP_APP_MIME)
    expect(c.text).toContain('<html')
    expect(c._meta?.ui?.csp).toEqual({ connectDomains: LIVE_ORIGINS, resourceDomains: [] })
  })

  it('declares sai_view_poll app-only, and it waits briefly and adds the Playground link', async () => {
    const wait = vi
      .fn()
      .mockResolvedValue({ status: 'running', events: [], text: '', cursor: 'c1' })
    const { client } = await connect(wait)
    const { tools } = await client.listTools()
    const poll = tools.find((t) => t.name === 'sai_view_poll')!
    expect(poll._meta).toEqual({ ui: { resourceUri: TASK_VIEW_URI, visibility: ['app'] } })

    const r = await client.callTool({
      name: 'sai_view_poll',
      arguments: { session_id: 's1', cursor: 'c0' },
    })
    expect(wait).toHaveBeenCalledWith({ session_id: 's1', cursor: 'c0', timeout_s: 20 })
    expect(r.structuredContent).toMatchObject({
      cursor: 'c1',
      playground_url: 'https://platform.simular.ai/playground',
    })
  })

  it('declares sai_view_live app-only and returns the tunnel for that machine', async () => {
    const liveScreen = vi.fn().mockResolvedValue({
      websocketUrl: 'wss://proxy.vm.api.simular.cloud/t?token=x',
      width: 1920,
      height: 1080,
    })
    const { client } = await connect(vi.fn(), liveScreen)
    const { tools } = await client.listTools()
    expect(tools.find((t) => t.name === 'sai_view_live')!._meta).toEqual({
      ui: { resourceUri: TASK_VIEW_URI, visibility: ['app'] },
    })
    const r = await client.callTool({ name: 'sai_view_live', arguments: { machine_id: 'm1' } })
    expect(liveScreen).toHaveBeenCalledWith('m1')
    expect(r.structuredContent).toEqual({
      websocket_url: 'wss://proxy.vm.api.simular.cloud/t?token=x',
      width: 1920,
      height: 1080,
    })

    // The hosted page, when the server offers one.
    liveScreen.mockResolvedValueOnce({
      websocketUrl: 'wss://proxy.vm.api.simular.cloud/t?token=y',
      width: 1920,
      height: 1080,
      liveUrl: 'https://api.simular.ai/live#t=lp1.x.y',
      expiresAt: 1790001800000,
    })
    const withPage = await client.callTool({
      name: 'sai_view_live',
      arguments: { machine_id: 'm1' },
    })
    expect(withPage.structuredContent).toMatchObject({
      live_url: 'https://api.simular.ai/live#t=lp1.x.y',
      expires_at: 1790001800000,
    })
  })

  it('returns 409 and 429 from /live as an outcome the view backs off on, with Retry-After', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ error: 'machine_not_running', message: 'The computer is starting.' }),
          { status: 409 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate_limited', message: 'Too many requests.' }), {
          status: 429,
          headers: { 'Retry-After': '42' },
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 7 }), {
          status: 429,
        }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: 'Machine not found.' }), { status: 404 }),
      )
    const api = new SaiApi('https://api.test', 'k', fetchImpl)
    const { client } = await connect(
      vi.fn(),
      vi.fn((id: string) => api.liveScreen(id)),
    )
    const call = () => client.callTool({ name: 'sai_view_live', arguments: { machine_id: 'm1' } })

    const booting = await call()
    expect(booting.isError).toBeFalsy()
    expect(booting.structuredContent).toEqual({ unavailable: 'machine_not_running', status: 409 })
    expect((await call()).structuredContent).toEqual({
      unavailable: 'rate_limited',
      status: 429,
      retry_after_s: 42,
    })
    expect((await call()).structuredContent).toMatchObject({ status: 429, retry_after_s: 7 })
    // Anything else is still a failure.
    expect(await call()).toMatchObject({ isError: true })
  })

  it('shows an older task its saved view, not the newer live turn', async () => {
    const wait = vi.fn().mockResolvedValue({ status: 'running', events: [], text: '', cursor: 'c' })
    const tasks = new TaskLog()
    const { client } = await connect(wait, undefined, tasks)
    const first = tasks.start('s1')
    const snapshot = {
      status: 'idle',
      steps: [{ title: 'Opening Notepad' }],
      text: 'Done',
      frame: 'data:image/jpeg;base64,AAAA',
    }
    const saved = await client.callTool({
      name: 'sai_view_save',
      arguments: { task_id: first, snapshot },
    })
    expect(saved.structuredContent).toEqual({ ok: true })
    tasks.start('s1') // a newer task on the same session

    const r = await client.callTool({
      name: 'sai_view_poll',
      arguments: { session_id: 's1', task_id: first },
    })
    expect(wait).not.toHaveBeenCalled()
    expect(r.structuredContent).toMatchObject({ archived: true, saved: snapshot })

    const gone = await client.callTool({
      name: 'sai_view_poll',
      arguments: { session_id: 's1', task_id: 'unknown' },
    })
    expect(gone.structuredContent).toMatchObject({ expired: true })
  })

  it('accepts only a JPEG data URL as the saved frame', async () => {
    const tasks = new TaskLog()
    const { client } = await connect(vi.fn(), undefined, tasks)
    const id = tasks.start('s1')
    const r = await client.callTool({
      name: 'sai_view_save',
      arguments: {
        task_id: id,
        snapshot: { status: 'idle', steps: [], text: '', frame: 'javascript:alert(1)' },
      },
    })
    expect(r.isError).toBe(true)
    expect(tasks.saved(id)).toBeUndefined()
  })

  it('points staging at the staging Playground', () => {
    expect(playgroundUrl('https://staging.cloud-api.simular.cloud')).toBe(
      'https://staging.platform.simular.cloud/playground',
    )
  })
})

describe('task view model', () => {
  it('turns events into readable steps and follows the status', () => {
    let v: TaskView = { ...initialView, sessionId: 's1', status: 'running' }
    v = applyPoll(v, {
      status: 'running',
      events: [
        { type: 'tool-input-start', toolCallId: 't', toolName: 'browser_navigate' },
        { type: 'data-progress', data: { text: 'Opened Notepad', tool: 'execute' } },
        { type: 'text-delta', id: 'x', delta: 'ignored' },
      ],
      cursor: 'c',
    })
    expect(v.steps).toEqual([{ title: 'Browser navigate', detail: 'Opened Notepad', callId: 't' }])
    expect(headline(v)).toBe('Browser navigate')

    v = applyPoll(v, {
      status: 'idle',
      events: [],
      text: 'The title is Untitled - Notepad',
      cursor: 'c2',
    })
    expect(isDone(v)).toBe(true)
    expect(headline(v)).toBe('Done')
    expect(v.text).toBe('The title is Untitled - Notepad')
  })

  it('shows an approval only while Sai waits on it', () => {
    const approval = {
      approvalId: 'a1',
      title: 'Run a command',
      description: 'rm temp',
      approvalType: 'command',
      isLinkOnly: false,
    }
    let v = applyPoll(initialView, { status: 'needs_approval', approval, cursor: 'c' })
    expect(v.approval).toEqual(approval)
    v = applyPoll(v, { status: 'running', cursor: 'c2' })
    expect(v.approval).toBeUndefined()
  })

  it('leaves out the code tool, recovered errors, diagnostics, raw output and repeats', () => {
    const v = applyPoll(initialView, {
      status: 'running',
      events: [
        { type: 'tool-input-start', toolCallId: '1', toolName: 'execute' },
        { type: 'data-progress', data: { text: 'Opening Notepad', tool: 'execute' } },
        { type: 'tool-output-error', toolCallId: '1', errorText: 'ReferenceError: machine' },
        { type: 'data-progress', data: { text: 'Opening Notepad', tool: 'execute' } },
        { type: 'data-progress', data: { text: '[Guardrails] ✅ type: allow', tool: 'execute' } },
        { type: 'data-progress', data: { text: '{"stdout":"","exitCode":0}', tool: 'execute' } },
        { type: 'data-progress', data: { text: '[]', tool: 'execute' } },
        {
          type: 'data-progress',
          data: { text: '[{"title":"","pid":5140},{"ti…', tool: 'execute' },
        },
        { type: 'data-progress', data: { text: 'Typing the text', tool: 'execute' } },
      ],
      cursor: 'c',
    })
    expect(v.steps).toEqual([{ title: 'Opening Notepad' }, { title: 'Typing the text' }])
  })

  it('titles each step by its tool call, with what it reported as the detail', () => {
    // As /events delivers them: the title echo of each call can be missing.
    const v = applyPoll(initialView, {
      status: 'running',
      events: [
        { type: 'tool-input-start', toolCallId: 'a', toolName: 'execute' },
        {
          type: 'tool-input-available',
          toolCallId: 'a',
          toolName: 'execute',
          input: { code: '…', title: 'Opening Notepad' },
        },
        { type: 'data-progress', data: { text: 'Untitled - Notepad', tool: 'execute' } },
        { type: 'tool-input-start', toolCallId: 'b', toolName: 'execute' },
        {
          type: 'tool-input-available',
          toolCallId: 'b',
          toolName: 'execute',
          input: { code: '…', title: 'Typing the text into Notepad' },
        },
        { type: 'data-progress', data: { text: 'Typing the text into Notepad', tool: 'execute' } },
        { type: 'data-progress', data: { text: '*hello - Notepad', tool: 'execute' } },
      ],
      cursor: 'c',
    })
    expect(v.steps).toEqual([
      { title: 'Opening Notepad', detail: 'Untitled - Notepad', callId: 'a' },
      { title: 'Typing the text into Notepad', detail: '*hello - Notepad', callId: 'b' },
    ])
    expect(headline(v)).toBe('Typing the text into Notepad')
  })

  it("renders the answer's bold and code, and nothing else as HTML", () => {
    expect(inlineMarkdown('Title is **`a<b>`** <img src=x>')).toBe(
      'Title is <strong><code>a&lt;b&gt;</code></strong> &lt;img src=x&gt;',
    )
  })

  it('keeps a * inside a code span from ending the bold', () => {
    expect(inlineMarkdown('Title is **`*hello - Notepad`**. The `*` means unsaved.')).toBe(
      'Title is <strong><code>*hello - Notepad</code></strong>. The <code>*</code> means unsaved.',
    )
  })

  it('names MCP-prefixed tools plainly', () => {
    expect(humanTool('mcp__github__create_issue')).toBe('Create issue')
  })
})
