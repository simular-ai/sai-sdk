# sai-sdk (Python)

Python SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on a
computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a cloud
computer yourself.

Status: **alpha (0.1)**. The surface may still change before 1.0.

| Layer                  | What it is                                    | Status           |
| ---------------------- | --------------------------------------------- | ---------------- |
| `sai.sessions`         | A conversation with Sai on one computer       | available        |
| `sai.control_sessions` | Drive a cloud computer directly with Simulang | research preview |
| `sai.runs`             | Typed tasks: inputs, output schema, evidence  | preview          |

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

### Files, models, stopping

```python
report = sai.files.upload("report.pdf")
session.run("Summarise the attached report", attachments=[report])

[m.id for m in sai.models.list() if m.allowed]
session.run("...", model="anthropic/claude-opus-5-5")   # sticks to the session

turn = session.send("...")
turn.abort()
```

## Get typed results (runs)

Every message is a run. Add a contract and it becomes a structured run: `message` is a template filled
from `inputs`, the answer must match `output_schema`, and the turn is checked against `success_criteria`.
`wait()` / `run()` then return the run's result in `result.run`.

```python
from sai import Check

turn = sai.runs.create(
    "Open Notepad, type \"Invoice {{invoice_number}}: {{amount}} USD\" and save it on the Desktop "
    "as {{file_name}}. Return the full path of the saved file.",
    machine=pc,
    inputs={"invoice_number": "INV-1001", "amount": "42.50", "file_name": "inv-1001.txt"},
    output_schema={"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
    success_criteria=[Check("saved", "The file is saved and contains the invoice line", return_evidence=True)],
    idempotency_key="inv-1001",          # a retry returns this run and sends nothing
    record_trajectory=True,              # a screenshot and the action for each step
)
result = turn.wait()
run = result.run
print(run.status)       # succeeded | failed
print(run.output)       # {"path": "C:\\Users\\...\\inv-1001.txt"}, matches output_schema
print(run.reason_code)  # on failed: agent_error | output_invalid | criteria_not_met | ...
print(run.evidence)     # [Evidence(id="saved", passed=True, score=0.94, evidence="...")]
print(run.usage)        # tokens of the agent's model calls in this turn
```

`result.ok` is True only when the run succeeded. On `output_invalid`, `run.raw_answer` and
`run.output_errors` say what came back instead; the output is never a partial object.

**Where a run goes.** `sai.runs.create()` sends the message without a session: a structured run opens a
session of its own, so its result does not depend on earlier conversations, and gives the computer back
when its turn ends (`keep_lock_at_turn_end=True` keeps it). `turn.session` continues that session.
`session.send()` / `session.run()` with the same fields run in that session instead, and see its history:

```python
day = sai.sessions.create(machine=pc)
day.run("Sign in to the Delta Dental provider portal")                       # plain
eobs = day.run("Download the EOBs posted since {{since}}", inputs={"since": "2026-10-01"},
               output_schema=EOB_SCHEMA).run.output                           # structured, same session
for claim in eobs["claims"]:                                                  # one new session per claim
    turn = sai.runs.create("Compare claim {{claimNumber}} with the ledger", machine=pc,
                           inputs={"claimNumber": claim["claimNumber"]}, output_schema=MATCH_SCHEMA,
                           idempotency_key=f"check-{claim['claimNumber']}")
    check = turn.wait().run
    if check.ok and not check.output["match"]:
        print(turn.session.run("Why did the paid amount differ?").text)        # follow-up, same session
```

A structured run sent while the session is working is refused with `ConflictError` (`code ==
"session_busy"`); send it again when the turn is over. A plain message joins the running turn instead.

**Reading runs later.** `turn.run_id` names the run (plain messages have one too):

```python
run = sai.runs.get(run_id)                 # never waits; `finalizing` while the result is worked out
run = sai.runs.wait(run_id, timeout=600)   # until succeeded, failed or needs_input
for step in sai.runs.trajectory(run_id):   # needs record_trajectory=True
    print(step.index, step.title, step.code)
    if step.has_screenshot:
        open(f"step{step.index}.jpg", "wb").write(sai.runs.screenshot(run_id, step.index))
```

`run.status` is `running`, `needs_input` (an approval is pending: answer it on
`sai.sessions.resume(run.session_id)`), `finalizing`, `succeeded` or `failed`.

## Drive a computer yourself

Control sessions run [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on a cloud computer. No agent, no model cost. While one is open, Sai's own tasks on that
computer wait, so always close it (a `with` block does).

```python
with sai.control_sessions.open(machine=pc) as cs:
    print(cs.shell("hostname")["stdout"])

    r = cs.exec("""
        var page = await machine.browser.newtab('https://news.ycombinator.com')
        var snap = await page.snapshot()
        snap.snapshot.grep('points')
    """)
    print(r.result)
    open("hn.png", "wb").write(r.screenshot_png)   # a page or app snapshot carries a screenshot
```

`cs.screenshot()` grabs the whole screen. It needs the computer's screen-capture service; where that is
off it raises `BlockError`, and a page or app snapshot is the way to get an image.

`exec()` returns an `ExecResult`; a block that threw is still a result, so check `r.error`
(`exception`, `timeout`, `interrupted`). Use `var`, not `let`/`const`, for values the next block needs.

## Errors

Every non-2xx response raises a `SaiError` subclass with `status`, `code`, `message` and `retry_after`:

| Exception                 | When                                                                 |
| ------------------------- | -------------------------------------------------------------------- |
| `AuthenticationError`     | 401: the key is missing, unknown or revoked                          |
| `PermissionDeniedError`   | 403: plan or ownership (`model_not_allowed_for_plan`, ...)           |
| `BadRequestError`         | 400: several computers and no `machine=`, `invalid_template`, ...    |
| `ConflictError`           | 409: `machine_busy`, `session_busy`, approval no longer pending, ... |
| `LinkOnlyApprovalError`   | the approval must be answered in a browser: `e.approval_url`         |
| `GoneError`               | 410: the control session lost its computer; open a new one           |
| `RateLimitError`          | 429: a rate limit, or the free plan's daily budget                   |
| `ServiceUnavailableError` | 503: the computer did not come online; honor `retry_after`           |

A task that ran out of credit ends with `result.status == "error"` and `result.error_code` set to
`insufficient_credits` or `free_computer_time_exhausted`: stop retrying for today.

## Configuration

| Argument   | Env           | Default                  |
| ---------- | ------------- | ------------------------ |
| `api_key`  | `SAI_API_KEY` | required                 |
| `base_url` | `SAI_API_URL` | `https://api.simular.ai` |
| `timeout`  |               | 60 s per request         |

## Development

```bash
cd python
uv sync
uv run pytest
```
