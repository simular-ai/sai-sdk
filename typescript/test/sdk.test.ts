import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  GoneError,
  LinkOnlyApprovalError,
  NotFoundError,
  PermissionDeniedError,
  RateLimitError,
  SpendCapReachedError,
  Sai,
  SaiError,
  ServiceUnavailableError,
  type SaiOptions,
  type Event,
  type TurnResult,
} from '../src/index.js'

type Reply = unknown | [number, unknown] | ((req: Request) => Response)

interface Call {
  method: string
  path: string
  params: URLSearchParams
  headers: Headers
  body: string
}

/**
 * `routes` maps "METHOD /path" to a JSON body, `[status, body]`, a list of
 * those (served in order, the last repeats), or a function of the request.
 */
function client(
  routes: Record<string, Reply | Reply[]>,
  calls: Call[] = [],
  opts: SaiOptions = {},
): Sai {
  const queues = new Map(
    Object.entries(routes).map(([k, v]) => [k, Array.isArray(v) && !isPair(v) ? [...v] : [v]]),
  )
  const fetch = async (input: string, init?: RequestInit): Promise<Response> => {
    const url = new URL(input)
    const req = new Request(input, init)
    const body = init?.body instanceof Blob ? await init.body.text() : String(init?.body ?? '')
    calls.push({
      method: req.method,
      path: url.pathname,
      params: url.searchParams,
      headers: req.headers,
      body,
    })
    const q = queues.get(`${req.method} ${url.pathname}`)
    if (!q)
      return Response.json({ error: `no route ${req.method} ${url.pathname}` }, { status: 404 })
    const r = q.length > 1 ? q.shift() : q[0]
    if (typeof r === 'function') return (r as (req: Request) => Response)(req)
    const [status, json] = isPair(r) ? r : [200, r]
    return Response.json(json, { status })
  }
  return new Sai({ apiKey: 'sapi_test', baseUrl: 'https://api.test', fetch, ...opts })
}

function isPair(v: unknown): v is [number, unknown] {
  return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number'
}

const MACHINES = { machines: [{ machineId: 'm_1', name: 'Work PC', kind: 'own', online: true }] }
const APPROVAL = {
  approvalId: 'ap_1',
  title: 'Command Approval Required',
  description: '',
  approvalType: 'exec',
  isLinkOnly: false,
  command: 'del temp',
}
const waiting = (approval: Record<string, unknown>) => ({
  sessionId: 'cs_1',
  status: 'needs_approval',
  events: [{ type: 'data-approval-request', data: approval }],
  text: '',
  cursor: 'c1',
  approval,
})

describe('sai typescript sdk', () => {
  it('requires a key', () => {
    const saved = process.env.SAI_API_KEY
    delete process.env.SAI_API_KEY
    expect(() => new Sai()).toThrow(/API key/)
    if (saved !== undefined) process.env.SAI_API_KEY = saved
  })

  it('maps status and code to errors', async () => {
    await expect(
      client({ 'GET /v1/agents/machines': [401, { error: 'Invalid API key' }] }).machines.list(),
    ).rejects.toBeInstanceOf(AuthenticationError)

    const err = await client({
      'POST /v1/machines/m_1/control': [409, { error: 'machine_busy', message: 'A task holds it' }],
    })
      .control.open({ machine: 'm_1' })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(ConflictError)
    expect((err as ConflictError).code).toBe('machine_busy')
    expect((err as ConflictError).message).toBe('A task holds it')
  })

  it('gives a reached spend cap its own error', async () => {
    const err = await client({
      'POST /v1/agents/message': [
        403,
        {
          error: 'spend_cap_reached',
          message: 'This key reached its limit.',
          resetsAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    })
      .sessions.resume('cs_1', { machine: 'm_1' })
      .send('hello')
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SpendCapReachedError)
    expect(err).toBeInstanceOf(PermissionDeniedError)
    expect((err as SpendCapReachedError).status).toBe(403)
    expect((err as SpendCapReachedError).code).toBe('spend_cap_reached')
    expect((err as SpendCapReachedError).resetsAt).toBe('2026-11-01T00:00:00.000Z')
  })

  it('resolves the machine', async () => {
    const s = await client({
      'GET /v1/agents/machines': MACHINES,
      'POST /v1/agents/new-session': { sessionId: 'cs_1' },
    }).sessions.create()
    expect([s.id, s.machineId]).toEqual(['cs_1', 'm_1'])

    const two = { machines: [...MACHINES.machines, { machineId: 'm_2' }] }
    await expect(client({ 'GET /v1/agents/machines': two }).sessions.create()).rejects.toThrow(
      BadRequestError,
    )
  })

  it('polls until idle with the cursor', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/agents/new-session': { sessionId: 'cs_1' },
        'POST /v1/agents/message': [202, { sessionId: 'cs_1', machineId: 'm_1', queued: false }],
        'GET /v1/agents/events': [
          {
            sessionId: 'cs_1',
            status: 'running',
            events: [
              { type: 'reasoning-delta', id: 'r', delta: 'thinking' },
              { type: 'data-progress', data: { text: 'Opening Notepad', tool: 'execute' } },
            ],
            text: '',
            cursor: 'c1',
          },
          {
            sessionId: 'cs_1',
            status: 'idle',
            events: [
              { type: 'text-delta', id: 't', delta: 'Saved.' },
              { type: 'finish', finishReason: 'stop' },
            ],
            text: 'Saved.',
            cursor: 'c2',
            usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01, modelCalls: 1 },
          },
        ],
      },
      calls,
    )
    const session = await sai.sessions.create({ machine: 'm_1' })
    const turn = await session.send('type hello', { model: 'auto' })
    const seen: Array<[string, string | null]> = []
    for await (const ev of turn.events()) seen.push([ev.kind, ev.text])
    expect(seen).toEqual([
      ['step', 'Opening Notepad'],
      ['message', 'Saved.'],
      ['finished', null],
    ])
    expect(turn.result?.ok).toBe(true)
    expect(turn.result?.text).toBe('Saved.')
    expect(turn.result?.usage?.costUsd).toBe(0.01)

    const msg = calls.find((c) => c.path === '/v1/agents/message')!
    expect(JSON.parse(msg.body)).toEqual({
      message: 'type hello',
      wait: false,
      machineId: 'm_1',
      sessionId: 'cs_1',
      model: 'auto',
    })
    const polls = calls.filter((c) => c.path === '/v1/agents/events')
    expect(polls[0]!.params.has('since')).toBe(false)
    expect(polls[1]!.params.get('since')).toBe('c1')
    expect(calls.every((c) => c.headers.get('authorization') === 'Bearer sapi_test')).toBe(true)
  })

  it('returns on an unanswered approval', async () => {
    const sai = client({
      'POST /v1/agents/message': [202, { sessionId: 'cs_1', machineId: 'm_1' }],
      'GET /v1/agents/events': waiting(APPROVAL),
    })
    const r = await sai.sessions.resume('cs_1', { machine: 'm_1' }).run('clean up')
    expect(r.status).toBe('needs_approval')
    expect(r.approval?.command).toBe('del temp')
  })

  it('answers with onApproval and continues', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/agents/message': [202, { sessionId: 'cs_1', machineId: 'm_1' }],
        'GET /v1/agents/events': [
          waiting(APPROVAL),
          { sessionId: 'cs_1', status: 'idle', events: [], text: 'Done', cursor: 'c2' },
        ],
        'POST /v1/agents/approve': { ok: true, status: 'denied' },
      },
      calls,
    )
    const r = await sai.sessions.resume('cs_1').run('clean up', { onApproval: () => 'no' })
    expect(r.text).toBe('Done')
    const approve = calls.find((c) => c.path === '/v1/agents/approve')!
    expect(JSON.parse(approve.body)).toEqual({ approvalId: 'ap_1', response: 'no' })
  })

  it('refuses a link-only approval locally', async () => {
    const sai = client({
      'POST /v1/agents/message': [202, { sessionId: 'cs_1' }],
      'GET /v1/agents/events': waiting({ ...APPROVAL, isLinkOnly: true, approvalUrl: 'https://x' }),
    })
    const turn = await sai.sessions.resume('cs_1').send('x')
    const r = await turn.wait()
    const err = await turn.respond(r.approval!).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(LinkOnlyApprovalError)
    expect((err as LinkOnlyApprovalError).approvalUrl).toBe('https://x')
  })

  it('handles an acknowledgement without a task', async () => {
    const turn = await client({
      'POST /v1/agents/message': { error: 'Hi! What should I do?' },
    })
      .sessions.resume('cs_1', { machine: 'm_1' })
      .send('hello')
    const evs: Event[] = []
    for await (const ev of turn.events()) evs.push(ev)
    expect(evs).toEqual([])
    expect((await turn.wait()).text).toBe('Hi! What should I do?')
  })

  it('reads a handled message from `reply` (current servers)', async () => {
    const turn = await client({
      'POST /v1/agents/message': { handled: true, reply: 'Hi! What should I do?', error: 'old' },
    })
      .sessions.resume('cs_1', { machine: 'm_1' })
      .send('hello')
    expect((await turn.wait()).text).toBe('Hi! What should I do?')
  })

  it('reads the code and message of a { error: code, message } body', async () => {
    const err = await client({
      'POST /v1/agents/abort': [404, { error: 'not_found', message: 'Session not found.' }],
    })
      .sessions.resume('cs_1', { machine: 'm_1' })
      .abort()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(NotFoundError)
    expect((err as NotFoundError).code).toBe('not_found')
    expect((err as NotFoundError).message).toBe('Session not found.')
  })

  it('takes retryAfter from the body when the header is missing', async () => {
    const err = await client({
      'GET /v1/agents/machines': [
        429,
        { error: 'rate_limited', message: 'Too many requests.', retryAfterSeconds: 42 },
      ],
    })
      .machines.list()
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RateLimitError)
    expect((err as RateLimitError).retryAfter).toBe(42)
  })

  it('parses the public machine `state`, and null from servers without it', async () => {
    const machines = await client({
      'GET /v1/agents/machines': {
        machines: [
          { machineId: 'm_1', kind: 'cloud', state: 'asleep', status: 'hibernated' },
          { machineId: 'm_2', kind: 'own' },
        ],
      },
    }).machines.list()
    expect(machines.map((m) => [m.state, m.status])).toEqual([
      ['asleep', 'hibernated'],
      [null, null],
    ])
  })

  it('opens a live screen with its page link, and revokes the links', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/agents/machines/m_1/live': [
          {
            machineId: 'm_1',
            liveUrl: 'https://api.test/live#t=lp1.x.y',
            expiresAt: 1790001800000,
            websocketUrl: 'wss://proxy.test/t?token=x',
            width: 1280,
            height: 800,
          },
          {
            machineId: 'm_1',
            websocketUrl: 'wss://proxy.test/t?token=y',
            width: 1280,
            height: 800,
          },
        ],
        'DELETE /v1/agents/machines/m_1/live': { machineId: 'm_1', revoked: 2 },
      },
      calls,
    )
    expect(await sai.machines.live('m_1')).toEqual({
      machineId: 'm_1',
      liveUrl: 'https://api.test/live#t=lp1.x.y',
      expiresAt: 1790001800000,
      websocketUrl: 'wss://proxy.test/t?token=x',
      width: 1280,
      height: 800,
    })
    // a server without the page leaves both fields out
    const plain = await sai.machines.live('m_1')
    expect([plain.liveUrl, plain.expiresAt]).toEqual([null, null])
    expect(await sai.machines.revokeLive('m_1')).toBe(2)
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /v1/agents/machines/m_1/live',
      'POST /v1/agents/machines/m_1/live',
      'DELETE /v1/agents/machines/m_1/live',
    ])
  })

  it('surfaces credit error codes', async () => {
    const r = await client({
      'POST /v1/agents/message': [202, { sessionId: 'cs_1' }],
      'GET /v1/agents/events': {
        sessionId: 'cs_1',
        status: 'error',
        events: [{ type: 'error', errorText: 'out of credit', code: 'insufficient_credits' }],
        text: '',
        cursor: 'c',
      },
    })
      .sessions.resume('cs_1')
      .run('x')
    expect([r.status, r.errorCode]).toEqual(['error', 'insufficient_credits'])
  })

  it('runs a control lease and closes it', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
    const calls: Call[] = []
    const exec = (over: Record<string, unknown>) => ({
      logs: [],
      observations: {},
      variables: [],
      durationMs: 1,
      ...over,
    })
    const sai = client(
      {
        'POST /v1/machines/m_1/control': { machineId: 'm_1', expiresAfterIdleSec: 600 },
        'POST /v1/machines/m_1/control/exec': [
          exec({ result: { stdout: 'HOST\r\n', exitCode: 0 } }),
          exec({
            result: null,
            observations: {
              screenshot: { base64: Buffer.from(png).toString('base64'), mimeType: 'image/png' },
            },
          }),
          exec({ error: { kind: 'exception', message: 'boom' } }),
          exec({
            observations: {
              screenshot: { base64: Buffer.from(jpeg).toString('base64'), mimeType: 'image/jpeg' },
            },
          }),
        ],
        'DELETE /v1/machines/m_1/control': () => new Response(null, { status: 204 }),
      },
      calls,
    )
    {
      await using lease = await sai.control.open({ machine: 'm_1' })
      expect((await lease.shell('hostname')).stdout.trim()).toBe('HOST')
      expect(await lease.screenshot()).toEqual(png)
      const r = await lease.exec("throw new Error('boom')")
      expect(r.ok).toBe(false)
      expect(r.error?.kind).toBe('exception')
      const snap = await lease.exec('await page.snapshot()')
      expect([snap.screenshot, snap.screenshotMimeType, snap.screenshotPng]).toEqual([
        jpeg,
        'image/jpeg',
        jpeg,
      ])
    }
    expect(calls.at(-1)!.method).toBe('DELETE')
    const first = calls.find((c) => c.path.endsWith('/exec'))!
    expect(JSON.parse(first.body).code).toBe('await machine.exec({"command":"hostname"})')
  })

  it('raises GoneError with the reason when the lease has lost its computer', async () => {
    const sai = client({
      'POST /v1/machines/m_1/control': { machineId: 'm_1', expiresAfterIdleSec: 600 },
      'POST /v1/machines/m_1/control/exec': [
        410,
        {
          error: 'control_closed',
          message: 'The computer stopped answering, so this control lease was closed.',
          reason: 'unresponsive',
        },
      ],
      'DELETE /v1/machines/m_1/control': () => new Response(null, { status: 204 }),
    })
    const lease = await sai.control.open({ machine: 'm_1' })
    const err = await lease.exec('1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoneError)
    expect((err as GoneError).code).toBe('control_closed')
    expect((err as GoneError).body.reason).toBe('unresponsive')
    await lease.close()
  })

  it('uploads the raw body with the file name', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/agents/upload': {
          path: 'uploads/a b.txt',
          name: 'a b.txt',
          mime: 'text/plain',
          size: 3,
          fileId: 'f_1',
        },
      },
      calls,
    )
    const dir = mkdtempSync(join(tmpdir(), 'sai-'))
    const p = join(dir, 'a b.txt')
    writeFileSync(p, 'abc')
    const a = await sai.files.upload(p)
    expect(a.fileId).toBe('f_1')
    expect(calls[0]!.headers.get('x-filename')).toBe('a%20b.txt')
    expect(calls[0]!.body).toBe('abc')
    expect(calls[0]!.headers.get('content-type')).toBe('application/octet-stream')
  })

  describe('turns', () => {
    const DONE = {
      turnId: 'turn_1',
      sessionId: 'cs_1',
      machineId: 'm_1',
      status: 'succeeded',
      output: { path: 'C:\\Users\\me\\Desktop\\inv-1001.txt' },
      reason_code: null,
      evidence: [
        { id: 'saved', passed: true, score: 0.93, evidence: 'The file is on the Desktop.' },
      ],
      usage: { inputTokens: 120, outputTokens: 30 },
      recordTrajectory: true,
      trajectory: { recorded: true, url: '/v1/agents/turns/turn_1/trajectory' },
      template: 'Save {{file_name}}',
      inputs: { file_name: 'inv-1001.txt' },
    }

    // Turn reads are 2 s apart; skip the waits.
    const settle = async <T>(p: Promise<T>): Promise<T> => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      await vi.runAllTimersAsync()
      return p
    }
    afterEach(() => {
      vi.useRealTimers()
    })

    it('a structured message sends its options and waits for the record', async () => {
      const calls: Call[] = []
      const sai = client(
        {
          'POST /v1/agents/new-session': { sessionId: 'cs_1' },
          'POST /v1/agents/message': [
            202,
            { sessionId: 'cs_1', machineId: 'm_1', queued: false, turnId: 'turn_1' },
          ],
          'GET /v1/agents/events': {
            sessionId: 'cs_1',
            status: 'idle',
            events: [],
            text: 'Saved.',
            cursor: 'c1',
          },
          'GET /v1/agents/turns/turn_1': [
            { ...DONE, status: 'running' },
            { ...DONE, status: 'finalizing' },
            DONE,
          ],
        },
        calls,
      )
      const session = await sai.sessions.create({ machine: 'm_1' })
      const turn = await session.send('Save {{file_name}}', {
        inputs: { file_name: 'inv-1001.txt' },
        outputSchema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        successCriteria: [
          { id: 'saved', check: 'The file is saved on the Desktop', returnEvidence: true },
        ],
        idempotencyKey: 'inv-1001',
        recordTrajectory: true,
      })
      expect(turn.id).toBe('turn_1')
      const result = await settle(turn.wait())
      expect(result.ok).toBe(true)
      expect(result.record?.output).toEqual({ path: 'C:\\Users\\me\\Desktop\\inv-1001.txt' })
      expect(result.record?.evidence[0]?.score).toBe(0.93)
      expect(result.record?.usage?.inputTokens).toBe(120)
      expect(result.record?.trajectoryRecorded).toBe(true)

      const body = JSON.parse(calls.find((c) => c.path === '/v1/agents/message')!.body) as Record<
        string,
        unknown
      >
      expect(body.sessionId).toBe('cs_1')
      // Everything beyond a plain message goes in `options`.
      expect(body.options).toEqual({
        inputs: { file_name: 'inv-1001.txt' },
        output_schema: {
          type: 'object',
          properties: { path: { type: 'string' } },
          required: ['path'],
        },
        success_criteria: [
          { id: 'saved', check: 'The file is saved on the Desktop', returnEvidence: true },
        ],
        idempotency_key: 'inv-1001',
        recordTrajectory: true,
      })
      expect(Object.keys(body)).not.toContain('output_schema')
      expect(calls.filter((c) => c.path === '/v1/agents/turns/turn_1')).toHaveLength(3)
    })

    it('a failed structured turn is not ok', async () => {
      const sai = client({
        'POST /v1/agents/new-session': { sessionId: 'cs_1' },
        'POST /v1/agents/message': [202, { sessionId: 'cs_1', machineId: 'm_1', turnId: 'turn_1' }],
        'GET /v1/agents/events': {
          sessionId: 'cs_1',
          status: 'idle',
          events: [],
          text: 'I saved it.',
        },
        'GET /v1/agents/turns/turn_1': {
          ...DONE,
          status: 'failed',
          output: null,
          reason_code: 'output_invalid',
          raw_answer: 'I saved it.',
          output_errors: ["must have required property 'path'"],
        },
      })
      const session = await sai.sessions.create({ machine: 'm_1' })
      const result = await session.run('Save it', { outputSchema: { type: 'object' } })
      expect(result.status).toBe('idle')
      expect(result.ok).toBe(false)
      expect(result.record?.reasonCode).toBe('output_invalid')
      expect(result.record?.rawAnswer).toBe('I saved it.')
      expect(result.record?.outputErrors).toHaveLength(1)
    })

    it('a plain message has a turn id but does not wait for the record', async () => {
      const calls: Call[] = []
      const sai = client(
        {
          'POST /v1/agents/new-session': { sessionId: 'cs_1' },
          'POST /v1/agents/message': [
            202,
            { sessionId: 'cs_1', machineId: 'm_1', turnId: 'turn_2' },
          ],
          'GET /v1/agents/events': { sessionId: 'cs_1', status: 'idle', events: [], text: 'Done.' },
        },
        calls,
      )
      const turn = await (await sai.sessions.create({ machine: 'm_1' })).send('hello')
      expect(turn.id).toBe('turn_2')
      expect((await turn.wait()).record).toBeNull()
      expect(calls.some((c) => c.path.startsWith('/v1/agents/turns'))).toBe(false)
      const body = JSON.parse(calls.find((c) => c.path === '/v1/agents/message')!.body) as Record<
        string,
        unknown
      >
      expect(body.options).toBeUndefined()
    })

    it('autonomous goes on the message, not in options', async () => {
      const calls: Call[] = []
      const sai = client(
        {
          'POST /v1/agents/new-session': { sessionId: 'cs_1' },
          'POST /v1/agents/message': [
            202,
            { sessionId: 'cs_1', machineId: 'm_1', turnId: 'turn_4' },
          ],
          'GET /v1/agents/events': { sessionId: 'cs_1', status: 'idle', events: [], text: 'Done.' },
        },
        calls,
      )
      const session = await sai.sessions.create({ machine: 'm_1' })
      await session.run('hello', { autonomous: true })
      await session.run('again')
      const bodies = calls
        .filter((c) => c.path === '/v1/agents/message')
        .map((c) => JSON.parse(c.body) as Record<string, unknown>)
      expect(bodies[0]?.autonomous).toBe(true)
      expect(bodies[0]?.options).toBeUndefined()
      expect(bodies[1]).not.toHaveProperty('autonomous')
    })

    it('an idempotency key alone keeps the message plain', async () => {
      const calls: Call[] = []
      const sai = client(
        {
          'POST /v1/agents/new-session': { sessionId: 'cs_1' },
          'POST /v1/agents/message': [
            202,
            { sessionId: 'cs_1', machineId: 'm_1', turnId: 'turn_3' },
          ],
          'GET /v1/agents/events': { sessionId: 'cs_1', status: 'idle', events: [], text: 'Done.' },
        },
        calls,
      )
      const session = await sai.sessions.create({ machine: 'm_1' })
      const result = await session.run('hello', { idempotencyKey: 'k' })
      expect(result.record).toBeNull()
      expect(calls.some((c) => c.path.startsWith('/v1/agents/turns'))).toBe(false)
    })

    it('a steer gets the id of the turn it joined', async () => {
      const sai = client({
        'POST /v1/agents/new-session': { sessionId: 'cs_1' },
        'POST /v1/agents/message': [
          202,
          { sessionId: 'cs_1', machineId: 'm_1', queued: true, turnId: 'turn_running' },
        ],
      })
      const turn = await (await sai.sessions.create({ machine: 'm_1' })).send('also this')
      expect(turn.queued).toBe(true)
      expect(turn.id).toBe('turn_running')
    })

    it('an idempotent replay returns the earlier turn', async () => {
      const calls: Call[] = []
      const sai = client(
        {
          'POST /v1/agents/new-session': { sessionId: 'cs_1' },
          'POST /v1/agents/message': { ...DONE, idempotent_replay: true },
        },
        calls,
      )
      const session = await sai.sessions.create({ machine: 'm_1' })
      const turn = await session.send('Save {{file_name}}', {
        inputs: { file_name: 'x' },
        idempotencyKey: 'k',
      })
      const events: Event[] = []
      for await (const ev of turn.events()) events.push(ev)
      expect(events).toEqual([])
      const result = await turn.wait()
      expect(turn.id).toBe('turn_1')
      expect(result.record?.replayed).toBe(true)
      expect(result.record?.id).toBe('turn_1')
      expect(calls.map((c) => c.path)).toEqual(['/v1/agents/new-session', '/v1/agents/message'])
      // The same result the live path returned: the answer, its usage, and ok.
      expect(result.status).toBe('idle')
      expect(result.ok).toBe(true)
      expect(result.text).toBe('{"path":"C:\\\\Users\\\\me\\\\Desktop\\\\inv-1001.txt"}')
      expect(result.usage?.inputTokens).toBe(120)
    })

    const replay = async (record: Record<string, unknown>): Promise<TurnResult> => {
      const sai = client({
        'POST /v1/agents/new-session': { sessionId: 'cs_1' },
        'POST /v1/agents/message': { ...record, idempotent_replay: true },
      })
      const session = await sai.sessions.create({ machine: 'm_1' })
      return (await session.send('x', { idempotencyKey: 'k' })).wait()
    }

    it('a replay of a plain turn returns its answer', async () => {
      const result = await replay({ ...DONE, output: 'Saved it.' })
      expect(result).toMatchObject({ status: 'idle', text: 'Saved it.', ok: true })
    })

    it('a replay of a broken turn is an error', async () => {
      const result = await replay({
        ...DONE,
        status: 'failed',
        output: null,
        reason_code: 'agent_error',
        raw_answer: 'You are out of credits.',
        error_code: 'insufficient_credits',
      })
      expect(result).toMatchObject({
        status: 'error',
        ok: false,
        text: '',
        error: 'You are out of credits.',
        errorCode: 'insufficient_credits',
      })
    })

    it('a replay of a turn that failed its checks keeps the answer', async () => {
      const result = await replay({
        ...DONE,
        status: 'failed',
        output: null,
        reason_code: 'output_invalid',
        raw_answer: 'No path.',
      })
      expect(result).toMatchObject({ status: 'idle', ok: false, text: 'No path.' })
      expect(result.record?.reasonCode).toBe('output_invalid')
    })

    it('a structured message to a busy session is a conflict', async () => {
      const sai = client({
        'POST /v1/agents/new-session': { sessionId: 'cs_1' },
        'POST /v1/agents/message': [
          409,
          { error: 'session_busy', message: 'The session is still working.' },
        ],
      })
      const session = await sai.sessions.create({ machine: 'm_1' })
      const err = await session.send('x', { outputSchema: { type: 'object' } }).catch((e) => e)
      expect(err).toBeInstanceOf(ConflictError)
      expect((err as ConflictError).code).toBe('session_busy')
    })

    it('get, wait, trajectory and screenshot', async () => {
      const jpeg = new Uint8Array([0xff, 0xd8, 0x6a])
      const sai = client({
        'GET /v1/agents/turns/turn_1': [
          { ...DONE, status: 'running' },
          { ...DONE, status: 'needs_input' },
        ],
        'GET /v1/agents/turns/turn_1/trajectory': {
          turnId: 'turn_1',
          trajectory: { recorded: true, url: '/v1/agents/turns/turn_1/trajectory' },
          steps: [
            {
              index: 0,
              timestamp: 't0',
              title: 'Open Notepad',
              code: "app.open('notepad')",
              screenshot: '/v1/agents/turns/turn_1/trajectory/screenshots/0',
            },
            { index: 1, final: true, timestamp: 't1', screenshot: null },
          ],
        },
        'GET /v1/agents/turns/turn_1/trajectory/screenshots/0': () =>
          new Response(jpeg, { headers: { 'content-type': 'image/jpeg' } }),
      })
      expect((await sai.turns.get('turn_1')).status).toBe('running')
      expect((await settle(sai.turns.wait('turn_1'))).status).toBe('needs_input')
      const steps = await sai.turns.trajectory('turn_1')
      expect(steps.map((s) => [s.index, s.title, s.hasScreenshot, s.final])).toEqual([
        [0, 'Open Notepad', true, false],
        [1, null, false, true],
      ])
      expect(await sai.turns.screenshot({ id: 'turn_1' }, 0)).toEqual(jpeg)
    })
  })
})

describe('learn and judge', () => {
  const learned = {
    learnId: 'learn_1',
    mode: 'convert',
    status: 'succeeded',
    title: 'Read the top story',
    template: 'Open {{site}} and read the top story',
    parameters: [
      { name: 'site', defaultValue: 'https://news.ycombinator.com' },
      { name: 'n', defaultValue: '1' },
    ],
    code: 'async function main(params = { site: "x", n: "1" }) { return params.site }',
    validation: { errors: [], warnings: ['w'] },
    sourceTurns: ['turn_1'],
    usage: { inputTokens: 100, outputTokens: 20 },
  }

  it('converts turns, and repairs code with trimmed evaluations', async () => {
    const calls: Call[] = []
    const sai = client(
      { 'POST /v1/agents/learn': learned, 'GET /v1/agents/learn/learn_1': learned },
      calls,
    )
    const r = await sai.learn.create(['turn_1', { id: 'turn_2' }], {
      template: 'Open {{site}} and read the top story',
      idempotencyKey: 'k1',
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({
      turns: ['turn_1', 'turn_2'],
      template: 'Open {{site}} and read the top story',
      idempotency_key: 'k1',
    })
    expect(r).toMatchObject({ id: 'learn_1', mode: 'convert', ok: true, sourceTurns: ['turn_1'] })
    expect(r.parameters[0]).toEqual({
      name: 'site',
      defaultValue: 'https://news.ycombinator.com',
      description: null,
    })
    expect(r.validation.warnings).toEqual(['w'])

    const logs = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    await sai.learn.create([], {
      initialCode: 'code',
      evaluations: [
        {
          inputs: { site: 'a' },
          result: {
            result: null,
            logs,
            error: { kind: 'exception', message: 'boom', stack: 'st' },
            screenshot: new Uint8Array([1]),
            screenshotMimeType: 'image/jpeg',
            screenshotOmitted: false,
            variables: [],
            durationMs: 5,
            ok: false,
            raw: {},
          },
          judgement: { id: 'judgement_1' } as never,
          passed: false,
        },
      ],
    })
    expect(JSON.parse(calls[1]!.body)).toEqual({
      turns: [],
      initialCode: 'code',
      evaluations: [
        {
          inputs: { site: 'a' },
          result: {
            result: null,
            logs: logs.slice(-30),
            error: { kind: 'exception', message: 'boom' },
          },
          judgement: 'judgement_1',
          passed: false,
        },
      ],
    })

    await sai.learn.create([], {
      initialCode: 'code',
      guidance: 'Return the URL too',
      history: 'Version 1: run 1 failed: no URL',
    })
    expect(JSON.parse(calls[2]!.body)).toEqual({
      turns: [],
      initialCode: 'code',
      guidance: 'Return the URL too',
      history: 'Version 1: run 1 failed: no URL',
    })
    await sai.learn.create(['turn_1'], { runsWithoutReset: true })
    expect(JSON.parse(calls[3]!.body)).toEqual({ turns: ['turn_1'], runsWithoutReset: true })
    expect((await sai.learn.get('learn_1')).id).toBe('learn_1')
  })

  it('starts a learn job, waits for it, cancels it and reads a run', async () => {
    const running = { learnId: 'learn_2', mode: 'policyIteration', status: 'running' }
    const done = {
      ...learned,
      learnId: 'learn_2',
      mode: 'policyIteration',
      status: 'succeeded',
      version: 2,
      testResult: { status: 'passed', passedRuns: 2, requiredRuns: 2, inputs: { site: 'x' } },
      agentTurnId: 'turn_9',
      iterations: [
        {
          index: 1,
          learnId: 'learn_v1',
          passed: 0,
          runs: 1,
          rollouts: [
            {
              index: 1,
              verdict: 'failed',
              reset: { kind: 'code', ok: true, durationMs: 800 },
              summary: 'no URL',
              continuationTurnId: 'turn_c',
            },
          ],
        },
      ],
    }
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/agents/learn': [202, running],
        'GET /v1/agents/learn/learn_2': [
          { ...running, progress: { step: 'run', iteration: 1, rollout: 1 } },
          done,
        ],
        'POST /v1/agents/learn/learn_2/cancel': [202, { learnId: 'learn_2', status: 'running' }],
        'GET /v1/agents/learn/learn_2/iterations/1/rollouts/1': {
          learnId: 'learn_2',
          iteration: 1,
          rollout: 1,
          run: { result: 'Top story', logs: [] },
          judgement: { verdict: 'failed' },
        },
      },
      calls,
    )
    const job = await sai.learn.create([], {
      taskTemplate: 'Open {{site}}',
      inputs: { site: 'x' },
      machine: 'm_1',
      maxIterations: 2,
      rollouts: 2,
      criteria: 'The title is shown',
      reset: { code: 'await reset()' },
      continueWithAgent: true,
      guidance: 'Use the menu',
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({
      turns: [],
      taskTemplate: 'Open {{site}}',
      inputs: { site: 'x' },
      guidance: 'Use the menu',
      machineId: 'm_1',
      maxIterations: 2,
      rollouts: 2,
      criteria: 'The title is shown',
      reset: { code: 'await reset()' },
      continueWithAgent: true,
    })
    expect(job).toMatchObject({
      id: 'learn_2',
      mode: 'policyIteration',
      status: 'running',
      ok: false,
    })

    const r = await sai.learn.wait(job, { pollMs: 1 })
    expect(r).toMatchObject({
      status: 'succeeded',
      version: 2,
      agentTurnId: 'turn_9',
      testResult: { status: 'passed', passedRuns: 2, requiredRuns: 2 },
    })
    expect(r.iterations[0]!.rollouts[0]).toMatchObject({
      verdict: 'failed',
      reset: { kind: 'code', ok: true, durationMs: 800, turnId: null },
      continuationTurnId: 'turn_c',
    })

    await sai.learn.cancel('learn_2')
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/v1/agents/learn/learn_2/cancel' })
    const run = await sai.learn.rollout(job, 1, 1)
    expect(run).toMatchObject({ iteration: 1, rollout: 1, run: { result: 'Top story' } })
    expect(run.judgement).toEqual({ verdict: 'failed' })
  })

  it('stops waiting at the timeout with the job still running', async () => {
    const sai = client({
      'GET /v1/agents/learn/learn_3': { learnId: 'learn_3', status: 'running' },
    })
    await expect(sai.learn.wait('learn_3', { timeoutMs: 5, pollMs: 10 })).rejects.toMatchObject({
      name: 'TimeoutError',
    })
  })

  it('judges turns against checks', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/agents/judge': {
          judgementId: 'judgement_1',
          verdict: 'failed',
          summary: '0 of 1 checks passed.',
          criteria: [{ id: 'title', check: 'A title', verdict: 'failed', score: 0.1 }],
          turns: ['turn_1'],
        },
      },
      calls,
    )
    const j = await sai.judge.create(['turn_1'], [{ id: 'title', check: 'A title' }])
    expect(JSON.parse(calls[0]!.body)).toEqual({
      turns: ['turn_1'],
      criteria: [{ id: 'title', check: 'A title' }],
    })
    expect(j).toMatchObject({ id: 'judgement_1', verdict: 'failed', ok: false })
    expect(j.criteria[0]).toEqual({
      id: 'title',
      check: 'A title',
      verdict: 'failed',
      score: 0.1,
      evidence: null,
    })
  })

  it('runs learned code with inputs over the defaults', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/machines/m_1/control': { machineId: 'm_1', expiresAfterIdleSec: 600 },
        'POST /v1/machines/m_1/control/exec': { result: 'ok', logs: [], durationMs: 1 },
      },
      calls,
    )
    const lease = await sai.control.open({ machine: 'm_1' })
    const r = await lease.run(parseLearned(), { n: 3 })
    expect(r.result).toBe('ok')
    expect(JSON.parse(calls[1]!.body).code).toBe(
      `${learned.code}\nawait main({"site":"https://news.ycombinator.com","n":3})`,
    )
  })

  function parseLearned(): import('../src/index.js').LearnResult {
    return {
      ...learned,
      id: 'learn_1',
      parameters: learned.parameters.map((p) => ({ ...p, description: null })),
    } as never
  }
})

const TENANT = {
  tenantId: 't_1',
  name: 'Riverside Clinic',
  externalId: 'clinic-4821',
  metadata: { plan: 'pro' },
  status: 'active',
  createdAt: 1790000000000,
  disabledAt: null,
  machineCount: 2,
}
const TENANT_MACHINE = {
  machineId: 'tm_1',
  name: 'Front desk PC',
  platform: 'darwin',
  status: 'active',
  online: true,
  lastSeen: 1790003600000,
  runtimeVersion: '1.2.0',
}
const noContent = () => new Response(null, { status: 204 })

describe('tenants', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('maps to the tenant routes', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/tenants': [201, TENANT],
        'GET /v1/tenants': { tenants: [TENANT], nextCursor: 'c_2' },
        'GET /v1/tenants/t_1': TENANT,
        'PATCH /v1/tenants/t_1': { ...TENANT, status: 'disabled', disabledAt: 1790000001000 },
        'DELETE /v1/tenants/t_1': noContent,
        'POST /v1/tenants/t_1/enrollments': [
          201,
          { enrollmentToken: 'senr_1', expiresAt: 1790000900000 },
        ],
      },
      calls,
    )
    const t = await sai.tenants.create('Riverside Clinic', {
      externalId: 'clinic-4821',
      metadata: { plan: 'pro' },
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({
      name: 'Riverside Clinic',
      externalId: 'clinic-4821',
      metadata: { plan: 'pro' },
    })
    expect([t.id, t.externalId, t.metadata, t.machineCount]).toEqual([
      't_1',
      'clinic-4821',
      { plan: 'pro' },
      2,
    ])

    const page = await sai.tenants.list({ status: 'active', limit: 10 })
    expect(Object.fromEntries(calls[1]!.params)).toEqual({ status: 'active', limit: '10' })
    expect([page.tenants.map((x) => x.id), page.nextCursor]).toEqual([['t_1'], 'c_2'])
    await sai.tenants.list({ externalId: 'clinic-4821' })
    expect(Object.fromEntries(calls[2]!.params)).toEqual({ externalId: 'clinic-4821' })

    expect((await sai.tenants.get(t)).name).toBe('Riverside Clinic')
    const disabled = await sai.tenants.update('t_1', { status: 'disabled' })
    expect(JSON.parse(calls[4]!.body)).toEqual({ status: 'disabled' })
    expect([disabled.status, disabled.disabledAt]).toEqual(['disabled', 1790000001000])

    expect(await sai.tenants.delete(t)).toBeUndefined()
    const e = await sai.tenants.createEnrollment(t)
    expect([e.token, e.expiresAt]).toEqual(['senr_1', 1790000900000])
    expect(calls.slice(5).map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /v1/tenants/t_1',
      'POST /v1/tenants/t_1/enrollments',
    ])
  })

  it('lists, gets and revokes tenant machines', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'GET /v1/tenants/t_1/machines': { machines: [TENANT_MACHINE] },
        'GET /v1/tenants/t_1/machines/tm_1': TENANT_MACHINE,
        'DELETE /v1/tenants/t_1/machines/tm_1': noContent,
      },
      calls,
    )
    const [m] = await sai.tenantMachines.list('t_1')
    expect([m!.id, m!.platform, m!.online, m!.lastSeen, m!.runtimeVersion]).toEqual([
      'tm_1',
      'darwin',
      true,
      1790003600000,
      '1.2.0',
    ])
    expect((await sai.tenantMachines.get('t_1', 'tm_1')).name).toBe('Front desk PC')
    expect(await sai.tenantMachines.revoke('t_1', m!)).toBeUndefined()
    expect(`${calls[2]!.method} ${calls[2]!.path}`).toBe('DELETE /v1/tenants/t_1/machines/tm_1')
  })

  const CLOUD_MACHINE = {
    machineId: 'cm_1',
    kind: 'cloud',
    name: 'intake-desk-3',
    platform: 'win32',
    machineClass: 'win32-4c8g',
    state: 'provisioning',
    lastSeen: null,
    runtimeVersion: null,
    createdAt: 1790000000000,
  }
  const ENROLLED_MACHINE = {
    machineId: 'tm_1',
    kind: 'enrolled',
    name: 'Front desk PC',
    platform: 'darwin',
    state: 'offline',
    lastSeen: 1790003600000,
    runtimeVersion: '1.2.0',
    createdAt: 1789000000000,
  }

  it('parses both kinds of tenant machine and the older shape', async () => {
    const sai = client({
      'GET /v1/tenants/t_1/machines': {
        machines: [ENROLLED_MACHINE, { ...CLOUD_MACHINE, state: 'ready' }, TENANT_MACHINE],
      },
    })
    const [enrolled, cloud, older] = await sai.tenantMachines.list('t_1')
    expect([
      enrolled!.kind,
      enrolled!.state,
      enrolled!.online,
      enrolled!.machineClass,
      enrolled!.createdAt,
    ]).toEqual(['enrolled', 'offline', false, null, 1789000000000])
    expect([
      cloud!.kind,
      cloud!.state,
      cloud!.online,
      cloud!.machineClass,
      cloud!.platform,
    ]).toEqual(['cloud', 'ready', true, 'win32-4c8g', 'win32'])
    expect([older!.kind, older!.state, older!.online, older!.status, older!.createdAt]).toEqual([
      'enrolled',
      'online',
      true,
      'active',
      null,
    ])
  })

  it('creates a cloud machine and returns at once', async () => {
    const calls: Call[] = []
    const sai = client({ 'POST /v1/tenants/t_1/machines': [202, CLOUD_MACHINE] }, calls)
    const m = await sai.tenantMachines.create('t_1', {
      os: 'windows',
      name: 'intake-desk-3',
      requestId: 'req_1',
    })
    expect(JSON.parse(calls[0]!.body)).toEqual({
      os: 'windows',
      name: 'intake-desk-3',
      requestId: 'req_1',
    })
    expect([m.id, m.kind, m.state, m.machineClass]).toEqual([
      'cm_1',
      'cloud',
      'provisioning',
      'win32-4c8g',
    ])

    await sai.tenantMachines.create('t_1', { os: 'linux' })
    expect(JSON.parse(calls[1]!.body)).toEqual({ os: 'linux' })
    expect(calls).toHaveLength(2)
  })

  describe('create with wait', () => {
    const settle = async <T>(p: Promise<T>): Promise<T> => {
      const caught = p.catch((err: unknown) => err)
      await vi.runAllTimersAsync()
      const r = await caught
      if (r instanceof Error) throw r
      return p
    }
    afterEach(() => {
      vi.useRealTimers()
    })

    it('reads the machine until it is ready', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      const calls: Call[] = []
      const sai = client(
        {
          'POST /v1/tenants/t_1/machines': [202, CLOUD_MACHINE],
          'GET /v1/tenants/t_1/machines/cm_1': [
            CLOUD_MACHINE,
            { ...CLOUD_MACHINE, state: 'starting' },
            [429, { error: 'rate_limited', message: 'Slow down', retryAfterSeconds: 7 }],
            { ...CLOUD_MACHINE, state: 'ready' },
          ],
        },
        calls,
      )
      const m = await settle(sai.tenantMachines.create('t_1', { os: 'windows', wait: true }))
      expect([m.state, m.online]).toEqual(['ready', true])
      expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
        'POST /v1/tenants/t_1/machines',
        ...Array<string>(4).fill('GET /v1/tenants/t_1/machines/cm_1'),
      ])
    })

    it.each(['failed', 'deleting'])('throws when the machine is %s', async (state) => {
      vi.useFakeTimers({ toFake: ['setTimeout'] })
      const sai = client({
        'POST /v1/tenants/t_1/machines': [202, CLOUD_MACHINE],
        'GET /v1/tenants/t_1/machines/cm_1': { ...CLOUD_MACHINE, state },
      })
      const err = await settle(
        sai.tenantMachines.create('t_1', { os: 'windows', wait: true }),
      ).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(SaiError)
      expect((err as SaiError).message).toContain(`cm_1 is ${state}`)
      expect((err as SaiError).body.state).toBe(state)
    })

    it('throws a TimeoutError past timeoutMs', async () => {
      const sai = client({ 'POST /v1/tenants/t_1/machines': [202, CLOUD_MACHINE] })
      await expect(
        sai.tenantMachines.create('t_1', { os: 'windows', wait: true, timeoutMs: 0 }),
      ).rejects.toMatchObject({
        name: 'TimeoutError',
        message: 'Cloud machine cm_1 still provisioning.',
      })
    })
  })

  it('says whether a delete revoked or is deleting', async () => {
    const calls: Call[] = []
    const sai = client(
      {
        'DELETE /v1/tenants/t_1/machines/tm_1': noContent,
        'DELETE /v1/tenants/t_1/machines/cm_1': [202, { state: 'deleting' }],
      },
      calls,
    )
    expect(await sai.tenantMachines.delete('t_1', 'tm_1')).toBe('revoked')
    expect(await sai.tenantMachines.delete('t_1', 'cm_1')).toBe('deleting')
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'DELETE /v1/tenants/t_1/machines/tm_1',
      'DELETE /v1/tenants/t_1/machines/cm_1',
    ])
  })

  it('sets or clears the cloud machine limit and the proxy', async () => {
    const calls: Call[] = []
    const detail = { ...TENANT, cloudMachineLimit: 5, residentialProxy: true, cloudMachineCount: 2 }
    const sai = client(
      { 'PATCH /v1/tenants/t_1': detail, 'GET /v1/tenants': { tenants: [TENANT] } },
      calls,
    )
    const t = await sai.tenants.update('t_1', { cloudMachineLimit: 5, residentialProxy: true })
    expect(JSON.parse(calls[0]!.body)).toEqual({ cloudMachineLimit: 5, residentialProxy: true })
    expect([t.cloudMachineLimit, t.residentialProxy, t.cloudMachineCount]).toEqual([5, true, 2])

    await sai.tenants.update('t_1', { cloudMachineLimit: null })
    expect(JSON.parse(calls[1]!.body)).toEqual({ cloudMachineLimit: null })
    await sai.tenants.update('t_1', { name: 'Riverside', residentialProxy: false })
    expect(JSON.parse(calls[2]!.body)).toEqual({ name: 'Riverside', residentialProxy: false })

    const [listed] = (await sai.tenants.list()).tenants
    expect([
      listed!.cloudMachineLimit,
      listed!.residentialProxy,
      listed!.cloudMachineCount,
    ]).toEqual([null, null, null])
  })

  it.each([
    [402, { error: 'insufficient_credits', message: 'No credit.' }, SaiError],
    [
      403,
      {
        error: 'spend_cap_reached',
        message: 'Budget.',
        scope: 'tenant',
        resetsAt: '2026-11-01T00:00:00Z',
      },
      SpendCapReachedError,
    ],
    [409, { error: 'machine_limit_reached', message: 'Limit.', limit: 5, used: 5 }, ConflictError],
    [409, { error: 'request_id_reused', message: 'Reused.' }, ConflictError],
    [403, { error: 'tenant_disabled', message: 'Disabled.' }, PermissionDeniedError],
    [404, { error: 'not_found', message: 'Tenant not found.' }, NotFoundError],
    [503, { error: 'capacity_unavailable', message: 'No capacity.' }, ServiceUnavailableError],
    [429, { error: 'rate_limited', message: 'Too many.' }, RateLimitError],
    [500, { error: 'internal', message: 'Quote errorId.', errorId: 'e_1' }, SaiError],
  ] as const)('maps a %i create refusal', async (status, body, Cls) => {
    const sai = client({ 'POST /v1/tenants/t_1/machines': [status, body] })
    const err = (await sai.tenantMachines
      .create('t_1', { os: 'windows' })
      .catch((e: unknown) => e)) as SaiError
    expect(err.constructor).toBe(Cls)
    expect([err.status, err.code, err.message]).toEqual([status, body.error, body.message])
    expect(err.body).toEqual(body)
  })

  it('takes the token orgId from the client, the env or the call', async () => {
    const reply = { token: 'tt_1', expiresAt: 1790003600000, tenantId: 't_1' }
    const routes = {
      'POST /v1/orgs/org_a/tenants/t_1/token': reply,
      'POST /v1/orgs/org_b/tenants/t_1/token': reply,
      'POST /v1/orgs/org_env/tenants/t_1/token': reply,
    }
    vi.stubEnv('SAI_ORG_ID', '')
    await expect(client(routes).tenants.token('t_1')).rejects.toThrow(/SAI_ORG_ID/)

    const sai = client(routes, [], { orgId: 'org_a' })
    const tok = await sai.tenants.token('t_1')
    expect([tok.token, tok.expiresAt, tok.tenantId]).toEqual(['tt_1', 1790003600000, 't_1'])
    expect((await sai.tenants.token('t_1', { orgId: 'org_b' })).token).toBe('tt_1')

    vi.stubEnv('SAI_ORG_ID', 'org_env')
    expect((await client(routes).tenants.token('t_1')).token).toBe('tt_1')
  })

  it('acts as the tenant and exchanges again before the token expires', async () => {
    const now = Date.now()
    const calls: Call[] = []
    const sai = client(
      {
        'POST /v1/orgs/org_a/tenants/t_1/token': [
          { token: 'tt_1', expiresAt: now + 4 * 60 * 1000, tenantId: 't_1' },
          { token: 'tt_2', expiresAt: now + 60 * 60 * 1000, tenantId: 't_1' },
        ],
        'GET /v1/agents/machines': MACHINES,
      },
      calls,
      { orgId: 'org_a' },
    )
    const tenant = await sai.tenants.client('t_1')
    expect(calls.map((c) => c.path)).toEqual(['/v1/orgs/org_a/tenants/t_1/token'])
    expect(calls[0]!.headers.get('authorization')).toBe('Bearer sapi_test')

    // tt_1 has under five minutes left: two requests at once share one exchange
    await Promise.all([tenant.machines.list(), tenant.machines.list()])
    await tenant.machines.list()
    expect(calls.slice(1).map((c) => c.path)).toEqual([
      '/v1/orgs/org_a/tenants/t_1/token',
      '/v1/agents/machines',
      '/v1/agents/machines',
      '/v1/agents/machines',
    ])
    expect(calls.slice(2).map((c) => c.headers.get('authorization'))).toEqual([
      'Bearer tt_2',
      'Bearer tt_2',
      'Bearer tt_2',
    ])
  })
})
