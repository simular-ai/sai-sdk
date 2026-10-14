# @simular-ai/sai-sdk (TypeScript)

TypeScript SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on
a computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a
cloud computer yourself.

Status: **alpha (0.1)**. The surface may still change before 1.0. It matches the
[Python SDK](../python/README.md) method for method.

| Layer          | What it is                                    | Status           |
| -------------- | --------------------------------------------- | ---------------- |
| `sai.sessions` | A conversation with Sai on one computer       | available        |
| `sai.control`  | Drive a cloud computer directly with Simulang | research preview |
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

### Files, models, stopping

```ts
const report = await sai.files.upload('report.pdf') // or { data: bytes, name: 'report.pdf' }
await session.run('Summarise the attached report', { attachments: [report] })

const allowed = (await sai.models.list()).filter((m) => m.allowed).map((m) => m.id)
await session.run('...', { model: 'anthropic/claude-opus-5-5' }) // sticks to the session

const turn = await session.send('...')
await turn.abort()
```

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

| Option             | What it does                                                                 |
| ------------------ | ---------------------------------------------------------------------------- |
| `inputs`           | Fill `{{name}}` placeholders in the message; every placeholder needs a value |
| `outputSchema`     | JSON Schema (at most 32 KB) the output must match                            |
| `successCriteria`  | A guideline for a judge, or `{ id, check, returnEvidence? }` yes/no checks   |
| `idempotencyKey`   | The same key again returns the earlier turn and sends nothing                |
| `recordTrajectory` | Keep a screenshot and the action for each step                               |

`inputs`, `outputSchema` or `successCriteria` make the message _structured_. A structured message
behaves like any other (same session, same computer); it only adds the typed result. It is rejected with
`ConflictError` (`code === 'session_busy'`) while the session is working, because it starts a turn of
its own. A plain message sent then joins the running turn instead.

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
blocks on a cloud computer. While the lease is open, Sai's own tasks on that computer wait, so always close it.

```ts
const cs = await sai.control.open({ machine: pc })
try {
  console.log((await cs.shell('hostname')).stdout)

  const r = await cs.exec(`
    var page = await machine.browser.newtab('https://example.com')
    var snap = await page.snapshot()
    snap.title
  `)
  console.log(r.result) // Example Domain
  await writeFile('page.png', r.screenshotPng!)
} finally {
  await cs.close()
}
```

With TypeScript 5.2+ and a runtime that supports explicit resource management, `await using cs = ...`
closes it for you.

`exec()` resolves with an `ExecResult`; a block that threw still resolves, so check `r.error`
(`exception`, `timeout`, `interrupted`). Use `var`, not `let`/`const`, for values the next block needs.
`cs.screenshot()` grabs the whole screen; it needs the computer's screen-capture service, and where that is
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

const learned = await sai.learn.create([turn]) // about two minutes
console.log(
  learned.template,
  learned.parameters.map((p) => p.name),
)
console.log(learned.code) // async function main(params = { site: "..." }) { ... }

await using cs = await sai.control.open({ machine: pc })
const r = await cs.run(learned, { site: 'https://lobste.rs' }) // inputs over the defaults
console.log(r.result) // what main returned

// It broke on a new site: repair it from the run (or from feedback, or a new turn that solved it)
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

## Errors

Every non-2xx response throws a `SaiError` subclass with `status`, `code`, `message` and `retryAfter`:
`AuthenticationError` (401), `BadRequestError` (400), `PermissionDeniedError` (403), `NotFoundError`
(404), `ConflictError` (409), `LinkOnlyApprovalError` (`approvalUrl`), `GoneError` (410),
`RateLimitError` (429), `ServiceUnavailableError` (503), `ConnectionError`, `BlockError`.

A task that ran out of credit ends with `result.status === 'error'` and `result.errorCode` set to
`insufficient_credits` or `free_computer_time_exhausted`: stop retrying for today.

## Configuration

| Option      | Env           | Default                  |
| ----------- | ------------- | ------------------------ |
| `apiKey`    | `SAI_API_KEY` | required                 |
| `baseUrl`   | `SAI_API_URL` | `https://api.simular.ai` |
| `timeoutMs` |               | 60 000 per request       |
| `fetch`     |               | global `fetch`           |

## Development

```bash
cd typescript
npm install
npm test
npm run typecheck
```
