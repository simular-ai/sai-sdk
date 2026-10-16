# sai-sdk (Python)

Python SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on a
computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a cloud
computer yourself.

Status: **alpha (0.1)**. The surface may still change before 1.0.

| Layer          | What it is                                    | Status           |
| -------------- | --------------------------------------------- | ---------------- |
| `sai.sessions` | A conversation with Sai on one computer       | available        |
| `sai.control`  | Drive a cloud computer directly with Simulang | research preview |
| `sai.turns`    | A turn's record: typed output, evidence       | available        |

## Install

```bash
pip install sai-sdk          # import name: sai
export SAI_API_KEY=sapi_...  # create one at https://platform.simular.ai
```

Python 3.10+. One dependency, `httpx`.

## Give Sai a task

```python
from sai import Sai

sai = Sai()
pc = sai.machines.list()[0]

session = sai.sessions.create(machine=pc)      # a fresh conversation
result = session.run("Open Notepad, type hello, save it to the desktop as hello.txt")

print(result.status)   # idle | needs_approval | error
print(result.text)     # Sai's answer
print(result.usage)    # tokens and cost for this task
```

`machine` can be left out when the account has one computer. Further `session.run(...)` calls continue
the same conversation; `sai.sessions.create()` starts a new one with no memory of the old.

### Watch it work

```python
turn = session.send("Find last month's invoices in Downloads and total them")
for ev in turn.events():
    if ev.kind == "step":
        print("  ", ev.text)
    elif ev.kind == "approval":
        print("Sai asks:", ev.approval.title, ev.approval.command)
        turn.respond(ev.approval, "yes")       # or "no", or "task" for the rest of the task
result = turn.wait()
```

`ev.kind` is one of `step`, `message`, `approval`, `tool_error`, `error`, `finished`.
`turn.events(raw=True)` adds the wire frames (reasoning, tool calls) as `other`.

### Approvals

Sai asks before risky actions. `run()` / `wait()` return with `status == "needs_approval"` unless you pass
a handler:

```python
def decide(approval):
    if approval.is_link_only:
        print("Approve in a browser:", approval.url)   # a human answers; keep waiting
        return None
    if approval.type == "choice":
        return ("yes", [[q["options"][0]["value"]] for q in approval.questions])
    return "yes" if approval.command and "del " not in approval.command else "no"

result = session.run("Clean up the temp folder", on_approval=decide)
```

For an unattended run with nobody to answer, `autonomous=True` runs the turn without approval cards,
as if "task" (trust for the rest of the task) had been answered up front. The grant ends with the turn.
Approvals that only a person can complete in a browser (`is_link_only`) still stop the turn.

```python
session.run("Export last month's invoices to CSV", autonomous=True)
```

### Files, models, stopping

```python
report = sai.files.upload("report.pdf")
session.run("Summarise the attached report", attachments=[report])

[m.id for m in sai.models.list() if m.allowed]
session.run("...", model="anthropic/claude-opus-5-5")   # sticks to the session

turn = session.send("...")
turn.abort()
```

## Get typed results

Any message can also return structured data. Pass `output_schema` and the turn's record comes back in
`result.record`, with `output` matching the schema:

```python
session = sai.sessions.create(machine=pc)
result = session.run(
    "Open Notepad, type \"hello\" and save it on the Desktop as hello.txt. Return the saved file's path.",
    output_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
)
if result.ok:
    print(result.record.output["path"])   # C:\Users\...\Desktop\hello.txt
else:
    print(result.record.reason_code)      # e.g. output_invalid, with result.record.raw_answer
```

More options, all optional (the SDK sends them to the API as `options`):

| Argument            | What it does                                                                 |
| ------------------- | ---------------------------------------------------------------------------- |
| `inputs`            | Fill `{{name}}` placeholders in the message; every placeholder needs a value |
| `output_schema`     | JSON Schema (at most 32 KB) the output must match                            |
| `success_criteria`  | A guideline for a judge, or a list of `Check` yes/no checks                  |
| `idempotency_key`   | The same key again returns the earlier turn and sends nothing                |
| `record_trajectory` | Keep a screenshot and the action for each step                               |

`inputs`, `output_schema` or `success_criteria` make the message _structured_. A structured message
behaves like any other (same session, same computer); it only adds the typed result. It is refused with
`ConflictError` (`code == "session_busy"`) while the session is working, because it starts a turn of its
own. A plain message sent then joins the running turn instead.

```python
from sai import Check

result = session.run(
    "Save \"Invoice {{invoice_number}}: {{amount}} USD\" on the Desktop as {{file_name}}. Return its path.",
    inputs={"invoice_number": "INV-1001", "amount": "42.50", "file_name": "inv-1001.txt"},
    output_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    success_criteria=[Check("saved", "The file is saved and contains the invoice line", return_evidence=True)],
    idempotency_key="inv-1001",   # a retry returns this turn and sends nothing
    record_trajectory=True,
)
record = result.record
print(record.status)      # succeeded | failed
print(record.evidence)    # [Evidence(id="saved", passed=True, score=0.94, evidence="...")]
print(record.usage)       # tokens of the agent's model calls in this turn
```

`result.ok` is True only when the turn succeeded. On `failed`, `record.reason_code` says why
(`agent_error`, `output_invalid`, `criteria_not_met`, ...); the output is never a partial object.

**Reading a turn later.** Every message gets a turn id, `turn.id` (plain messages too):

```python
turn = session.send("...")
record = sai.turns.get(turn)                 # never waits; `finalizing` while the result is worked out
record = sai.turns.wait(turn, timeout=600)   # until succeeded, failed or needs_input
for step in sai.turns.trajectory(turn):      # needs record_trajectory=True
    print(step.index, step.title, step.code)
    if step.has_screenshot:
        open(f"step{step.index}.jpg", "wb").write(sai.turns.screenshot(turn, step.index))
```

Each takes a `Turn`, a `TurnRecord` or the id string. `record.status` is `running`, `needs_input` (an
approval is pending: answer it on `sai.sessions.resume(record.session_id)`), `finalizing`, `succeeded` or
`failed`.

## Drive a computer yourself

Direct control runs [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on a cloud computer. No agent, no model cost. While the lease is open, Sai's own tasks on that
computer wait, so always close it (a `with` block does).

```python
with sai.control.open(machine=pc) as lease:
    print(lease.shell("hostname")["stdout"])

    r = lease.exec("""
        var page = await machine.browser.newtab('https://news.ycombinator.com')
        var snap = await page.snapshot()
        snap.snapshot.grep('points')
    """)
    print(r.result)
    open("hn.png", "wb").write(r.screenshot_png)   # a page or app snapshot carries a screenshot
```

`lease.screenshot()` grabs the whole screen. It needs the computer's screen-capture service; where that is
off it raises `BlockError`, and a page or app snapshot is the way to get an image.

`exec()` returns an `ExecResult`; a block that threw is still a result, so check `r.error`
(`exception`, `timeout`, `interrupted`). Use `var`, not `let`/`const`, for values the next block needs.

## Learn code from turns (research preview)

`sai.learn` turns what the agent did into Simulang code you own, and repairs that code when it breaks.
`sai.judge` checks recorded turns against criteria you choose afterwards. The turns must be sent with
`record_trajectory=True`.

```python
from sai import Check, Evaluation

turn = session.send(
    "Open {{site}} and read the title of the top story",
    inputs={"site": "https://news.ycombinator.com"},
    record_trajectory=True,
)
sai.turns.wait(turn)

learned = sai.learn.create([turn])        # about two minutes
print(learned.template, [p.name for p in learned.parameters])
print(learned.code)                       # async function main(params = { site: "..." }) { ... }

with sai.control.open(machine=pc) as lease:
    r = lease.run(learned, {"site": "https://lobste.rs"})   # inputs over the defaults
    print(r.result)                                      # what main returned

# It broke on a new site: repair it from the run (or from feedback, or a new turn that solved it)
fixed = sai.learn.create(
    initial_code=learned.code,
    evaluations=[Evaluation(inputs={"site": "https://lobste.rs"}, result=r, passed=False)],
)
print(fixed.changes)

judgement = sai.judge.create([turn], [Check("title", "The agent reported a story title")])
print(judgement.verdict, judgement.criteria[0].score)
```

`learned.status` is `failed` when the code still has `learned.validation["errors"]` after one retry.
Pass a judgement as `Evaluation(..., judgement=judgement)` to repair code from its evidence.

## Run Sai for your customers

With an [Organisation](https://platform.simular.ai/documentation/organisations), each customer is a
Tenant. Your backend manages Tenants with an Organisation Key, and acts as one with a Tenant token.

```python
org = Sai(api_key="sapi_...", org_id="org_...")  # an Organisation Key; or SAI_API_KEY, SAI_ORG_ID

tenant = org.tenants.create("Riverside Clinic", external_id="clinic-4821")
code = org.tenants.create_enrollment(tenant)      # hand code.token to your installer
print(org.tenant_machines.list(tenant))

clinic = org.tenants.client(tenant)               # acts as the Tenant; renews its token
clinic.sessions.create().run("Open the calendar and read today's appointments")
```

- `tenants.list(status=, external_id=, limit=, cursor=)` returns one page: `page.tenants`, `page.next_cursor`.
  `external_id=` finds your customer's Tenant without storing `tenant.id`.
- `tenants.update(tenant, name=, metadata=, status="disabled" | "active")`; `tenants.delete(tenant)`
  disables it and revokes every machine.
- `tenants.token(tenant)` is the raw exchange: a one-hour `TenantToken` to pass as `Sai(api_key=token.token)`.
- `tenant_machines.get(tenant, machine_id)`, `tenant_machines.revoke(tenant, machine)`.

## Errors

Every non-2xx response raises a `SaiError` subclass with `status`, `code`, `message` and `retry_after`:

| Exception                 | When                                                          |
| ------------------------- | ------------------------------------------------------------- |
| `AuthenticationError`     | 401: the key is missing, unknown or revoked                   |
| `PermissionDeniedError`   | 403: plan or ownership (`model_not_allowed_for_plan`, ...)    |
| `BadRequestError`         | 400: e.g. several computers and no `machine=`                 |
| `ConflictError`           | 409: `machine_busy`, approval no longer pending, ...          |
| `LinkOnlyApprovalError`   | the approval must be answered in a browser: `e.approval_url`  |
| `GoneError`               | 410: the control lease ended (`e.body["reason"]`); open again |
| `SpendCapReachedError`    | 403: the key reached its monthly limit; `e.resets_at`         |
| `RateLimitError`          | 429: a rate limit, or the free plan's daily budget            |
| `ServiceUnavailableError` | 503: the computer did not come online; honor `retry_after`    |

A task that ran out of credit ends with `result.status == "error"` and `result.error_code` set to
`insufficient_credits` or `free_computer_time_exhausted`: stop retrying for today.

## Configuration

| Argument   | Env           | Default                  |
| ---------- | ------------- | ------------------------ |
| `api_key`  | `SAI_API_KEY` | required                 |
| `base_url` | `SAI_API_URL` | `https://api.simular.ai` |
| `timeout`  |               | 60 s per request         |
| `org_id`   | `SAI_ORG_ID`  | for `tenants.token()`    |

## Development

```bash
cd python
uv sync
uv run pytest
```
