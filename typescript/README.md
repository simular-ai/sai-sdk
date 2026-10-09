# @simular-ai/sai-sdk (TypeScript)

TypeScript SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on
a computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a
cloud computer yourself.

Status: **alpha (0.1)**. The surface may still change before 1.0. It matches the
[Python SDK](../python/README.md) method for method.

| Layer                 | What it is                                    | Status           |
| --------------------- | --------------------------------------------- | ---------------- |
| `sai.sessions`        | A conversation with Sai on one computer       | available        |
| `sai.controlSessions` | Drive a cloud computer directly with Simulang | research preview |
| `sai.runs`            | Typed tasks: inputs, output schema, evidence  | not yet          |

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

## Drive a computer yourself

Control sessions run [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on a cloud computer. While one is open, Sai's own tasks on that computer wait, so always close it.

```ts
const cs = await sai.controlSessions.open({ machine: pc })
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
