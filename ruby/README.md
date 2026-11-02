# sai-sdk (Ruby)

Ruby SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on a
computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a
cloud computer yourself.

Status: **alpha (0.1), unreleased**. The surface may still change before 1.0. It matches the
[Python SDK](../python/README.md) and the [TypeScript SDK](../typescript/README.md) method for method.

| Layer          | What it is                                    | Status           |
| -------------- | --------------------------------------------- | ---------------- |
| `sai.sessions` | A conversation with Sai on one computer       | available        |
| `sai.control`  | Drive a cloud computer directly with Simulang | research preview |
| `sai.turns`    | A turn's record: typed output, evidence       | available        |

## Install

```bash
gem install sai-sdk          # or: gem "sai-sdk" in your Gemfile
export SAI_API_KEY=sapi_...  # create one at https://platform.simular.ai
```

Ruby 3.1 or later. No runtime dependencies beyond the standard library (`net/http`, `json`).

## Give Sai a task

```ruby
require "sai"

sai = Sai::Client.new
pc = sai.machines.list.first

session = sai.sessions.create(machine: pc)
result = session.run("Open Notepad, type hello, save it to the desktop as hello.txt")

puts result.status # idle | needs_approval | error
puts result.text   # Sai's answer
p result.usage     # tokens and cost for this task
```

`machine:` can be left out when the account has one computer. More `session.run(...)` calls continue
the same conversation; `sai.sessions.create` starts a new one with no memory of the old.
`sai.sessions.list(machine: pc)` lists the computer's API sessions, most recent first, and
`sai.auth.check` says who the key acts as.

### Watch it work

```ruby
turn = session.send("Find last month's invoices in Downloads and total them")
turn.events do |ev|
  case ev.kind
  when "step" then puts "   #{ev.text}"
  when "approval" then turn.respond(ev.approval, "yes")
  end
end
result = turn.wait
```

`ev.kind` is one of `step`, `message`, `approval`, `tool_error`, `error`, `finished`.
`turn.events(raw: true)` adds the wire frames (reasoning, tool calls) as `other`. Without a block,
`events` returns an `Enumerator`. `Session#send` is the API call, as in the other SDKs; Ruby's own
`send` is still there as `__send__` and `public_send`.

### Approvals

`run` / `wait` return with `status == "needs_approval"` unless you pass a handler, as a block or as
`on_approval:` (anything that responds to `call`):

```ruby
result = session.run("Clean up the temp folder") do |approval|
  if approval.link_only?
    puts "Approve in a browser: #{approval.url}"
    next nil # a person answers it; keep waiting
  end
  next ["yes", approval.questions.map { |q| [q["options"][0]["value"]] }] if approval.type == "choice"

  "yes"
end
```

The handler returns `"yes"`, `"no"`, `"task"`, a `[response, selections]` pair for a choice, or
`nil` to leave the approval pending. For an unattended run, `autonomous: true` runs the turn without
approval cards, as if `"task"` had been answered up front; link-only approvals still stop it.

### Files, models, stopping

```ruby
report = sai.files.upload("report.pdf") # or data: bytes, name: "report.pdf"
session.run("Summarise the attached report", attachments: [report])

allowed = sai.models.list.select(&:allowed).map(&:id)
session.run("...", model: "anthropic/claude-opus-5-5") # sticks to the session

turn = session.send("...")
turn.abort
```

### Let a person take over

```ruby
view = sai.machines.live(pc)
puts "Sign in here, then tell me: #{view.live_url}" # valid until view.expires_at (ms)
# ... once they are done
session.run("I signed in. Carry on.")
sai.machines.revoke_live(pc) # every open link stops working
```

## Get typed results

```ruby
result = session.run(
  "Save \"Invoice {{invoice_number}}: {{amount}} USD\" on the Desktop as {{file_name}}. Return its path.",
  inputs: { "invoice_number" => "INV-1001", "amount" => "42.50", "file_name" => "inv-1001.txt" },
  output_schema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  success_criteria: [
    Sai::Check.new(id: "saved", check: "The file is saved and contains the invoice line", return_evidence: true)
  ],
  idempotency_key: "inv-1001", # a retry returns this turn and sends nothing
  record_trajectory: true
)
if result.ok?
  puts result.record.output["path"]
else
  puts result.record.reason_code # e.g. output_invalid, with result.record.raw_answer
end
```

`inputs`, `output_schema` or `success_criteria` make the message _structured_; it is rejected with
`Sai::ConflictError` (`code == "session_busy"`) while the session is working. `thinking_level:`
(`off`, `low`, `medium`, `high`, `xhigh`) is refused the same way.

**Reading a turn later.** Every message gets a turn id, `turn.id`:

```ruby
record = sai.turns.get(turn)               # never waits
record = sai.turns.wait(turn, timeout: 600) # until succeeded, failed or needs_input
sai.turns.trajectory(turn).each do |step|   # needs record_trajectory: true
  File.binwrite("step#{step.index}.jpg", sai.turns.screenshot(turn, step.index)) if step.has_screenshot
end
```

## Drive a computer yourself

Direct control runs [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on a cloud computer. With a block, `open` closes the lease when the block ends; while it is
open, Sai's own tasks on that computer wait.

```ruby
sai.control.open(machine: pc) do |lease|
  puts lease.shell("hostname").stdout

  r = lease.exec(<<~JS)
    var page = await machine.browser.newtab('https://example.com')
    var snap = await page.snapshot()
    snap.title
  JS
  p r.result # Example Domain
  File.binwrite("page.#{r.screenshot_mime_type.split('/')[1]}", r.screenshot)
end
```

A block that threw still returns an `ExecResult`, so check `r.error` (`exception`, `timeout`,
`interrupted`). Bytes (screenshots) are binary `String`s.

## Learn code from turns (research preview)

```ruby
learned = sai.learn.create([turn]) # turns sent with record_trajectory: true
r = sai.control.open(machine: pc) { |lease| lease.run(learned, { "site" => "https://lobste.rs" }) }

fixed = sai.learn.create(
  initial_code: learned.code,
  evaluations: [Sai::Evaluation.new(inputs: { "site" => "https://lobste.rs" }, result: r, passed: false)]
)
judgement = sai.judge.create([turn], [Sai::Check.new(id: "title", check: "The agent reported a story title")])

job = sai.learn.create(task_template: "Open {{site}} and read the title of the top story",
                       inputs: { "site" => "https://news.ycombinator.com" }, machine: pc, max_iterations: 3)
done = sai.learn.wait(job) # timeout: to stop waiting
run = sai.learn.rollout(job, 1, 1)
```

## Run Sai for your customers

```ruby
org = Sai::Client.new(api_key: "sapi_...", org_id: "org_...") # or SAI_API_KEY, SAI_ORG_ID

tenant = org.tenants.create("Riverside Clinic", external_id: "clinic-4821")
code = org.tenants.create_enrollment(tenant) # hand code.token to your installer

machine = org.tenant_machines.create(tenant, os: "windows", request_id: SecureRandom.uuid, wait: true)
clinic = org.tenants.client(tenant) # acts as the Tenant; renews its token
clinic.sessions.create(machine: machine.id).run("Open the calendar and read today's appointments")

org.tenants.update(tenant, cloud_machine_limit: nil) # nil removes the cap; leaving it out changes nothing
usage = org.usage.get(granularity: "month", from: "2026-10", to: "2026-10")
page = org.usage.sessions(tenant, from: "2026-10-01", to: "2026-10-31")
```

## Errors

Every non-2xx response raises a `Sai::Error` subclass with `status`, `code`, `message`, `body` and
`retry_after`: `AuthenticationError` (401), `BadRequestError` (400), `PermissionDeniedError` (403),
`NotFoundError` (404), `ConflictError` (409), `LinkOnlyApprovalError` (`approval_url`), `GoneError`
(410), `SpendCapReachedError` (403; `resets_at`), `RateLimitError` (429), `ServiceUnavailableError`
(503), `ConnectionError`, `BlockError`. A wait past its `timeout:` raises `Timeout::Error`.

A task that ran out of credit ends with `result.status == "error"` and `result.error_code` set to
`insufficient_credits` or `free_computer_time_exhausted`: stop retrying for today.

## Configuration

| Keyword        | Env           | Default                  |
| -------------- | ------------- | ------------------------ |
| `api_key:`     | `SAI_API_KEY` | required                 |
| `base_url:`    | `SAI_API_URL` | `https://api.simular.ai` |
| `timeout:`     |               | 60 seconds per request   |
| `version_tag:` |               | none                     |
| `org_id:`      | `SAI_ORG_ID`  | for `tenants.token`      |

## Development

```bash
cd ruby
bundle install
bundle exec rake test   # parity, conformance cases, docs snippets (SAI_DOCS_DIR)
gem build sai-sdk.gemspec
```
