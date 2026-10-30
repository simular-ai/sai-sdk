import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { ApiError, SaiApi } from '../api.js'
import type { SessionSource } from '../session-source.js'
import {
  buildApprovalUrl,
  clampTimeoutS,
  decisionSchema,
  decisionToResponse,
  machinesResult,
  SaiTools,
  serverInstructions,
  toolDescriptions,
  toolSchemas,
  WAIT_DEFAULT_S,
  WAIT_MAX_S,
} from '../tools.js'
import type { ApprovalRequest } from '../types.js'
import { SERVER_VERSION } from '../version.js'

describe('decision mapping', () => {
  it('maps the three decisions to the /approve vocabulary', () => {
    expect(decisionToResponse('approve')).toBe('yes')
    expect(decisionToResponse('approve_for_task')).toBe('task')
    expect(decisionToResponse('deny')).toBe('no')
  })

  it('rejects anything else at the schema', () => {
    expect(decisionSchema.safeParse('always').success).toBe(false)
    expect(decisionSchema.safeParse('yes').success).toBe(false)
  })
})

describe('timeout clamp', () => {
  it('defaults to 45 and caps at 55, under the 60 s client tool timeout', () => {
    expect(clampTimeoutS(undefined)).toBe(WAIT_DEFAULT_S)
    expect(WAIT_DEFAULT_S).toBe(45)
    expect(WAIT_MAX_S).toBe(55)
    expect(clampTimeoutS(500)).toBe(55)
    expect(clampTimeoutS(0)).toBe(1)
    expect(clampTimeoutS(42.9)).toBe(42)
    expect(clampTimeoutS(Number.NaN)).toBe(WAIT_DEFAULT_S)
  })
})

describe('tool schemas (§7)', () => {
  const names = Object.keys(toolSchemas)

  it('exposes the six §7 tools plus sai_models, sai_live_link and sai_learn, each with a description', () => {
    expect(names.sort()).toEqual(
      [
        'sai_machines',
        'sai_models',
        'sai_live_link',
        'sai_task_start',
        'sai_task_wait',
        'sai_task_approve',
        'sai_task_abort',
        'sai_upload',
        'sai_learn',
      ].sort(),
    )
    for (const name of names) {
      expect(toolDescriptions[name as keyof typeof toolDescriptions].length).toBeGreaterThan(40)
    }
  })

  it('sai_task_start requires task; the rest is optional', () => {
    const schema = z.object(toolSchemas.sai_task_start)
    expect(schema.safeParse({ task: 'x' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
    expect(
      schema.safeParse({ task: 'x', machine_id: 'm', file_ids: ['f'], new_session: true }).success,
    ).toBe(true)
  })

  it('sai_task_wait bounds timeout_s to 1..55', () => {
    const schema = z.object(toolSchemas.sai_task_wait)
    expect(schema.safeParse({ session_id: 's' }).success).toBe(true)
    expect(schema.safeParse({ session_id: 's', timeout_s: 55, cursor: '3' }).success).toBe(true)
    expect(schema.safeParse({ session_id: 's', timeout_s: 56 }).success).toBe(false)
    expect(schema.safeParse({ session_id: 's', timeout_s: 0 }).success).toBe(false)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('sai_task_approve takes approval_id + decision (+ selections)', () => {
    const schema = z.object(toolSchemas.sai_task_approve)
    expect(schema.safeParse({ approval_id: 'a', decision: 'approve' }).success).toBe(true)
    expect(
      schema.safeParse({ approval_id: 'a', decision: 'approve', selections: [['x']] }).success,
    ).toBe(true)
    expect(schema.safeParse({ approval_id: 'a', decision: 'yes' }).success).toBe(false)
  })

  it('sai_learn requires session_id; the template and guidance are optional', () => {
    const schema = z.object(toolSchemas.sai_learn)
    expect(schema.safeParse({ session_id: 's' }).success).toBe(true)
    expect(schema.safeParse({ session_id: 's', task_template: 'Open {{site}}' }).success).toBe(true)
    expect(schema.safeParse({}).success).toBe(false)
  })

  it('sai_task_abort and sai_upload take one required string', () => {
    expect(z.object(toolSchemas.sai_task_abort).safeParse({ session_id: 's' }).success).toBe(true)
    expect(z.object(toolSchemas.sai_task_abort).safeParse({}).success).toBe(false)
    expect(z.object(toolSchemas.sai_upload).safeParse({ path: '/tmp/x' }).success).toBe(true)
    expect(z.object(toolSchemas.sai_upload).safeParse({}).success).toBe(false)
  })

  it('descriptions and instructions state the contract points the model must know', () => {
    expect(toolDescriptions.sai_task_start).toMatch(/no screenshot/i)
    expect(toolDescriptions.sai_task_start).toMatch(/push is true.*do NOT call sai_task_wait/i)
    expect(toolDescriptions.sai_task_start).toMatch(/one conversation per machine/i)
    expect(toolDescriptions.sai_task_start).toMatch(/new_session/)
    expect(toolDescriptions.sai_task_wait).toMatch(/isLinkOnly/)
    expect(toolDescriptions.sai_task_approve).toMatch(/link_only/)
    expect(serverInstructions).toMatch(/sai_task_start/)
    expect(serverInstructions).toMatch(/needs_approval/)
    expect(serverInstructions).toMatch(/approvalUrl/)
    expect(serverInstructions).toMatch(/no screenshot/i)
    expect(serverInstructions).toMatch(/sai_live_link.*live_url/)
    expect(toolDescriptions.sai_live_link).toMatch(/without a Simular sign-in/)
    expect(toolDescriptions.sai_learn).toMatch(/record_trajectory: true/)
    expect(toolDescriptions.sai_learn).toMatch(/call sai_learn again with the same arguments/)
    expect(serverInstructions).toMatch(/record_trajectory: true.*sai_learn/)
  })
})

describe('machinesResult', () => {
  it('sets default only for exactly one machine and passes A4 fields through', () => {
    expect(machinesResult([{ machineId: 'm1', name: 'PC', status: 'online' }])).toEqual({
      machines: [{ machineId: 'm1', name: 'PC', status: 'online' }],
      default: 'm1',
    })
    const two = machinesResult([
      { machineId: 'a', kind: 'cloud', online: true },
      { machineId: 'b', kind: 'own', online: false, status: 'offline' },
    ])
    expect(two.default).toBeUndefined()
    expect(two.machines).toEqual([
      { machineId: 'a', kind: 'cloud', online: true },
      { machineId: 'b', kind: 'own', online: false },
    ])
    expect(machinesResult([]).default).toBeUndefined()
  })
  it('passes the public `state` through when the server sends it', () => {
    expect(
      machinesResult([
        { machineId: 'm1', kind: 'cloud', online: false, state: 'asleep', status: 'hibernated' },
      ]).machines,
    ).toEqual([{ machineId: 'm1', kind: 'cloud', online: false, state: 'asleep' }])
  })
  it('passes `os` through when the server sends it', () => {
    expect(
      machinesResult([
        { machineId: 'm1', kind: 'cloud', online: true, os: 'windows' },
        { machineId: 'm2', kind: 'own', online: true },
      ]).machines,
    ).toEqual([
      { machineId: 'm1', kind: 'cloud', online: true, os: 'windows' },
      { machineId: 'm2', kind: 'own', online: true },
    ])
  })
})

describe('SaiApi errors', () => {
  it('reads the human text from `message` (current servers) before `error`', async () => {
    const api = new SaiApi(
      'https://api.test',
      'k',
      async () =>
        new Response(JSON.stringify({ error: 'not_found', message: 'Session not found.' }), {
          status: 404,
        }),
    )
    const err = (await api.abort('s1').catch((e: unknown) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(err.message).toContain('Session not found.')
    expect(err.message).not.toContain('not_found')
    expect(err.body.error).toBe('not_found')
  })

  it('still reads `error` from older servers', async () => {
    const api = new SaiApi(
      'https://api.test',
      'k',
      async () => new Response(JSON.stringify({ error: 'Session not found.' }), { status: 403 }),
    )
    const err = (await api.abort('s1').catch((e: unknown) => e)) as ApiError
    expect(err.message).toContain('Session not found.')
  })
})

describe('SaiApi User-Agent', () => {
  it('identifies itself as sai-mcp/<package version> on every request', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true, aborted: true })))
    const api = new SaiApi('https://api.test', 'k', fetchImpl, 'my-tag')
    await api.abort('s1')
    const headers = (fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit
    expect(headers.headers).toMatchObject({
      Authorization: 'Bearer k',
      'User-Agent': `sai-mcp/${SERVER_VERSION}`,
      'x-sai-version': 'my-tag',
      'Content-Type': 'application/json',
    })
  })

  it('reports the version in package.json', () => {
    const pkg = JSON.parse(
      readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(SERVER_VERSION).toBe(pkg.version)
  })
})

describe('approval url', () => {
  it('builds the §5 shape', () => {
    expect(buildApprovalUrl('uid1', 'ap 1')).toBe('https://sai.simular.ai/approval/uid1/ap%201')
  })
})

// ─── SaiTools against a fake fetch ────────────────────────────────────────────

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function fakeSource(overrides: Partial<SessionSource> = {}): SessionSource {
  return {
    start: vi.fn(async (req) => ({ sessionId: 'sess-1', machineId: req.machineId, queued: false })),
    wait: vi.fn(async () => ({ status: 'idle' as const, events: [], text: 'done', cursor: '0' })),
    findApproval: vi.fn(() => undefined),
    noteApprovalResolved: vi.fn(),
    turnId: vi.fn(() => undefined),
    ...overrides,
  }
}

const linkOnly: ApprovalRequest = {
  approvalId: 'ap-link',
  title: 'Connect Google',
  description: '',
  approvalType: 'service_connect',
  isLinkOnly: true,
}

describe('SaiTools.approve', () => {
  it('posts the mapped decision and notes the resolution', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, status: 'approved_task' }))
    const source = fakeSource()
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source,
      push: false,
      userId: async () => 'uid1',
    })
    const result = await tools.approve({ approval_id: 'ap-1', decision: 'approve_for_task' })
    expect(result).toEqual({ ok: true, status: 'approved_task' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/agents/approve')
    expect(JSON.parse(init.body as string)).toEqual({ approvalId: 'ap-1', response: 'task' })
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer k')
    expect(source.noteApprovalResolved).toHaveBeenCalledWith('ap-1')
  })

  it('short-circuits a buffered link-only approval without calling the API', async () => {
    const fetchImpl = vi.fn()
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource({ findApproval: () => ({ sessionId: 's', approval: linkOnly }) }),
      push: false,
      userId: async () => 'uid1',
    })
    expect(await tools.approve({ approval_id: 'ap-link', decision: 'approve' })).toEqual({
      ok: false,
      reason: 'link_only',
      approval_url: 'https://sai.simular.ai/approval/uid1/ap-link',
    })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('maps a 409 link_only from the server, preferring its approvalUrl', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: 'link_only', approvalUrl: 'https://x/approval/u/a' }, 409),
    )
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource(),
      push: false,
      userId: async () => 'uid1',
    })
    expect(await tools.approve({ approval_id: 'a', decision: 'deny' })).toEqual({
      ok: false,
      reason: 'link_only',
      approval_url: 'https://x/approval/u/a',
    })
  })

  it('builds the url itself on a bare 409 link_only (pre-A3 server)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'link_only' }, 409))
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource(),
      push: false,
      userId: async () => 'uid1',
    })
    expect(await tools.approve({ approval_id: 'a', decision: 'approve' })).toEqual({
      ok: false,
      reason: 'link_only',
      approval_url: 'https://sai.simular.ai/approval/uid1/a',
    })
  })

  it('rethrows other failures as ApiError', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: 'no longer pending' }, 409))
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource(),
      push: false,
      userId: async () => 'uid1',
    })
    await expect(tools.approve({ approval_id: 'a', decision: 'approve' })).rejects.toBeInstanceOf(
      ApiError,
    )
  })
})

describe('SaiTools.start', () => {
  it('resolves the only machine, rotates the session when asked, and reports push', async () => {
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (url.endsWith('/machines')) return jsonResponse({ machines: [{ machineId: 'm1' }] })
      if (url.endsWith('/new-session')) return jsonResponse({ sessionId: 'fresh' })
      throw new Error(`unexpected ${url}`)
    })
    const source = fakeSource()
    const started: string[] = []
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source,
      push: true,
      userId: async () => 'uid1',
      onSessionStarted: (id) => started.push(id),
    })
    const result = await tools.start({ task: 'ping', new_session: true })
    expect(result).toEqual({ session_id: 'sess-1', machine_id: 'm1', queued: false, push: true })
    expect(calls).toEqual([
      'https://api.test/v1/agents/machines',
      'https://api.test/v1/agents/new-session',
    ])
    expect(source.start).toHaveBeenCalledWith({ machineId: 'm1', message: 'ping' })
    expect(started).toEqual(['sess-1'])
  })

  it('passes autonomous through only when asked', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ machines: [{ machineId: 'm1' }] }))
    const source = fakeSource()
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source,
      push: false,
      userId: async () => 'uid1',
    })
    await tools.start({ task: 'ping', autonomous: true })
    await tools.start({ task: 'pong', autonomous: false })
    expect(source.start).toHaveBeenNthCalledWith(1, {
      machineId: 'm1',
      message: 'ping',
      autonomous: true,
    })
    expect(source.start).toHaveBeenNthCalledWith(2, { machineId: 'm1', message: 'pong' })
  })

  it('asks the server to record the steps only when asked', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ machines: [{ machineId: 'm1' }] }))
    const source = fakeSource()
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source,
      push: false,
      userId: async () => 'uid1',
    })
    await tools.start({ task: 'ping', record_trajectory: true })
    expect(source.start).toHaveBeenCalledWith({
      machineId: 'm1',
      message: 'ping',
      recordTrajectory: true,
    })
  })

  it('refuses to guess between two machines', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ machines: [{ machineId: 'a', name: 'A' }, { machineId: 'b' }] }),
    )
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource(),
      push: false,
      userId: async () => undefined,
    })
    await expect(tools.start({ task: 'x' })).rejects.toThrow(/machine_id is required.*a \(A\), b/)
  })

  it('rejects an unknown file_id', async () => {
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', vi.fn()),
      source: fakeSource(),
      push: false,
      userId: async () => undefined,
    })
    await expect(tools.start({ task: 'x', machine_id: 'm', file_ids: ['nope'] })).rejects.toThrow(
      /Unknown file_id nope/,
    )
  })
})

describe('SaiTools.wait', () => {
  it('clamps the timeout, forwards the cursor and decorates only a link-only approval with a url', async () => {
    const waitWith = (approval: ApprovalRequest) =>
      vi.fn(async () => ({
        status: 'needs_approval' as const,
        events: [],
        text: '',
        approval,
        cursor: '4',
      }))
    const toolsWith = (wait: ReturnType<typeof waitWith>) =>
      new SaiTools({
        api: new SaiApi('https://api.test', 'k', vi.fn()),
        source: fakeSource({ wait }),
        push: false,
        userId: async () => 'uid1',
      })

    const bareLinkOnly: ApprovalRequest = {
      ...linkOnly,
      approvalId: 'ap-9',
      approvalUrl: undefined,
    }
    const wait = waitWith(bareLinkOnly)
    const result = await toolsWith(wait).wait({ session_id: 's', timeout_s: 999, cursor: '2' })
    expect(wait).toHaveBeenCalledWith('s', { timeoutMs: 55_000, cursor: '2' })
    expect(result.approval?.approvalUrl).toBe('https://sai.simular.ai/approval/uid1/ap-9')

    // An exec/choice approval is answered in place; the page cannot complete it.
    const exec: ApprovalRequest = { ...bareLinkOnly, approvalId: 'ap-10', isLinkOnly: false }
    const execResult = await toolsWith(waitWith(exec)).wait({ session_id: 's' })
    expect(execResult.approval?.approvalUrl).toBeUndefined()
  })
})

describe('SaiTools.liveLink', () => {
  const toolsWith = (fetchImpl: (url: string) => Promise<Response>) =>
    new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource(),
      push: false,
      userId: async () => undefined,
    })

  it('resolves the only machine and returns the page link, never the tunnel', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/machines')) return jsonResponse({ machines: [{ machineId: 'm1' }] })
      return jsonResponse({
        machineId: 'm1',
        liveUrl: 'https://api.test/live#t=lp1.x.y',
        expiresAt: 1790001800000,
        websocketUrl: 'wss://proxy.test/t?token=secret',
        width: 1280,
        height: 800,
      })
    })
    const result = await toolsWith(fetchImpl).liveLink({})
    expect(result).toEqual({
      machine_id: 'm1',
      live_url: 'https://api.test/live#t=lp1.x.y',
      expires_at: 1790001800000,
    })
    const [url, init] = fetchImpl.mock.calls[1] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/agents/machines/m1/live')
    expect(init.method).toBe('POST')
  })

  it('says so when the server offers no page', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ machineId: 'm1', websocketUrl: 'wss://proxy.test/t?token=secret' }),
    )
    const err = await toolsWith(fetchImpl)
      .liveLink({ machine_id: 'm1' })
      .catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/does not offer a live link/)
    expect((err as Error).message).not.toContain('secret')
  })
})

describe('SaiTools.abort', () => {
  it('posts the sessionId (owner-checked server side)', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ ok: true, aborted: true }))
    const tools = new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource(),
      push: false,
      userId: async () => undefined,
    })
    expect(await tools.abort({ session_id: 's' })).toEqual({ ok: true, aborted: true })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/agents/abort')
    expect(JSON.parse(init.body as string)).toEqual({ sessionId: 's' })
  })
})

describe('SaiTools.learn', () => {
  function learnTools(fetchImpl: typeof fetch, turnId: string | undefined): SaiTools {
    return new SaiTools({
      api: new SaiApi('https://api.test', 'k', fetchImpl),
      source: fakeSource({ turnId: vi.fn(() => turnId) }),
      push: false,
      userId: async () => undefined,
    })
  }

  it("turns the session's last recorded turn into code", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ learnId: 'learn_1', status: 'succeeded', code: 'async function main() {}' }),
    )
    const tools = learnTools(fetchImpl, 'turn_a')
    const result = await tools.learn({ session_id: 's1', task_template: 'Open {{site}}' })
    expect(result).toMatchObject({ learnId: 'learn_1', code: 'async function main() {}' })
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/agents/learn')
    expect(JSON.parse(init.body as string)).toEqual({
      turns: ['turn_a'],
      taskTemplate: 'Open {{site}}',
    })
  })

  it('says how to record a task when the session has none', async () => {
    const fetchImpl = vi.fn()
    await expect(learnTools(fetchImpl, undefined).learn({ session_id: 's1' })).rejects.toThrow(
      /record_trajectory: true/,
    )
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('answers running past the wait, and the next call waits on the same request', async () => {
    let answer!: (r: Response) => void
    const fetchImpl = vi.fn(() => new Promise<Response>((r) => (answer = r)))
    const tools = learnTools(fetchImpl, 'turn_a')
    expect(await tools.learn({ session_id: 's1' }, 10)).toMatchObject({ status: 'running' })
    const again = tools.learn({ session_id: 's1' }, 1_000)
    answer(jsonResponse({ learnId: 'learn_1', status: 'succeeded', code: 'x' }))
    expect(await again).toMatchObject({ learnId: 'learn_1' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('learns again once a result was handed over', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ learnId: 'learn_1', status: 'failed', error: 'no_steps' }),
    )
    const tools = learnTools(fetchImpl, 'turn_a')
    await tools.learn({ session_id: 's1' })
    await tools.learn({ session_id: 's1' })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('tries again after a failed call', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: 'model_refused', message: 'no' }, 403))
      .mockResolvedValueOnce(jsonResponse({ learnId: 'learn_2', status: 'succeeded', code: 'x' }))
    const tools = learnTools(fetchImpl, 'turn_a')
    await expect(tools.learn({ session_id: 's1' })).rejects.toThrow()
    expect(await tools.learn({ session_id: 's1' })).toMatchObject({ learnId: 'learn_2' })
  })
})
