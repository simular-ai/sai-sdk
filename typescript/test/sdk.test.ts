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
  Sai,
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
function client(routes: Record<string, Reply | Reply[]>, calls: Call[] = []): Sai {
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
  return new Sai({ apiKey: 'sapi_test', baseUrl: 'https://api.test', fetch })
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
        ],
        'DELETE /v1/machines/m_1/control': () => new Response(null, { status: 204 }),
      },
      calls,
    )
    {
      await using cs = await sai.control.open({ machine: 'm_1' })
      expect((await cs.shell('hostname')).stdout.trim()).toBe('HOST')
      expect(await cs.screenshot()).toEqual(png)
      const r = await cs.exec("throw new Error('boom')")
      expect(r.ok).toBe(false)
      expect(r.error?.kind).toBe('exception')
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
    const cs = await sai.control.open({ machine: 'm_1' })
    const err = await cs.exec('1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GoneError)
    expect((err as GoneError).code).toBe('control_closed')
    expect((err as GoneError).body.reason).toBe('unresponsive')
    await cs.close()
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
