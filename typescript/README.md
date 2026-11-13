# @simular-ai/sai-sdk (TypeScript)

TypeScript SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to
Sai on a computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back,
or drive a computer yourself.

Status: **alpha (0.1)**. The surface may still change before 1.0. It matches the
[Python SDK](../python/README.md) method for method.

| Layer          | What it is                                    | Status           |
| -------------- | --------------------------------------------- | ---------------- |
| `sai.sessions` | A conversation with Sai on one computer       | available        |
| `sai.control`  | Drive a computer (cloud or own) with Simulang | research preview |
| `sai.turns`    | A turn's record: typed output, evidence       | available        |

## Install

```bash
npm install @simular-ai/sai-sdk
export SAI_API_KEY=sapi_...   # create one at https://platform.simular.ai
```

Node 18.17 or later (it uses the built-in `fetch`). No runtime dependencies. ESM only.

## Give Sai a task

```ts
import { Sai } from '@simular-ai/sai-sdk'

const sai = new Sai()
const [pc] = await sai.machines.list()

const session = await sai.sessions.create({ machine: pc })
const result = await session.run('Open Notepad, type hello, save it to the desktop as hello.txt')

console.log(result.status) // idle | needs_approval | error
console.log(result.text) // Sai's answer
console.log(result.usage) // tokens and cost for this task
```

`machine` can be left out when the account has one computer. More `session.run(...)` calls continue
the same conversation; `sai.sessions.create()` starts a new one with no memory of the old.
`sai.sessions.list({ machine: pc })` lists your sessions on the computer (desktop, CLI and API), most recent first, and
`sai.auth.check()` says who the key acts as.

### Watch it work

```ts
const turn = await session.send("Find last month's invoices in Downloads and total them")
for await (const ev of turn.events()) {
  if (ev.kind === 'step') console.log('  ', ev.text)
  else if (ev.kind === 'approval') await turn.respond(ev.approval!, 'yes')
}
const result = await turn.wait()
```

`ev.kind` is one of `step`, `message`, `approval`, `tool_error`, `error`, `finished`.
`turn.events({ raw: true })` adds the wire frames (reasoning, tool calls) as `other`.

### Approvals

`run()` / `wait()` resolve with `status === 'needs_approval'` unless you pass a handler:

```ts
const result = await session.run('Clean up the temp folder', {
  onApproval: (a) => {
    if (a.isLinkOnly) {
      console.log('Approve in a browser:', a.url)
      return null // a person answers it; keep waiting
    }
    if (a.type === 'choice') return ['yes', a.questions.map((q: any) => [q.options[0].value])]
    return 'yes'
  },
})
```

For an unattended run with nobody to answer, `autonomous: true` runs the turn without approval
cards, as if `'task'` (trust for the rest of the task) had been answered up front. The grant ends
with the turn. Approvals that only a person can complete in a browser (`isLinkOnly`) still stop the
turn.

```ts
await session.run("Export last month's invoices to CSV", { autonomous: true })
```

### Files, models, stopping

```ts
const report = await sai.files.upload('report.pdf') // or { data: bytes, name: 'report.pdf' }
await session.run('Summarise the attached report', { attachments: [report] })

const allowed = (await sai.models.list()).filter((m) => m.allowed).map((m) => m.id)
await session.run('...', { model: 'anthropic/claude-opus-5-5' }) // sticks to the session

const turn = await session.send('...')
await turn.abort()
```

### Let a person take over

When Sai needs a person (a sign-in, a captcha), `machines.live` returns `liveUrl`: a page with the
computer's screen that anyone with the link can open, no Simular account needed. They can use the mouse
and keyboard while no Sai turn is running; then send a message to continue.

```ts
const view = await sai.machines.live(pc)
console.log('Sign in here, then tell me:', view.liveUrl) // valid until view.expiresAt (ms)
// ... once they are done
await session.run('I signed in. Carry on.')
await sai.machines.revokeLive(pc) // every open link stops working
```

`liveUrl` is null where the server does not offer the page. `view.websocketUrl` is the same screen as
a Guacamole tunnel for a viewer of your own; it takes input too. Both carry a token: keep them private.

## Get typed results

Any message can also return structured data. Pass `outputSchema` and the turn's record comes back in
`result.record`, with `output` matching the schema:

```ts
const session = await sai.sessions.create({ machine: pc })
const result = await session.run(
  'Open Notepad, type "hello" and save it on the Desktop as hello.txt. Return the saved file\'s path.',
  {
    outputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
  },
)
if (result.ok) console.log((result.record?.output as { path: string }).path)
else console.log(result.record?.reasonCode) // e.g. output_invalid, with result.record.rawAnswer
```

More options, all optional (the SDK sends them to the API as `options`):

| Option             | What it does                                                                                  |
| ------------------ | --------------------------------------------------------------------------------------------- |
| `inputs`           | Fill `{{name}}` placeholders in the message; every placeholder needs a value                  |
| `outputSchema`     | JSON Schema (at most 32 KB) the output must match                                             |
| `successCriteria`  | A guideline for a judge, or `{ id, check, returnEvidence? }` yes/no checks                    |
| `idempotencyKey`   | The same key again returns the earlier turn and sends nothing                                 |
| `recordTrajectory` | Keep a screenshot and the action for each step                                                |
| `thinkingLevel`    | `off`, `low`, `medium`, `high` or `xhigh` for this turn; omitted, the account setting applies |

`inputs`, `outputSchema` or `successCriteria` make the message _structured_. A structured message
behaves like any other (same session, same computer); it only adds the typed result. It is rejected with
`ConflictError` (`code === 'session_busy'`) while the session is working, because it starts a turn of
its own. A plain message sent then joins the running turn instead. `thinkingLevel` is refused the same
way, since it applies to a turn of its own.

```ts
const result = await session.run(
  'Save "Invoice {{invoice_number}}: {{amount}} USD" on the Desktop as {{file_name}}. Return its path.',
  {
    inputs: { invoice_number: 'INV-1001', amount: '42.50', file_name: 'inv-1001.txt' },
    outputSchema: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path'],
    },
    successCriteria: [
      {
        id: 'saved',
        check: 'The file is saved and contains the invoice line',
        returnEvidence: true,
      },
    ],
    idempotencyKey: 'inv-1001', // a retry returns this turn and sends nothing
    recordTrajectory: true,
  },
)
const record = result.record
console.log(record?.status) // succeeded | failed
console.log(record?.evidence) // [{ id: 'saved', passed: true, score: 0.94, evidence: '...' }]
console.log(record?.usage) // tokens of the agent's model calls in this turn
```

`result.ok` is true only when the turn succeeded. On `failed`, `record.reasonCode` says why
(`agent_error`, `output_invalid`, `criteria_not_met`, ...); the output is never a partial object.

**Reading a turn later.** Every message gets a turn id, `turn.id` (plain messages too):

```ts
const turn = await session.send('...')
let record = await sai.turns.get(turn) // never waits; `finalizing` while the result is worked out
record = await sai.turns.wait(turn, { timeoutMs: 600_000 }) // until succeeded, failed or needs_input
for (const step of await sai.turns.trajectory(turn)) {
  // needs recordTrajectory: true
  console.log(step.index, step.title, step.code)
  if (step.hasScreenshot)
    await writeFile(`step${step.index}.jpg`, await sai.turns.screenshot(turn, step.index))
}
```

Each takes a `Turn`, a `TurnRecord` or the id string. `record.status` is `running`, `needs_input` (an
approval is pending: answer it on `sai.sessions.resume(record.sessionId)`), `finalizing`, `succeeded` or
`failed`.

## Drive a computer yourself

Direct control runs [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on one of your computers, cloud or your own. While the lease is open, Sai's own tasks on that
computer wait, so always close it.

```ts
const lease = await sai.control.open({ machine: pc })
try {
  console.log((await lease.shell('hostname')).stdout)

  const r = await lease.exec(`
    var page = await machine.browser.newtab('https://example.com')
    var snap = await page.snapshot()
    snap.title
  `)
  console.log(r.result) // Example Domain
  await writeFile(`page.${r.screenshotMimeType!.split('/')[1]}`, r.screenshot!) // jpeg or png
} finally {
  await lease.close()
}
```

With TypeScript 5.2+ and a runtime that supports explicit resource management, `await using lease = ...`
closes it for you.

`exec()` resolves with an `ExecResult`; a block that threw still resolves, so check `r.error`
(`exception`, `timeout`, `interrupted`). Use `var`, not `let`/`const`, for values the next block needs.
`lease.screenshot()` grabs the whole screen; it needs the computer's screen-capture service, and where that is
off it throws `BlockError`.

## Learn code from turns (research preview)

`sai.learn` turns what the agent did into Simulang code you own, and repairs that code when it breaks.
`sai.judge` checks recorded turns against criteria you choose afterwards. The turns must be sent with
`recordTrajectory: true`.

```ts
const turn = await session.send('Open {{site}} and read the title of the top story', {
  inputs: { site: 'https://news.ycombinator.com' },
  recordTrajectory: true,
})
await sai.turns.wait(turn)

const learned = await sai.learn.create([turn]) // waits for the code; longer for a longer task
console.log(
  learned.template,
  learned.parameters.map((p) => p.name),
)
console.log(learned.code) // async function main(params = { site: "..." }) { ... }

await using lease = await sai.control.open({ machine: pc })
const r = await lease.run(learned, { site: 'https://lobste.rs' }) // inputs over the defaults
console.log(r.result) // what main returned

// It broke on a new site: repair it from the run (or from guidance, or a new turn that solved it)
const fixed = await sai.learn.create([], {
  initialCode: learned.code,
  evaluations: [{ inputs: { site: 'https://lobste.rs' }, result: r, passed: false }],
})
console.log(fixed.changes)

const judgement = await sai.judge.create(
  [turn],
  [{ id: 'title', check: 'The agent reported a story title' }],
)
console.log(judgement.verdict, judgement.criteria[0]?.score)
```

`learned.status` is `failed` when the code still has `learned.validation.errors` after one retry.
Pass a judgement as `{ ..., judgement }` in an evaluation to repair code from its evidence.

### Run, judge and repair on a machine (policy iteration)

With `maxIterations`, `learn` also runs the code on a machine, judges each run, and repairs the code
after a failed run, for up to that many versions. It starts from your `turns`, or, without them, the
agent does `taskTemplate` first. The call answers at once with a job; `wait` reads it until it ends.

```ts
const job = await sai.learn.create([], {
  taskTemplate: 'Open {{site}} and read the title of the top story',
  inputs: { site: 'https://news.ycombinator.com' },
  machine: pc,
  criteria: 'The answer is the title of the top story on the page',
  maxIterations: 3, // up to 3 code versions; 0 (the default) only writes the code
  rollouts: 3, // each version must pass 3 runs in a row
  reset: { code: 'await machine.browser.newtab("https://news.ycombinator.com")' }, // or { task: '...' }
  continueWithAgent: true, // after a failed run, the agent finishes the task and the repair learns from it
})
const done = await sai.learn.wait(job) // can take an hour; `timeoutMs` to stop waiting
console.log(done.status, done.stopReason) // did the call do its work
console.log(done.testResult) // { status: 'passed', passedRuns: 3, requiredRuns: 3, inputs }
console.log(done.code) // the latest version
for (const it of done.iterations)
  console.log(
    it.index,
    it.changes,
    it.rollouts.map((r) => r.verdict),
  )

const run = await sai.learn.rollout(job, 1, 1) // what run 1 of version 1 returned, and its judgement
await sai.learn.cancel(job) // stops at once and keeps the last complete results
```

`status` says whether the call did its work (`succeeded`, `failed` when no code was written, or
`stopped` with a `stopReason` such as `cancelled`, `time_limit` or `agent_failed`); `testResult` says
how the returned code did on `inputs`. With `judgeInitialAgentRun: true`, a job whose agent run fails
the judge stops before writing code; pass its `agentTurnId` as `turns` to start again from that run.
`agentRunEnd` says how the job's agent run ended when it gave no answer: `time_limit` (still
converted), or `needs_input` or the turn's `reason_code` such as `agent_error`, which stop the job
(`agent_failed`) before it writes code. Nobody watches a job, so it approves like a control lease:
commands and clicks go ahead, and sign-ins and choices fail at once.
The runs do the task for real, so use test inputs or a test account.

## Run Sai for your customers

With an [Organisation](https://platform.simular.ai/documentation/organisations), each customer is a
Tenant. Your backend manages Tenants with an Organisation Key, and acts as one with a Tenant token.

```ts
const org = new Sai({ apiKey: 'sapi_...', orgId: 'org_...' }) // an Organisation Key; or SAI_API_KEY, SAI_ORG_ID

const tenant = await org.tenants.create('Riverside Clinic', { externalId: 'clinic-4821' })
const code = await org.tenants.createEnrollment(tenant) // hand code.token to your installer
console.log(await org.tenantMachines.list(tenant))

const clinic = await org.tenants.client(tenant) // acts as the Tenant; renews its token
const session = await clinic.sessions.create()
await session.run("Open the calendar and read today's appointments")
```

- `tenants.list({ status, externalId, limit, cursor })` resolves with one page: `page.tenants`,
  `page.nextCursor`. `externalId` finds your customer's Tenant without storing `tenant.id`.
- `tenants.update(tenant, { name, metadata, status: 'disabled' | 'active', cloudMachineLimit, residentialProxy, ownComputerAccess })`.
  `cloudMachineLimit` is 0 to 1000, and `null` removes the cap. `tenants.get` also returns
  `cloudMachineCount`, `residentialProxy` and `ownComputerAccess`. `ownComputerAccess: true` lets the
  Tenant's learn jobs and direct control run code on its enrolled machines (off by default).
- `tenants.delete(tenant)` disables it and revokes every enrolled machine. Its cloud machines stay
  until you delete them.
- `tenants.token(tenant)` is the raw exchange: a one-hour `TenantToken` to pass as
  `new Sai({ apiKey: token.token })`.
- `tenantMachines.list(tenant)` and `tenantMachines.get(tenant, machineId)` return both kinds:
  `machine.kind` is `enrolled` or `cloud`, and `machine.state` is `online` / `offline` for an
  enrolled machine, or `provisioning`, `ready`, `starting`, `hibernated`, `deleting` or `failed` for a
  cloud one.
- A machine from `tenantMachines` or `machines.list` has `capabilities`: what stands in the way of
  driving it (`canSee`, `canUseAccessibility`, `canControl`, each null or a sentence saying what to
  fix), or null for a cloud machine and a runtime that has not reported. See
  [machine capabilities](https://platform.simular.ai/documentation/organisations/tenant-machines#machine-capabilities).
- `tenantMachines.delete(tenant, machine)` resolves with `'revoked'` for an enrolled machine and
  `'deleting'` for a cloud machine, whose disk goes with it.

### Cloud machines

Sai can host a computer for a Tenant instead of the Tenant enrolling its own:

```ts
const machine = await org.tenantMachines.create(tenant, {
  os: 'windows', // or 'linux'
  name: 'intake-desk-3',
  requestId: crypto.randomUUID(), // keep it, and send it again if you retry this create
  wait: true, // read the machine until it is ready (timeoutMs: 10 minutes)
})
const onCloud = await clinic.sessions.create({ machine: machine.id })
await onCloud.run("Open the calendar and read today's appointments")
```

Without `wait: true`, `create` resolves at once with `state: 'provisioning'`. A create can throw
`SaiError` (402 `insufficient_credits`), `SpendCapReachedError` (the Tenant's budget, `err.body.scope`),
`ConflictError` (`machine_limit_reached` with `err.body.limit` and `err.body.used`, or
`request_id_reused`), `PermissionDeniedError` (`tenant_disabled`) or `ServiceUnavailableError`
(`capacity_unavailable`: retry later). A 500 carries `err.body.errorId` to quote to support.

### What a Tenant spent

```ts
const usage = await org.usage.get({ granularity: 'month', from: '2026-10', to: '2026-10' })
console.log(usage.totals.costCents, usage.totals.byTenant)

let cursor: string | undefined
do {
  const page = await org.usage.sessions(tenant, { from: '2026-10-01', to: '2026-10-31', cursor })
  for (const s of page.sessions) console.log(s.sessionId, s.costUsd)
  cursor = page.nextCursor ?? undefined
} while (cursor)
```

`usage.get` is what the Organisation is charged, in total and per Tenant, per `hour`, `day` or `month`.
`usage.sessions` pages what each of a Tenant's sessions spent on AI calls, for UTC days `from` to `to`
(at most 93). A page can be empty and still have a `nextCursor`: keep paging until it is null.

To charge for a task as soon as it ends, look its session up in real time instead of a date range:

```ts
const page = await org.usage.sessions(tenant, { sessionIds: [session.id] })
for (const s of page.sessions) {
  if (s.settled) console.log(s.sessionId, s.costUsd, page.asOf)
}
```

With `sessionIds` (1 to 50 of the Tenant's sessions) each session comes back with its spend so far and
`settled`: `true` once its latest task has ended and every charge for it has come in. Ask again every
10 seconds or so until it is. `costUsd` and `modelCalls` are null when the session can't be read in
full right now. An id that is not one of the Tenant's sessions is left out. See
[Session spend](https://platform.simular.ai/documentation/organisations/session-spend) for the limits.

## Errors

Every non-2xx response throws a `SaiError` subclass with `status`, `code`, `message` and `retryAfter`:
`AuthenticationError` (401), `BadRequestError` (400), `PermissionDeniedError` (403), `NotFoundError`
(404), `ConflictError` (409), `LinkOnlyApprovalError` (`approvalUrl`), `GoneError` (410),
`SpendCapReachedError` (403, the key reached its monthly limit; `resetsAt`), `RateLimitError` (429),
`ServiceUnavailableError` (503), `ConnectionError`, `BlockError`.

A task that ran out of credit ends with `result.status === 'error'` and `result.errorCode` set to
`insufficient_credits` or `free_computer_time_exhausted`: stop retrying for today.

## Configuration

| Option      | Env           | Default                  |
| ----------- | ------------- | ------------------------ |
| `apiKey`    | `SAI_API_KEY` | required                 |
| `baseUrl`   | `SAI_API_URL` | `https://api.simular.ai` |
| `timeoutMs` |               | 60 000 per request       |
| `fetch`     |               | global `fetch`           |
| `orgId`     | `SAI_ORG_ID`  | for `tenants.token()`    |

## Development

```bash
cd typescript
npm install
npm test
npm run typecheck
```
