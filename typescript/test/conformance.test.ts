/**
 * The shared conformance suite (../../conformance/README.md): each case's steps become calls on
 * this SDK, against the mock server, which checks the requests and the outcomes.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { fileURLToPath } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import {
  BlockError,
  ControlLease,
  LinkOnlyApprovalError,
  Sai,
  SaiError,
  Session,
  SpendCapReachedError,
  Turn,
  type Approval,
  type ApprovalAnswer,
  type Check,
  type Evaluation,
  type ExecResult,
} from '../src/index.js'

const CONFORMANCE = fileURLToPath(new URL('../../conformance/', import.meta.url))

interface Step {
  call: string
  args?: Record<string, unknown>
  save?: string
  pick?: string
}
interface Case {
  id: string
  doc?: string
  client?: { api_key?: string; org_id?: string; version_tag?: string }
  steps: Step[]
}

const cases: Case[] = readdirSync(`${CONFORMANCE}cases`)
  .filter((f) => f.endsWith('.json'))
  .sort()
  .flatMap(
    (f) =>
      (JSON.parse(readFileSync(`${CONFORMANCE}cases/${f}`, 'utf8')) as { cases: Case[] }).cases,
  )

let server: ChildProcess
let mockUrl: string

beforeAll(async () => {
  server = spawn('node', [`${CONFORMANCE}server.mjs`], { stdio: ['pipe', 'pipe', 'inherit'] })
  const line = await new Promise<string>((resolve, reject) => {
    createInterface({ input: server.stdout! }).once('line', resolve)
    server.once('exit', (code) => reject(new Error(`mock server exited (${code})`)))
  })
  mockUrl = line.replace('SAI_MOCK_URL=', '')
})

afterAll(() => {
  server.kill()
})

async function control(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${mockUrl}/__mock/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  return (await res.json()) as Record<string, unknown>
}

describe('conformance', () => {
  for (const c of cases) {
    it(c.id, { timeout: 30_000 }, async () => {
      await control('start', { case: c.id })
      const sai = new Sai({
        apiKey: c.client?.api_key ?? 'sapi_test',
        baseUrl: mockUrl,
        orgId: c.client?.org_id ?? '',
        versionTag: c.client?.version_tag,
      })
      const saved = new Map<string, unknown>([['client', sai]])
      for (const [index, step] of c.steps.entries()) {
        let outcome: Record<string, unknown>
        try {
          const value = await invoke(saved, step)
          outcome = { result: project(value) }
          if (step.save)
            saved.set(step.save, step.pick === undefined ? value : pick(value, step.pick))
        } catch (err) {
          outcome = { error: projectError(err) }
        }
        await control('step', { index, ...outcome })
      }
      const { failures } = (await control('finish', {})) as { failures: string[] }
      expect(failures).toEqual([])
    })
  }
})

// ─── Calls ───────────────────────────────────────────────────────────────────

type Args = Record<string, unknown>

async function invoke(saved: Map<string, unknown>, step: Step): Promise<unknown> {
  const parts = step.call.split('.')
  const first = parts[0]!
  const [target, rest] =
    saved.has(first) && first !== 'client'
      ? [saved.get(first), parts.slice(1)]
      : [saved.get('client'), parts]
  const a = resolve(saved, step.args ?? {}) as Args
  if (target instanceof Sai) return callClient(target, rest.join('.'), a)
  if (target instanceof Session) return callSession(target, rest.join('.'), a)
  if (target instanceof Turn) return callTurn(target, rest.join('.'), a)
  if (target instanceof ControlLease) return callLease(target, rest.join('.'), a)
  throw new Error(`no target for ${step.call}`)
}

/** `{ $ref }` → the saved object, everywhere in the arguments. */
function resolve(saved: Map<string, unknown>, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => resolve(saved, x))
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    if (typeof o.$ref === 'string') {
      if (!saved.has(o.$ref)) throw new Error(`nothing saved as ${o.$ref}`)
      return saved.get(o.$ref)
    }
    return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, resolve(saved, x)]))
  }
  return v
}

function pick(value: unknown, path: string): unknown {
  let v = value
  for (const part of path.split('.')) {
    v = Array.isArray(v) ? v[Number(part)] : (v as Record<string, unknown>)[camel(part)]
  }
  return v
}

const camel = (s: string): string => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase())
const snake = (s: string): string => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)

/** Only the keys the case gave, renamed to camelCase. */
function opts(a: Args, ...keys: string[]): Record<string, unknown> {
  const o: Record<string, unknown> = {}
  for (const k of keys) if (k in a) o[camel(k)] = a[k]
  return o
}

const checks = (v: unknown): string | Check[] =>
  typeof v === 'string'
    ? v
    : (v as Args[]).map((c) => ({
        id: c.id as string,
        check: c.check as string,
        ...(c.return_evidence !== undefined && { returnEvidence: c.return_evidence as boolean }),
      }))

function sendOpts(a: Args): Record<string, unknown> {
  const o = opts(
    a,
    'model',
    'attachments',
    'inputs',
    'output_schema',
    'idempotency_key',
    'record_trajectory',
    'thinking_level',
    'autonomous',
  )
  if ('success_criteria' in a) o.successCriteria = checks(a.success_criteria)
  return o
}

function waitOpts(a: Args): Record<string, unknown> {
  const o = opts(a, 'poll_wait')
  if (a.on_approval) {
    const answers = [...(a.on_approval as { answers: unknown[] }).answers]
    o.onApproval = (_: Approval): ApprovalAnswer =>
      answers.length ? (answers.shift() as ApprovalAnswer) : null
  }
  return o
}

async function callClient(sai: Sai, method: string, a: Args): Promise<unknown> {
  switch (method) {
    case 'machines.list':
      return sai.machines.list()
    case 'machines.get':
      return sai.machines.get(a.machine_id as string)
    case 'machines.live':
      return sai.machines.live(a.machine as string)
    case 'machines.revoke_live':
      return sai.machines.revokeLive(a.machine as string)
    case 'sessions.create':
      return sai.sessions.create(opts(a, 'machine'))
    case 'sessions.resume':
      return sai.sessions.resume(a.session_id as string, opts(a, 'machine'))
    case 'sessions.list':
      return sai.sessions.list(opts(a, 'machine'))
    case 'turns.get':
      return sai.turns.get(a.turn as string)
    case 'turns.wait':
      return sai.turns.wait(a.turn as string)
    case 'turns.trajectory':
      return sai.turns.trajectory(a.turn as string)
    case 'turns.screenshot':
      return sai.turns.screenshot(a.turn as string, a.index as number)
    case 'learn.create': {
      const o = opts(
        a,
        'task_template',
        'inputs',
        'initial_code',
        'guidance',
        'history',
        'runs_without_reset',
        'max_iterations',
        'rollouts',
        'machine',
        'reset',
        'judge_initial_agent_run',
        'continue_with_agent',
        'rollout_minutes',
        'agent_run_minutes',
        'continuation_minutes',
        'max_job_minutes',
        'model',
        'idempotency_key',
      )
      if ('criteria' in a) o.criteria = checks(a.criteria)
      if ('evaluations' in a) {
        o.evaluations = (a.evaluations as Args[]).map(
          (e): Evaluation => ({
            inputs: e.inputs as Evaluation['inputs'],
            ...(e.result !== undefined && { result: e.result as ExecResult }),
            ...(e.judgement !== undefined && { judgement: e.judgement as string }),
            ...(e.passed !== undefined && { passed: e.passed as boolean }),
            ...(e.note !== undefined && { note: e.note as string }),
          }),
        )
      }
      return sai.learn.create(a.turns as string[], o)
    }
    case 'learn.get':
      return sai.learn.get(a.learn_id as string)
    case 'learn.wait':
      return sai.learn.wait(a.job as string, opts(a, 'poll_ms'))
    case 'learn.cancel':
      return sai.learn.cancel(a.job as string)
    case 'learn.rollout':
      return sai.learn.rollout(a.job as string, a.iteration as number, a.rollout as number)
    case 'judge.create':
      return sai.judge.create(
        a.turns as string[],
        checks(a.criteria),
        opts(a, 'task', 'idempotency_key'),
      )
    case 'judge.get':
      return sai.judge.get(a.judgement_id as string)
    case 'control.open':
      return sai.control.open({ machine: a.machine as string })
    case 'models.list':
      return sai.models.list()
    case 'files.upload':
      return sai.files.upload({
        data: Buffer.from(a.data_base64 as string, 'base64'),
        name: a.name as string,
      })
    case 'account.get':
      return sai.account.get()
    case 'auth.check':
      return sai.auth.check()
    case 'usage.get':
      return sai.usage.get(opts(a, 'granularity', 'from', 'to', 'org_id'))
    case 'usage.sessions':
      return sai.usage.sessions(
        a.tenant as string,
        opts(a, 'from', 'to', 'limit', 'cursor', 'org_id') as { from: string; to: string },
      )
    case 'tenants.create':
      return sai.tenants.create(a.name as string, opts(a, 'external_id', 'metadata'))
    case 'tenants.list':
      return sai.tenants.list(opts(a, 'status', 'external_id', 'limit', 'cursor'))
    case 'tenants.get':
      return sai.tenants.get(a.tenant as string)
    case 'tenants.update':
      return sai.tenants.update(
        a.tenant as string,
        opts(a, 'name', 'metadata', 'status', 'cloud_machine_limit', 'residential_proxy'),
      )
    case 'tenants.delete':
      return sai.tenants.delete(a.tenant as string)
    case 'tenants.create_enrollment':
      return sai.tenants.createEnrollment(a.tenant as string)
    case 'tenants.token':
      return sai.tenants.token(a.tenant as string, opts(a, 'org_id'))
    case 'tenants.client':
      return sai.tenants.client(a.tenant as string, opts(a, 'org_id'))
    case 'tenant_machines.create':
      return sai.tenantMachines.create(
        a.tenant as string,
        opts(a, 'os', 'name', 'request_id', 'wait') as { os: 'windows' },
      )
    case 'tenant_machines.list':
      return sai.tenantMachines.list(a.tenant as string)
    case 'tenant_machines.get':
      return sai.tenantMachines.get(a.tenant as string, a.machine_id as string)
    case 'tenant_machines.delete':
      return sai.tenantMachines.delete(a.tenant as string, a.machine as string)
    case 'tenant_machines.revoke':
      return sai.tenantMachines.revoke(a.tenant as string, a.machine as string)
  }
  throw new Error(`unknown call client.${method}`)
}

async function callSession(s: Session, method: string, a: Args): Promise<unknown> {
  switch (method) {
    case 'send':
      return s.send(a.message as string, sendOpts(a))
    case 'run':
      return s.run(a.message as string, { ...sendOpts(a), ...waitOpts(a) })
    case 'abort':
      return s.abort()
    case 'respond':
      return s.respond(
        a.approval as string,
        a.response as string | undefined,
        opts(a, 'selections'),
      )
  }
  throw new Error(`unknown call Session.${method}`)
}

async function callTurn(t: Turn, method: string, a: Args): Promise<unknown> {
  switch (method) {
    case 'events': {
      const out = []
      for await (const ev of t.events(opts(a, 'raw', 'poll_wait'))) out.push(ev)
      return out
    }
    case 'wait':
      return t.wait(waitOpts(a))
    case 'respond':
      return t.respond(
        a.approval as string,
        a.response as string | undefined,
        opts(a, 'selections'),
      )
    case 'abort':
      return t.abort()
  }
  throw new Error(`unknown call Turn.${method}`)
}

async function callLease(l: ControlLease, method: string, a: Args): Promise<unknown> {
  switch (method) {
    case 'exec':
      return l.exec(a.code as string, opts(a, 'timeout_ms'))
    case 'run':
      return l.run(
        a.learned as string,
        (a.inputs ?? {}) as Record<string, string>,
        opts(a, 'timeout_ms'),
      )
    case 'shell':
      return l.shell(a.command as string, opts(a, 'cwd', 'timeout_ms'))
    case 'read_file':
      return l.readFile(a.path as string)
    case 'write_file':
      return l.writeFile(a.path as string, a.text as string)
    case 'screenshot':
      return l.screenshot()
    case 'interrupt':
      return l.interrupt()
    case 'get':
      return new Opaque(await l.get())
    case 'close':
      return l.close()
  }
  throw new Error(`unknown call ControlLease.${method}`)
}

// ─── Projection ──────────────────────────────────────────────────────────────

/** Free-form JSON from the API: passed through with its keys as they are. */
const OPAQUE = new Set([
  'output',
  'result',
  'inputs',
  'metadata',
  'variables',
  'questions',
  'run',
  'judgement',
  'byModel',
  'outputSchema',
])
/** Maps keyed by ids or names: the keys stay, the values are projected. */
const KEYED = new Set(['byTenant', 'byCategory'])

/** A call that returns free-form JSON: projected as is. */
class Opaque {
  constructor(readonly value: unknown) {}
}

function project(v: unknown): unknown {
  if (v === undefined || v === null) return null
  if (v instanceof Opaque) return v.value
  if (v instanceof Uint8Array) return { $base64: Buffer.from(v).toString('base64') }
  if (v instanceof Sai) return {}
  if (v instanceof Session) return { id: v.id, machine_id: v.machineId }
  if (v instanceof Turn) return { id: v.id, queued: v.queued, status: v.status }
  if (v instanceof ControlLease)
    return { machine_id: v.machineId, idle_timeout_sec: v.idleTimeoutSec }
  if (Array.isArray(v)) return v.map(project)
  if (typeof v === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, x] of Object.entries(v)) {
      if (k === 'raw') continue
      if (OPAQUE.has(k)) out[snake(k)] = x instanceof Uint8Array ? project(x) : (x ?? null)
      else if (KEYED.has(k))
        out[snake(k)] = Object.fromEntries(
          Object.entries(x as object).map(([key, y]) => [key, project(y)]),
        )
      else out[snake(k)] = project(x)
    }
    return out
  }
  return v
}

function projectError(err: unknown): Record<string, unknown> {
  if (!(err instanceof SaiError)) {
    return {
      class: err instanceof Error ? err.name : 'Error',
      message: String(err instanceof Error ? err.message : err),
    }
  }
  return {
    class: err.constructor.name,
    status: err.status,
    code: err.code ?? null,
    message: err.message,
    retry_after: err.retryAfter ?? null,
    body: err.body,
    ...(err instanceof LinkOnlyApprovalError && { approval_url: err.approvalUrl ?? null }),
    ...(err instanceof SpendCapReachedError && { resets_at: err.resetsAt ?? null }),
    ...(err instanceof BlockError && { kind: err.kind }),
  }
}
