#!/usr/bin/env node
/**
 * The mock Sai API every SDK's conformance tests run against. No dependencies.
 *
 *   node conformance/server.mjs [--port 0]
 *
 * Prints `SAI_MOCK_URL=http://127.0.0.1:<port>` on its first line once it listens.
 *
 * Two modes:
 *
 * - **Scripted** (a case is running): `POST /__mock/start { "case": "<id>" }` loads one case from
 *   `cases/*.json`. Every API request must then match the case's next `exchanges[]` entry, which
 *   answers it; a request that does not match gets a 599 and is reported. The runner sends what
 *   each step returned or threw to `POST /__mock/step`, and `POST /__mock/finish` answers with
 *   every failure: unmatched requests, unused exchanges, and steps whose outcome differs from
 *   `expect`. One implementation of the matching, for every language.
 * - **Fake** (no case running): a small in-memory Sai API that answers any reasonable call, so
 *   the code snippets in the docs can run end to end. `POST /__mock/reset` empties it.
 *
 * See README.md for the case format.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const CASES_DIR = join(HERE, 'cases')

export function loadCases(dir = CASES_DIR) {
  const cases = new Map()
  for (const file of readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .sort()) {
    const list = JSON.parse(readFileSync(join(dir, file), 'utf8'))
    for (const c of list.cases ?? list) {
      if (cases.has(c.id)) throw new Error(`duplicate case id ${c.id} in ${file}`)
      cases.set(c.id, { ...c, file })
    }
  }
  return cases
}

// ─── Matching ──────────────────────────────────────────────────────────────────

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

/** Exact JSON equality; numbers compare by value. */
export function deepEqual(a, b) {
  if (Array.isArray(a))
    return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  if (isObj(a)) {
    if (!isObj(b)) return false
    const ka = Object.keys(a).sort()
    const kb = Object.keys(b).sort()
    return deepEqual(ka, kb) && ka.every((k) => deepEqual(a[k], b[k]))
  }
  return a === b
}

/**
 * `expected` describes `actual`: objects list only the keys they check (a key the actual lacks
 * matches only an expected null), arrays match in length and order, and these markers match
 * loosely: `{ "$any": true }` anything, `{ "$absent": true }` a missing or null key,
 * `{ "$regex": "…" }` a string, `{ "$len": n }` an array or string of that length.
 * Returns the first difference as a string, or null.
 */
export function subsetDiff(expected, actual, path = '$') {
  if (isObj(expected)) {
    if ('$any' in expected) return actual === undefined ? `${path}: missing` : null
    if ('$absent' in expected)
      return actual === undefined || actual === null
        ? null
        : `${path}: expected absent, got ${show(actual)}`
    if ('$regex' in expected) {
      return typeof actual === 'string' && new RegExp(expected.$regex).test(actual)
        ? null
        : `${path}: expected /${expected.$regex}/, got ${show(actual)}`
    }
    if ('$len' in expected) {
      return actual != null && actual.length === expected.$len
        ? null
        : `${path}: expected length ${expected.$len}, got ${show(actual)}`
    }
    if (!isObj(actual)) return `${path}: expected an object, got ${show(actual)}`
    for (const [k, v] of Object.entries(expected)) {
      const a = actual[k]
      if (a === undefined && v === null) continue
      if (a === undefined && !(isObj(v) && '$absent' in v))
        return `${path}.${k}: missing (expected ${show(v)})`
      const d = subsetDiff(v, a, `${path}.${k}`)
      if (d) return d
    }
    return null
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${path}: expected an array, got ${show(actual)}`
    if (actual.length !== expected.length)
      return `${path}: expected ${expected.length} items, got ${actual.length}: ${show(actual)}`
    for (let i = 0; i < expected.length; i++) {
      const d = subsetDiff(expected[i], actual[i], `${path}[${i}]`)
      if (d) return d
    }
    return null
  }
  if (actual === undefined && expected === null) return null
  return expected === actual ? null : `${path}: expected ${show(expected)}, got ${show(actual)}`
}

const show = (v) => {
  const s = JSON.stringify(v)
  return s === undefined ? 'undefined' : s.length > 300 ? s.slice(0, 300) + '…' : s
}

function matchRequest(want, got) {
  const problems = []
  if (want.method !== got.method) problems.push(`method ${got.method}, expected ${want.method}`)
  if (want.path !== got.path) problems.push(`path ${got.path}, expected ${want.path}`)
  if (want.query) {
    if (!deepEqual(want.query, got.query))
      problems.push(`query ${show(got.query)}, expected ${show(want.query)}`)
  }
  if (want.query_subset) {
    const d = subsetDiff(want.query_subset, got.query, 'query')
    if (d) problems.push(d)
  }
  for (const [name, value] of Object.entries(want.headers ?? {})) {
    const d = subsetDiff(value, got.headers[name.toLowerCase()], `header ${name}`)
    if (d) problems.push(d)
  }
  if ('json' in want || 'json_subset' in want) {
    let body
    try {
      body = got.body.length ? JSON.parse(got.body.toString('utf8')) : undefined
    } catch {
      problems.push(`body is not JSON: ${show(got.body.toString('utf8'))}`)
    }
    if ('json' in want && !deepEqual(want.json, body))
      problems.push(`json ${show(body)}, expected ${show(want.json)}`)
    if ('json_subset' in want) {
      const d = subsetDiff(want.json_subset, body, 'json')
      if (d) problems.push(d)
    }
  }
  if ('body_base64' in want && got.body.toString('base64') !== want.body_base64) {
    problems.push(`body ${got.body.toString('base64')} (base64), expected ${want.body_base64}`)
  }
  if (want.body_empty && got.body.length)
    problems.push(`body ${show(got.body.toString('utf8'))}, expected none`)
  return problems
}

// ─── Scripted mode ─────────────────────────────────────────────────────────────

class Run {
  constructor(c) {
    this.case = c
    this.next = 0
    this.failures = []
    this.steps = new Set()
  }

  answer(req) {
    const ex = this.case.exchanges ?? []
    const want = ex[this.next]
    if (!want) {
      this.failures.push(
        `unexpected request ${req.method} ${req.path}${qs(req.query)}: the case has no more exchanges`,
      )
      return { status: 599, json: { error: 'unexpected_request' } }
    }
    const problems = matchRequest(want.request, req)
    if (problems.length) {
      this.failures.push(
        `request ${this.next + 1} (${req.method} ${req.path}${qs(req.query)}): ${problems.join('; ')}`,
      )
      return { status: 599, json: { error: 'request_mismatch', problems } }
    }
    this.next++
    return want.response ?? { status: 200, json: {} }
  }

  step(index, outcome) {
    const step = this.case.steps?.[index]
    if (!step) {
      this.failures.push(`step ${index}: the case has no such step`)
      return
    }
    this.steps.add(index)
    const label = `step ${index} (${step.call})`
    const expect = step.expect ?? {}
    if ('error' in expect) {
      if (!outcome.error)
        return void this.failures.push(
          `${label}: expected ${expect.error.class}, returned ${show(outcome.result)}`,
        )
      const d = subsetDiff(expect.error, outcome.error, 'error')
      if (d) this.failures.push(`${label}: ${d}`)
      return
    }
    if (outcome.error) {
      return void this.failures.push(
        `${label}: threw ${outcome.error.class}: ${outcome.error.message}`,
      )
    }
    if ('result' in expect) {
      const d = subsetDiff(expect.result, outcome.result, 'result')
      if (d) this.failures.push(`${label}: ${d}`)
    }
  }

  finish() {
    const failures = [...this.failures]
    const left = (this.case.exchanges ?? []).slice(this.next)
    if (left.length) {
      failures.push(
        `${left.length} exchange(s) never requested, from ${left[0].request.method} ${left[0].request.path}`,
      )
    }
    for (const [i, step] of (this.case.steps ?? []).entries()) {
      if (!this.steps.has(i)) failures.push(`step ${i} (${step.call}) was not reported`)
    }
    return { ok: failures.length === 0, failures }
  }
}

const qs = (q) => (Object.keys(q).length ? '?' + new URLSearchParams(q).toString() : '')

// ─── Fake mode ─────────────────────────────────────────────────────────────────

/**
 * Just enough of the API for the docs' snippets: one computer, turns that finish on the first
 * poll, learn jobs that succeed, a control lease, tenants and their machines kept in memory.
 */
class Fake {
  constructor() {
    this.n = 0
    this.tenants = new Map()
    this.tenantMachines = new Map()
    this.turns = new Map()
  }

  id(prefix) {
    return `${prefix}_${++this.n}`
  }

  machine(id = 'm_1') {
    return {
      machineId: id,
      name: 'Work PC',
      kind: 'cloud',
      online: true,
      state: 'running',
      status: 'running',
      canWake: true,
      os: 'windows',
    }
  }

  turnRecord(turnId) {
    const t = this.turns.get(turnId) ?? { sessionId: 'cs_1', message: '' }
    return {
      turnId,
      sessionId: t.sessionId,
      machineId: 'm_1',
      status: 'succeeded',
      output: t.schema ? sample(t.schema) : 'Done.',
      rawAnswer: 'Done.',
      reasonCode: null,
      errorCode: null,
      outputErrors: [],
      evidence: [{ id: 'saved', passed: true, score: 1, evidence: 'The file is on the desktop.' }],
      usage: USAGE,
      recordTrajectory: true,
      trajectoryRecorded: true,
      template: t.message,
      inputs: t.inputs ?? null,
      replayed: false,
      createdAt: 1767225600000,
      finishedAt: 1767225660000,
    }
  }

  learn(id, body = {}) {
    const policy = (body.maxIterations ?? 0) > 0
    return {
      learnId: id,
      mode: policy ? 'policyIteration' : body.initialCode ? 'heal' : 'convert',
      status: 'succeeded',
      title: 'Save a note',
      taskTemplate: body.taskTemplate ?? 'Save {{text}} to the desktop',
      template: body.taskTemplate ?? 'Save {{text}} to the desktop',
      parameters: [{ name: 'text', defaultValue: 'hello', description: 'What to type' }],
      code: 'async function main({ text = "hello" } = {}) {\n  return text\n}',
      outputSchema: null,
      validation: { errors: [], warnings: [] },
      changes: null,
      sourceTurns: body.turns ?? [],
      version: 1,
      iterations: policy
        ? [
            {
              index: 0,
              learnId: id,
              changes: null,
              passed: 1,
              runs: 1,
              rollouts: [
                {
                  index: 0,
                  verdict: 'passed',
                  judgementId: 'jd_1',
                  summary: 'It worked.',
                  durationMs: 1000,
                },
              ],
            },
          ]
        : [],
      testResult: policy
        ? { status: 'passed', passedRuns: 1, requiredRuns: 1, inputs: body.inputs ?? null }
        : null,
      createdAt: 1767225600000,
    }
  }

  handle(req) {
    const { method, path } = req
    const body = req.json ?? {}
    const route = `${method} ${path}`
    let m

    // Sessions and turns
    if (route === 'GET /v1/agents/auth') return ok({ ok: true, userId: 'u_1', authType: 'apiKey' })
    if (route === 'GET /v1/agents/machines') return ok({ machines: [this.machine()] })
    if ((m = /^(POST|DELETE) \/v1\/agents\/machines\/([^/]+)\/live$/.exec(route))) {
      if (m[1] === 'DELETE') return ok({ revoked: 1 })
      return ok({
        machineId: dec(m[2]),
        liveUrl: 'https://live.simular.ai/v/abc',
        expiresAt: 1767229200000,
        websocketUrl: 'wss://live.simular.ai/tunnel',
        width: 1280,
        height: 800,
      })
    }
    if (route === 'GET /v1/agents/models')
      return ok({
        models: [
          {
            id: 'auto',
            name: 'Sai Agent',
            provider: 'anthropic',
            tier: 'balanced',
            costTier: '$',
            allowed: true,
          },
        ],
      })
    if (route === 'GET /v1/agents/account')
      return ok({
        userId: 'u_1',
        plan: { id: 'pro', title: 'Pro', free: false, unlimited: false },
        credits: { usd: 25 },
      })
    if (route === 'POST /v1/agents/upload') {
      return ok({
        fileId: this.id('f'),
        name: dec(req.headers['x-filename'] ?? 'file'),
        mime: 'text/plain',
        size: req.body.length,
        path: 'uploads/file',
      })
    }
    if (route === 'POST /v1/agents/new-session') return ok({ sessionId: this.id('cs') })
    if (route === 'GET /v1/agents/sessions') {
      return ok({
        sessions: [
          { sessionId: 'cs_1', title: 'Save a note', updatedAt: 1767225600000, active: true },
        ],
      })
    }
    if (route === 'POST /v1/agents/message') {
      const sessionId = body.sessionId ?? this.id('cs')
      const turnId = this.id('turn')
      const o = body.options ?? {}
      this.turns.set(turnId, {
        sessionId,
        message: body.message,
        inputs: o.inputs,
        schema: o.output_schema,
      })
      return {
        status: 202,
        json: { sessionId, machineId: body.machineId ?? 'm_1', turnId, queued: false },
      }
    }
    if (route === 'GET /v1/agents/events') {
      return ok({
        sessionId: req.query.sessionId,
        status: 'idle',
        events: [
          { type: 'data-progress', data: { text: 'Opening Notepad', tool: 'execute' } },
          { type: 'text-delta', id: 't', delta: 'Done.' },
          { type: 'finish', finishReason: 'stop' },
        ],
        text: 'Done.',
        cursor: 'c_1',
        usage: USAGE,
        sessionUsage: USAGE,
      })
    }
    if (route === 'POST /v1/agents/approve')
      return ok({ ok: true, status: body.response === 'no' ? 'denied' : 'approved' })
    if (route === 'POST /v1/agents/abort') return ok({ ok: true, aborted: true })
    if ((m = /^GET \/v1\/agents\/turns\/([^/]+)$/.exec(route)))
      return ok(this.turnRecord(dec(m[1])))
    if ((m = /^GET \/v1\/agents\/turns\/([^/]+)\/trajectory$/.exec(route))) {
      return ok({
        steps: [
          {
            index: 0,
            final: false,
            timestamp: '2026-01-01T00:00:00Z',
            title: 'Open Notepad',
            code: 'await machine.open("notepad")',
            rationale: null,
            error: null,
            hasScreenshot: true,
          },
          {
            index: 1,
            final: true,
            timestamp: '2026-01-01T00:00:05Z',
            title: null,
            code: null,
            rationale: null,
            error: null,
            hasScreenshot: true,
          },
        ],
      })
    }
    if (/^GET \/v1\/agents\/turns\/[^/]+\/trajectory\/screenshots\/\d+$/.test(route))
      return { status: 200, bytes: JPEG }

    // Learn and judge
    if (route === 'POST /v1/agents/learn') {
      const id = this.id('ln')
      const r = this.learn(id, body)
      if ((body.maxIterations ?? 0) > 0)
        return ok({
          ...r,
          status: 'running',
          progress: { step: 'agent_run', iteration: null, rollout: null },
        })
      return ok(r)
    }
    if ((m = /^GET \/v1\/agents\/learn\/([^/]+)$/.exec(route)))
      return ok(this.learn(dec(m[1]), { maxIterations: 1 }))
    if (/^POST \/v1\/agents\/learn\/[^/]+\/cancel$/.test(route)) return ok({ ok: true })
    if (
      (m = /^GET \/v1\/agents\/learn\/([^/]+)\/iterations\/(\d+)\/rollouts\/(\d+)$/.exec(route))
    ) {
      return ok({
        learnId: dec(m[1]),
        iteration: Number(m[2]),
        rollout: Number(m[3]),
        run: { result: 'hello', logs: ['typed hello'], durationMs: 900 },
        judgement: { judgementId: 'jd_1', verdict: 'passed', summary: 'It worked.' },
      })
    }
    if (route === 'POST /v1/agents/judge') return ok(JUDGEMENT)
    if (/^GET \/v1\/agents\/judge\/[^/]+$/.test(route)) return ok(JUDGEMENT)

    // Direct control
    if ((m = /^(POST|GET|DELETE) \/v1\/machines\/([^/]+)\/control$/.exec(route))) {
      if (m[1] === 'POST')
        return ok({ machineId: dec(m[2]), status: 'open', expiresAfterIdleSec: 300 })
      if (m[1] === 'GET')
        return ok({ machineId: dec(m[2]), status: 'open', lastExecAt: 1767225600000 })
      return { status: 204 }
    }
    if (/^POST \/v1\/machines\/[^/]+\/control\/exec$/.test(route))
      return ok(this.exec(body.code ?? ''))
    if (/^POST \/v1\/machines\/[^/]+\/control\/interrupt$/.test(route))
      return ok({ interrupted: false })

    // Organisations
    if ((m = /^POST \/v1\/orgs\/([^/]+)\/tenants\/([^/]+)\/token$/.exec(route))) {
      return ok({ token: `tt_${dec(m[2])}`, expiresAt: Date.now() + 3600_000, tenantId: dec(m[2]) })
    }
    if ((m = /^GET \/v1\/orgs\/([^/]+)\/usage$/.exec(route))) {
      const g = req.query.granularity ?? 'day'
      const from = req.query.from ?? '2026-10'
      const to = req.query.to ?? from
      const byTenant = {
        t_1: {
          tenantId: 't_1',
          name: 'Riverside Clinic',
          externalId: 'clinic-4821',
          costCents: 1215,
          byCategory: { token: { costCents: 905 }, compute: { costCents: 310 } },
        },
      }
      return ok({
        granularity: g,
        from,
        to,
        totals: { costCents: 1840, byTenant },
        buckets: [{ bucket: from, costCents: 1840, byTenant }],
      })
    }
    if (/^GET \/v1\/orgs\/[^/]+\/usage\/sessions$/.test(route)) {
      return ok({
        sessions: [
          {
            sessionId: 'cs_1',
            title: 'Reconcile the October invoices',
            costUsd: 0.4172,
            modelCalls: 23,
            firstDay: '2026-10-03',
            lastDay: '2026-10-04',
          },
        ],
        nextCursor: null,
        dataThrough: '2026-10-28T09:45:00Z',
      })
    }
    if (route === 'POST /v1/tenants') {
      const t = {
        tenantId: this.id('t'),
        name: body.name,
        externalId: body.externalId ?? null,
        metadata: body.metadata ?? {},
        status: 'active',
        createdAt: 1767225600000,
        disabledAt: null,
        machineCount: 0,
        cloudMachineLimit: null,
        residentialProxy: false,
        cloudMachineCount: 0,
      }
      this.tenants.set(t.tenantId, t)
      return { status: 201, json: t }
    }
    if (route === 'GET /v1/tenants') {
      let list = [...this.tenants.values()].reverse()
      if (req.query.externalId) list = list.filter((t) => t.externalId === req.query.externalId)
      if (req.query.status) list = list.filter((t) => t.status === req.query.status)
      return ok({ tenants: list, nextCursor: null })
    }
    if ((m = /^(GET|PATCH|DELETE) \/v1\/tenants\/([^/]+)$/.exec(route))) {
      const t = this.tenant(dec(m[2]))
      if (m[1] === 'PATCH') Object.assign(t, body)
      if (m[1] === 'DELETE') {
        t.status = 'disabled'
        return { status: 204 }
      }
      return ok(t)
    }
    if ((m = /^POST \/v1\/tenants\/([^/]+)\/enrollments$/.exec(route))) {
      return {
        status: 201,
        json: { enrollmentToken: 'senr_7Hq2', expiresAt: Date.now() + 900_000 },
      }
    }
    if ((m = /^(GET|POST) \/v1\/tenants\/([^/]+)\/machines$/.exec(route))) {
      const tenantId = dec(m[2])
      if (m[1] === 'GET')
        return ok({
          machines: [...this.tenantMachines.values()]
            .filter((x) => x.tenantId === tenantId)
            .map(({ tenantId: _, ...x }) => x),
        })
      const id = this.id('cm')
      const machine = {
        tenantId,
        machineId: id,
        name: body.name ?? null,
        platform: body.os ?? 'windows',
        status: 'active',
        online: false,
        lastSeen: null,
        runtimeVersion: null,
        kind: 'cloud',
        state: 'provisioning',
        machineClass: body.os === 'linux' ? 'linux-standard' : 'windows-standard',
        createdAt: Date.now(),
      }
      this.tenantMachines.set(id, machine)
      const { tenantId: _, ...out } = machine
      return { status: 201, json: out }
    }
    if ((m = /^(GET|DELETE) \/v1\/tenants\/([^/]+)\/machines\/([^/]+)$/.exec(route))) {
      const id = dec(m[3])
      const machine = this.tenantMachines.get(id) ?? {
        machineId: id,
        name: 'Front desk',
        platform: 'windows',
        status: 'active',
        online: true,
        lastSeen: Date.now(),
        runtimeVersion: '1.4.0',
        kind: 'enrolled',
        state: 'ready',
        machineClass: null,
        createdAt: 1767225600000,
      }
      if (m[1] === 'DELETE') {
        if (machine.kind === 'cloud') {
          machine.state = 'deleting'
          return { status: 202, json: { state: 'deleting' } }
        }
        return { status: 204 }
      }
      // A cloud machine is ready on its first read.
      if (machine.state === 'provisioning') machine.state = 'ready'
      const { tenantId: _, ...out } = machine
      return ok(out)
    }

    return {
      status: 404,
      json: { error: 'not_found', message: `The fake API has no route ${route}.` },
    }
  }

  tenant(id) {
    let t = this.tenants.get(id)
    if (!t) {
      t = {
        tenantId: id,
        name: 'Riverside Clinic',
        externalId: 'clinic-4821',
        metadata: {},
        status: 'active',
        createdAt: 1767225600000,
        disabledAt: null,
        machineCount: 1,
        cloudMachineLimit: null,
        residentialProxy: false,
        cloudMachineCount: 0,
      }
      this.tenants.set(id, t)
    }
    return t
  }

  /** A Simulang block: what the docs' helpers send, answered with a plausible result. */
  exec(code) {
    const base = { logs: [], error: null, variables: [], durationMs: 12 }
    if (code.includes('machine.exec('))
      return { ...base, result: { stdout: 'hello\n', stderr: '', exitCode: 0, timedOut: false } }
    if (code.includes('machine.readFile(')) return { ...base, result: 'hello' }
    if (code.includes('machine.writeToFile(')) return { ...base, result: null }
    if (code.includes('pageContent()') || code.includes('snapshot()'))
      return {
        ...base,
        result: null,
        observations: { screenshot: { base64: JPEG.toString('base64'), mimeType: 'image/jpeg' } },
      }
    return { ...base, result: 'hello', logs: ['ok'] }
  }
}

/** A value that matches a JSON Schema, for a structured turn's output. */
function sample(schema) {
  if (Array.isArray(schema?.enum)) return schema.enum[0]
  switch (Array.isArray(schema?.type) ? schema.type[0] : schema?.type) {
    case 'string':
      return 'example'
    case 'number':
    case 'integer':
      return 42
    case 'boolean':
      return true
    case 'array':
      return schema.items ? [sample(schema.items)] : []
    case 'null':
      return null
    default:
      return Object.fromEntries(
        Object.entries(schema?.properties ?? {}).map(([k, v]) => [k, sample(v)]),
      )
  }
}

const USAGE = {
  inputTokens: 1200,
  outputTokens: 80,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.01,
  modelCalls: 2,
  byModel: {},
}
const JUDGEMENT = {
  judgementId: 'jd_1',
  verdict: 'passed',
  summary: 'The note was saved.',
  task: 'Save a note',
  criteria: [
    {
      id: 'saved',
      check: 'The note is saved',
      verdict: 'passed',
      score: 1,
      evidence: 'hello.txt is on the desktop.',
    },
  ],
  turns: ['turn_1'],
  createdAt: 1767225600000,
}
// The smallest valid JPEG header bytes; enough for a snippet that writes it to a file.
const JPEG = Buffer.from('/9j/4AAQSkZJRgABAQAAAQABAAD/2Q==', 'base64')

/** `{ "$now_plus_ms": n }` in a response is the time n ms from now, in ms: for token expiries. */
function withNow(v) {
  if (Array.isArray(v)) return v.map(withNow)
  if (!isObj(v)) return v
  if ('$now_plus_ms' in v) return Date.now() + v.$now_plus_ms
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, withNow(x)]))
}

const ok = (json) => ({ status: 200, json })
const dec = (s) => decodeURIComponent(s)

// ─── Server ────────────────────────────────────────────────────────────────────

export function startServer({ port = 0, casesDir = CASES_DIR } = {}) {
  const cases = loadCases(casesDir)
  let run = null
  let fake = new Fake()

  const server = createServer(async (req, res) => {
    const chunks = []
    for await (const c of req) chunks.push(c)
    const body = Buffer.concat(chunks)
    const url = new URL(req.url, 'http://mock')
    const query = Object.fromEntries(url.searchParams)
    const send = (r) => {
      const headers = { ...(r.headers ?? {}) }
      let payload = ''
      if (r.bytes) {
        headers['content-type'] ??= 'image/jpeg'
        payload = r.bytes
      } else if (r.body_base64 !== undefined) {
        payload = Buffer.from(r.body_base64, 'base64')
      } else if (r.text !== undefined) {
        headers['content-type'] ??= 'text/plain'
        payload = r.text
      } else if (r.json !== undefined) {
        headers['content-type'] ??= 'application/json'
        payload = JSON.stringify(withNow(r.json))
      }
      res.writeHead(r.status ?? 200, headers)
      res.end(r.status === 204 ? undefined : payload)
    }
    const json = () => (body.length ? JSON.parse(body.toString('utf8')) : {})

    try {
      if (url.pathname.startsWith('/__mock/')) {
        const what = url.pathname.slice('/__mock/'.length)
        if (what === 'cases') return send(ok([...cases.values()]))
        if (what === 'start') {
          const b = json()
          const c = typeof b.case === 'string' ? cases.get(b.case) : b.case
          if (!c) return send({ status: 404, json: { error: `no case ${b.case}` } })
          run = new Run(c)
          return send(ok(c))
        }
        if (what === 'step') {
          if (!run) return send({ status: 409, json: { error: 'no case running' } })
          const b = json()
          run.step(b.index, b)
          return send(ok({ ok: true }))
        }
        if (what === 'finish') {
          const result = run ? run.finish() : { ok: false, failures: ['no case running'] }
          run = null
          return send(ok(result))
        }
        if (what === 'reset') {
          run = null
          fake = new Fake()
          return send(ok({ ok: true }))
        }
        return send({ status: 404, json: { error: 'unknown control route' } })
      }

      const request = { method: req.method, path: url.pathname, query, headers: req.headers, body }
      if (run) {
        const r = run.answer(request)
        if (r.delay_ms) await new Promise((ok) => setTimeout(ok, r.delay_ms))
        return send(r)
      }
      let parsed
      if (body.length && (req.headers['content-type'] ?? '').includes('json'))
        parsed = JSON.parse(body.toString('utf8'))
      if (!/^Bearer \S+/.test(req.headers.authorization ?? '')) {
        return send({ status: 401, json: { error: 'Missing or invalid Authorization header' } })
      }
      return send(fake.handle({ ...request, json: parsed }))
    } catch (err) {
      return send({
        status: 500,
        json: { error: 'mock_error', message: String(err?.stack ?? err) },
      })
    }
  })

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const i = process.argv.indexOf('--port')
  const port = i > 0 ? Number(process.argv[i + 1]) : 0
  const server = await startServer({ port })
  const { port: actual } = server.address()
  process.stdout.write(`SAI_MOCK_URL=http://127.0.0.1:${actual}\n`)
  // Exit with the parent: a test run that dies must not leave the server behind.
  process.stdin.on('end', () => process.exit(0))
  process.stdin.resume()
}
