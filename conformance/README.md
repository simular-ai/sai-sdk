# Conformance suite

One set of tests for every SDK. The cases in [`cases/`](cases/) say, in JSON, which SDK calls to
make, which HTTP requests those calls must send and what the API answers, and what each call must
return or throw. [`server.mjs`](server.mjs) is a mock Sai API that holds a case's requests and
answers and checks the outcome each SDK reports, so the matching is written once, in one place.

Each SDK has a small runner in its own test suite, in its own test framework. It turns a case's
steps into calls on its SDK and reports what came back. A runner is a dispatch table and a
projection to JSON: nothing in it decides whether the SDK is right. Adding a method to
[`surface.json`](../surface.json) means adding cases here, and an entry to every runner's table.

The same server also runs the code snippets in the docs (`sai-platform`,
`src/docs/content/**.md`) against a small in-memory fake of the API: see [Docs snippets](#docs-snippets).

```bash
node conformance/server.mjs           # prints SAI_MOCK_URL=http://127.0.0.1:<port>
node conformance/selftest.mjs         # the server's own tests: matching, every case well formed
```

The runners start the server themselves (`node conformance/server.mjs`, reading the URL from its
first line of output), so each SDK's usual test command runs the suite. Node 18 or later must be
on `PATH`.

## A case

```json
{
  "id": "sessions.create.one-machine",
  "doc": "Without machine, create() uses the account's only computer.",
  "client": { "org_id": "org_1" },
  "steps": [
    {
      "call": "sessions.create",
      "args": {},
      "save": "session",
      "expect": { "result": { "id": "cs_1", "machine_id": "m_1" } }
    }
  ],
  "exchanges": [
    {
      "request": { "method": "GET", "path": "/v1/agents/machines" },
      "response": { "status": 200, "json": { "machines": [{ "machineId": "m_1" }] } }
    },
    {
      "request": {
        "method": "POST",
        "path": "/v1/agents/new-session",
        "json": { "machineId": "m_1", "channel": "api" }
      },
      "response": { "json": { "sessionId": "cs_1" } }
    }
  ]
}
```

- `client`: options for the client, in snake_case: `api_key` (default `sapi_test`), `org_id`,
  `version_tag`. `base_url` is always the mock server.
- `steps`: run in order. `call` is `<target>.<method>`; see [Calls](#calls). `save` keeps the
  returned object under a name for later steps. `expect` is `{ "result": … }` or
  `{ "error": … }`; a step without `expect` must not throw.
- `exchanges`: the HTTP requests the steps must make, in order, and the answer to each. Every
  request must match the next exchange, and every exchange must be used.

### Requests

| Key            | Matches                                                                      |
| -------------- | ---------------------------------------------------------------------------- |
| `method`       | Exactly.                                                                     |
| `path`         | Exactly, as sent (percent-encoding included).                                |
| `query`        | Every query parameter, exactly, values as strings. Unchecked when left out.  |
| `query_subset` | The listed parameters only.                                                  |
| `json`         | The JSON body, exactly: a key with a null or missing value must not be sent. |
| `json_subset`  | The listed keys of the JSON body, as for `expect` below.                     |
| `body_base64`  | The raw body bytes.                                                          |
| `body_empty`   | `true`: no body.                                                             |
| `headers`      | The listed headers (names in any case); a value may be a `$regex` marker.    |

### Responses

`status` (default 200), and one of `json`, `text` or `body_base64`, with optional `headers`.

### Expectations

`expect.result` describes what the call returned, in the [projection](#projection). Objects list
only the keys they check; arrays must match in length and order. Markers: `{ "$any": true }`,
`{ "$absent": true }` (missing or null), `{ "$regex": "…" }`, `{ "$len": n }`.

`expect.error` describes what the call threw:

```json
{ "class": "ConflictError", "status": 409, "code": "machine_busy", "message": "A task holds it" }
```

`class` is the most specific error name in `surface.json`. A runner reports a thrown error as
`{ class, status, code, message, retry_after, body }`, plus `approval_url`
(`LinkOnlyApprovalError`), `resets_at` (`SpendCapReachedError`) and `kind` (`BlockError`).

## Calls

`call` is `<target>.<method>`. The target is `client` when the first part names a resource
(`sessions.create` is `client.sessions.create`), or a name an earlier step saved
(`session.send`, `tenant_client.machines.list`). `args` are named, in snake_case; each runner
passes them the way its language does (keyword arguments, an options object, an options
struct). An argument the case leaves out is left out of the call.

| Call                         | Arguments                                                                                                                                                                          | Returns                                  |
| ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------- |
| `machines.list`              |                                                                                                                                                                                    | `[Machine]`                              |
| `machines.get`               | `machine_id`                                                                                                                                                                       | `Machine`                                |
| `machines.live`              | `machine`                                                                                                                                                                          | `LiveView`                               |
| `machines.revoke_live`       | `machine`                                                                                                                                                                          | number                                   |
| `sessions.create`            | `machine?`                                                                                                                                                                         | `Session`                                |
| `sessions.resume`            | `session_id`, `machine?`                                                                                                                                                           | `Session`                                |
| `sessions.list`              | `machine?`                                                                                                                                                                         | `[SessionSummary]`                       |
| `turns.get`                  | `turn`                                                                                                                                                                             | `TurnRecord`                             |
| `turns.wait`                 | `turn`                                                                                                                                                                             | `TurnRecord`                             |
| `turns.trajectory`           | `turn`                                                                                                                                                                             | `[TrajectoryStep]`                       |
| `turns.screenshot`           | `turn`, `index`                                                                                                                                                                    | bytes                                    |
| `learn.create`               | `turns`, and any `LearnOptions` (`task_template`, `inputs`, `initial_code`, `evaluations`, `guidance`, `history`, `max_iterations`, `rollouts`, `machine`, `criteria`, `reset`, …) | `LearnResult`                            |
| `learn.get`                  | `learn_id`                                                                                                                                                                         | `LearnResult`                            |
| `learn.wait`                 | `job`, `poll_ms?`                                                                                                                                                                  | `LearnResult`                            |
| `learn.cancel`               | `job`                                                                                                                                                                              | null                                     |
| `learn.rollout`              | `job`, `iteration`, `rollout`                                                                                                                                                      | `LearnRun`                               |
| `judge.create`               | `turns`, `criteria`, `task?`, `idempotency_key?`                                                                                                                                   | `Judgement`                              |
| `judge.get`                  | `judgement_id`                                                                                                                                                                     | `Judgement`                              |
| `control.open`               | `machine`                                                                                                                                                                          | `ControlLease`                           |
| `models.list`                |                                                                                                                                                                                    | `[Model]`                                |
| `files.upload`               | `data_base64`, `name`                                                                                                                                                              | `Attachment`                             |
| `account.get`                |                                                                                                                                                                                    | `Account`                                |
| `auth.check`                 |                                                                                                                                                                                    | `AuthInfo`                               |
| `usage.get`                  | `granularity?`, `from?`, `to?`, `org_id?`                                                                                                                                          | `OrgUsage`                               |
| `usage.sessions`             | `tenant`, `from`, `to`, `limit?`, `cursor?`, `org_id?`                                                                                                                             | `SessionSpendPage`                       |
| `tenants.create`             | `name`, `external_id?`, `metadata?`                                                                                                                                                | `Tenant`                                 |
| `tenants.list`               | `status?`, `external_id?`, `limit?`, `cursor?`                                                                                                                                     | `TenantPage`                             |
| `tenants.get`                | `tenant`                                                                                                                                                                           | `Tenant`                                 |
| `tenants.update`             | `tenant`, `name?`, `metadata?`, `status?`, `cloud_machine_limit?` (null clears it), `residential_proxy?`                                                                           | `Tenant`                                 |
| `tenants.delete`             | `tenant`                                                                                                                                                                           | null                                     |
| `tenants.create_enrollment`  | `tenant`                                                                                                                                                                           | `Enrollment`                             |
| `tenants.token`              | `tenant`, `org_id?`                                                                                                                                                                | `TenantToken`                            |
| `tenants.client`             | `tenant`, `org_id?`                                                                                                                                                                | a client (projects to `{}`)              |
| `tenant_machines.create`     | `tenant`, `os`, `name?`, `request_id?`, `wait?`                                                                                                                                    | `TenantMachine`                          |
| `tenant_machines.list`       | `tenant`                                                                                                                                                                           | `[TenantMachine]`                        |
| `tenant_machines.get`        | `tenant`, `machine_id`                                                                                                                                                             | `TenantMachine`                          |
| `tenant_machines.delete`     | `tenant`, `machine`                                                                                                                                                                | `"revoked"` or `"deleting"`              |
| `tenant_machines.revoke`     | `tenant`, `machine`                                                                                                                                                                | null                                     |
| `Session.send`               | `message`, `model?`, `attachments?`, `inputs?`, `output_schema?`, `success_criteria?`, `idempotency_key?`, `record_trajectory?`, `thinking_level?`, `autonomous?`                  | `Turn`                                   |
| `Session.run`                | as `send`, plus `on_approval?`, `poll_wait?`                                                                                                                                       | `TurnResult`                             |
| `Session.abort`              |                                                                                                                                                                                    | boolean                                  |
| `Session.respond`            | `approval`, `response?`, `selections?`                                                                                                                                             | string                                   |
| `Turn.events`                | `raw?`, `poll_wait?`                                                                                                                                                               | `[Event]`, every one it yielded          |
| `Turn.wait`                  | `on_approval?`, `poll_wait?`                                                                                                                                                       | `TurnResult`                             |
| `Turn.respond`, `Turn.abort` | as on `Session`                                                                                                                                                                    |                                          |
| `ControlLease.exec`          | `code`, `timeout_ms?`                                                                                                                                                              | `ExecResult`                             |
| `ControlLease.run`           | `learned` (code, or a saved `LearnResult`), `inputs?`, `timeout_ms?`                                                                                                               | `ExecResult`                             |
| `ControlLease.shell`         | `command`, `cwd?`, `timeout_ms?`                                                                                                                                                   | `{stdout, stderr, exit_code, timed_out}` |
| `ControlLease.read_file`     | `path`                                                                                                                                                                             | string                                   |
| `ControlLease.write_file`    | `path`, `text`                                                                                                                                                                     | null                                     |
| `ControlLease.screenshot`    |                                                                                                                                                                                    | bytes                                    |
| `ControlLease.interrupt`     |                                                                                                                                                                                    | boolean                                  |
| `ControlLease.get`           |                                                                                                                                                                                    | object                                   |
| `ControlLease.close`         |                                                                                                                                                                                    | null                                     |

A `Session` target is a saved session; `Turn` a saved turn; `ControlLease` a saved lease.

### Argument values

- `machine`, `tenant`, `turn`, `job`, `approval`, `learned`, and the items of `turns` and
  `attachments`: an id string, or `{ "$ref": "<saved name>" }` for an object an earlier step
  saved. A step can save part of its result with `"pick"`: `"save": "approval", "pick": "approval"`
  saves `result.approval`; `"pick": "0"` saves the first item of a list. A pick is a dotted
  path of snake_case field names and list indexes.
- `on_approval`: `{ "answers": [ … ] }`, a handler that returns the answers in order, one per
  approval: a response string, `[response, selections]`, or null to leave it pending.
- `criteria`, `success_criteria`: a string, or a list of checks `{ "id", "check", "return_evidence"? }`.
- `evaluations`: a list of `{ "inputs", "result"?, "judgement"?, "passed"?, "note"? }`, where
  `result` is a `$ref` to a saved `ExecResult`.
- `inputs`, `metadata`, `output_schema`, `reset`: plain JSON, passed as the language's map type.

## Projection

What a call returns is turned into JSON for `expect.result`:

- Field names in snake_case, as in `surface.json` and the Python SDK. The `raw` field is left out.
- Computed properties are included: `ok` on `TurnResult`, `TurnRecord` and `ExecResult`, `done`
  on `TurnRecord`.
- `Session` is `{ id, machine_id }`, `Turn` is `{ id, queued, status }`, `ControlLease` is
  `{ machine_id, idle_timeout_sec }`, a client is `{}`.
- Bytes are `{ "$base64": "…" }`. Nothing (void, None, nil) is null.
- Free-form JSON from the API (`output`, an exec `result`, `inputs`, `metadata`) is passed through
  unchanged: its keys are not converted.

## Docs snippets

The docs (`simular-ai/sai-platform`, `src/docs/content/**.md`) show every SDK's code side by side.
Each SDK's snippet test runs every block of its language as a program against the fake API, with
`SAI_API_KEY`, `SAI_ORG_KEY`, `SAI_API_URL` and `SAI_ORG_ID` set and a copy of
[`fixtures/`](fixtures/) as the working directory, and fails if one does not compile or exits
non-zero.

The blocks are committed here, in [`snippets/<lang>.json`](snippets/), so the tests and CI read
only this repo. Refresh them when the docs change, and commit the result:

```bash
node conformance/snippets.mjs sync                       # clones sai-platform main (your git credentials)
node conformance/snippets.mjs sync --ref <docs-branch>   # the docs branch of a change in progress
node conformance/snippets.mjs sync --docs ../sai-platform/src/docs/content
```

`sync` writes a snapshot for each SDK in this checkout, with the docs commit it read in `source`.
`node conformance/snippets.mjs --lang go` prints one language's snapshot, which is what the
runners read; with `--docs <dir>` or `SAI_DOCS_DIR` it reads live docs instead, for checking a docs
edit before syncing.

Each entry is `{ "file", "line", "title", "context", "code" }`. A block after
`<!-- snippet: skip -->` on its own line is left out (a fragment that cannot run, such as a type
signature).

A block that imports something starts a program: its imports, a client, and the calls. A block that
imports nothing continues the last block before it on its page that did, which `context` holds. On
an SDK page (`sdks/<language>.md`), every block after the first gets the page's first block as its
context. A test puts the context first and the block after it, in a scope of its own where the
language has one, with the imports of both at the top and de-duplicated. In a language that cannot
shadow a local (Java, C#), a block must not redeclare its context's names.
