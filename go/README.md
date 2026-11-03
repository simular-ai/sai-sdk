# github.com/simular-ai/sai-sdk/go (Go)

Go SDK for the [Sai API](https://platform.simular.ai/documentation). Hand desktop work to Sai on a
computer (a Sai cloud computer, or your own PC with the Sai app) and get the answer back, or drive a
cloud computer yourself.

Status: **unreleased (0.1)**. The surface may still change before 1.0. It matches the
[Python SDK](../python/README.md) and the [TypeScript SDK](../typescript/README.md) method for method.

| Layer             | What it is                                    | Status           |
| ----------------- | --------------------------------------------- | ---------------- |
| `client.Sessions` | A conversation with Sai on one computer       | available        |
| `client.Control`  | Drive a cloud computer directly with Simulang | research preview |
| `client.Turns`    | A turn's record: typed output, evidence       | available        |

## Install

```bash
go get github.com/simular-ai/sai-sdk/go
export SAI_API_KEY=sapi_...   # create one at https://platform.simular.ai
```

Go 1.23 or later. Standard library only. The package is `sai`; import it as
`sai "github.com/simular-ai/sai-sdk/go"`. Every call that goes over the network takes a
`context.Context` first; options come in a struct you may pass as `nil`.

## Give Sai a task

```go
ctx := context.Background()
client, err := sai.New(sai.Options{}) // SAI_API_KEY, and SAI_API_URL if set
if err != nil {
	log.Fatal(err)
}
machines, err := client.Machines.List(ctx)
if err != nil {
	log.Fatal(err)
}
pc := machines[0]

session, err := client.Sessions.Create(ctx, &sai.SessionOptions{Machine: pc.ID})
if err != nil {
	log.Fatal(err)
}
result, err := session.Run(ctx, "Open Notepad, type hello, save it to the desktop as hello.txt", nil)
if err != nil {
	log.Fatal(err)
}
fmt.Println(result.Status) // idle | needs_approval | error
fmt.Println(result.Text)   // Sai's answer
fmt.Println(result.Usage)  // tokens and cost for this task
```

`Machine` can be left out when the account has one computer. More `session.Run(...)` calls continue
the same conversation; `client.Sessions.Create(ctx, nil)` starts a new one with no memory of the old.
`client.Sessions.List(ctx, &sai.SessionOptions{Machine: pc.ID})` lists your sessions on the computer
(desktop, CLI and API), most recent first, and `client.Auth.Check(ctx)` says who the key acts as.

### Watch it work

```go
turn, err := session.Send(ctx, "Find last month's invoices in Downloads and total them", nil)
if err != nil {
	log.Fatal(err)
}
for ev, err := range turn.Events(ctx, nil) {
	if err != nil {
		log.Fatal(err)
	}
	switch ev.Kind {
	case sai.EventStep:
		fmt.Println("  ", ev.Text)
	case sai.EventApproval:
		turn.Respond(ctx, ev.Approval, "yes", nil)
	}
}
result, err := turn.Wait(ctx, nil)
```

`ev.Kind` is one of `step`, `message`, `approval`, `tool_error`, `error`, `finished`
(`sai.EventStep`, ...). `&sai.EventsOptions{Raw: true}` adds the wire frames (reasoning, tool calls)
as `other`.

### Approvals

`Run()` / `Wait()` return with `Status` `needs_approval` unless you pass a handler:

```go
result, err := session.Run(ctx, "Clean up the temp folder", &sai.RunOptions{
	OnApproval: func(a *sai.Approval) *sai.ApprovalAnswer {
		if a.IsLinkOnly {
			fmt.Println("Approve in a browser:", a.URL)
			return nil // a person answers it; keep waiting
		}
		return &sai.ApprovalAnswer{Response: "yes"} // or "no", "task"; Selections for a choice
	},
})
```

For an unattended run with nobody to answer, `Autonomous: true` runs the turn without approval
cards, as if `"task"` (trust for the rest of the task) had been answered up front. The grant ends
with the turn. Approvals that only a person can complete in a browser (`IsLinkOnly`) still stop the
turn.

### Files, models, stopping

```go
f, _ := os.Open("report.pdf")
report, err := client.Files.Upload(ctx, "report.pdf", f) // any io.Reader, with the file's name
_, err = session.Run(ctx, "Summarise the attached report", &sai.RunOptions{Attachments: []*sai.Attachment{report}})

models, err := client.Models.List(ctx) // each has Allowed for this plan
_, err = session.Run(ctx, "...", &sai.RunOptions{Model: "anthropic/claude-opus-5-5"}) // sticks to the session

turn, err := session.Send(ctx, "...", nil)
_, err = turn.Abort(ctx)
```

### Let a person take over

When Sai needs a person (a sign-in, a captcha), `Machines.Live` returns `LiveURL`: a page with the
computer's screen that anyone with the link can open, no Simular account needed. They can use the
mouse and keyboard while no Sai turn is running; then send a message to continue.

```go
view, err := client.Machines.Live(ctx, pc.ID)
fmt.Println("Sign in here, then tell me:", view.LiveURL) // valid until view.ExpiresAt (ms)
// ... once they are done
_, err = session.Run(ctx, "I signed in. Carry on.", nil)
_, err = client.Machines.RevokeLive(ctx, pc.ID) // every open link stops working
```

`LiveURL` is empty where the server does not offer the page. `view.WebsocketURL` is the same screen
as a Guacamole tunnel for a viewer of your own; it takes input too. Both carry a token: keep them
private.

## Get typed results

Any message can also return structured data. Set `OutputSchema` and the turn's record comes back in
`result.Record`, with `Output` matching the schema:

```go
result, err := session.Run(ctx, "Open Notepad, type \"hello\" and save it on the Desktop as hello.txt. Return the saved file's path.", &sai.RunOptions{
	OutputSchema: map[string]any{
		"type":       "object",
		"properties": map[string]any{"path": map[string]any{"type": "string"}},
		"required":   []string{"path"},
	},
})
if result.OK {
	fmt.Println(result.Record.Output.(map[string]any)["path"])
} else if result.Record != nil {
	fmt.Println(result.Record.ReasonCode) // e.g. output_invalid, with result.Record.RawAnswer
}
```

More options, all optional (the SDK sends them to the API as `options`):

| Option             | What it does                                                                                           |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| `Inputs`           | Fill `{{name}}` placeholders in the message; every placeholder needs a value                           |
| `OutputSchema`     | JSON Schema (at most 32 KB) the output must match                                                      |
| `SuccessCriteria`  | `sai.CriteriaText`, a guideline for a judge, or `sai.Checks`, yes/no checks                            |
| `IdempotencyKey`   | The same key again returns the earlier turn and sends nothing                                          |
| `RecordTrajectory` | Keep a screenshot and the action for each step                                                         |
| `ThinkingLevel`    | `sai.ThinkingOff` ... `sai.ThinkingXHigh` for this turn; empty, the account setting applies            |

`Inputs`, `OutputSchema` or `SuccessCriteria` make the message _structured_. It is rejected with a
`*sai.ConflictError` (`Code == "session_busy"`) while the session is working, because it starts a
turn of its own. A plain message sent then joins the running turn instead.

**Reading a turn later.** Every message gets a turn id, `turn.ID` (plain messages too):

```go
record, err := client.Turns.Get(ctx, turn.ID)  // never waits; `finalizing` while the result is worked out
record, err = client.Turns.Wait(ctx, turn.ID)  // until succeeded, failed or needs_input
steps, err := client.Turns.Trajectory(ctx, turn.ID) // needs RecordTrajectory
for _, step := range steps {
	if step.HasScreenshot {
		jpeg, _ := client.Turns.Screenshot(ctx, turn.ID, step.Index)
		os.WriteFile(fmt.Sprintf("step%d.jpg", step.Index), jpeg, 0o644)
	}
}
```

A context deadline bounds every wait.

## Drive a computer yourself

Direct control runs [Simulang](https://platform.simular.ai/documentation/concepts/direct-control)
blocks on a cloud computer. While the lease is open, Sai's own tasks on that computer wait, so always
close it.

```go
lease, err := client.Control.Open(ctx, pc.ID)
if err != nil {
	log.Fatal(err)
}
defer lease.Close(ctx)

out, err := lease.Shell(ctx, "hostname", nil)
fmt.Println(out.Stdout)

r, err := lease.Exec(ctx, `
	var page = await machine.browser.newtab('https://example.com')
	var snap = await page.snapshot()
	snap.title
`, nil)
fmt.Println(r.Result) // Example Domain
os.WriteFile("page.jpg", r.Screenshot, 0o644) // r.ScreenshotMimeType: image/jpeg or image/png
```

`Exec()` returns an `*sai.ExecResult`; a block that threw still returns a result, so check `r.Error`
(`exception`, `timeout`, `interrupted`). Use `var`, not `let`/`const`, for values the next block
needs. `lease.Screenshot(ctx)` grabs the whole screen; it needs the computer's screen-capture
service, and where that is off it returns a `*sai.BlockError`.

## Learn code from turns (research preview)

`client.Learn` turns what the agent did into Simulang code you own, and repairs that code when it
breaks. `client.Judge` checks recorded turns against criteria you choose afterwards. The turns must
be sent with `RecordTrajectory: true`.

```go
learned, err := client.Learn.Create(ctx, []string{turn.ID}, nil) // waits for the code
fmt.Println(learned.Template, learned.Code)

r, err := lease.Run(ctx, learned, map[string]any{"site": "https://lobste.rs"}, nil) // inputs over the defaults

// It broke on a new site: repair it from the run (or from Guidance, or a new turn that solved it)
fixed, err := client.Learn.Create(ctx, nil, &sai.LearnOptions{
	InitialCode: learned.Code,
	Evaluations: []sai.Evaluation{{Inputs: map[string]any{"site": "https://lobste.rs"}, Result: r, Passed: sai.Ptr(false)}},
})

judgement, err := client.Judge.Create(ctx, []string{turn.ID},
	sai.Checks{{ID: "title", Check: "The agent reported a story title"}}, nil)
fmt.Println(judgement.Verdict)
```

With `MaxIterations`, `Learn` also runs the code on a machine, judges each run, and repairs the code
after a failed run, for up to that many versions. The call returns at once with a job;
`client.Learn.Wait(ctx, job.ID, nil)` reads it until it ends, `client.Learn.Rollout(ctx, job.ID, 1, 1)`
returns one run, and `client.Learn.Cancel(ctx, job.ID)` stops it.

## Run Sai for your customers

With an [Organisation](https://platform.simular.ai/documentation/organisations), each customer is a
Tenant. Your backend manages Tenants with an Organisation Key, and acts as one with a Tenant token.

```go
org, err := sai.New(sai.Options{APIKey: "sapi_...", OrgID: "org_..."}) // or SAI_API_KEY, SAI_ORG_ID

tenant, err := org.Tenants.Create(ctx, "Riverside Clinic", &sai.TenantCreateOptions{ExternalID: "clinic-4821"})
code, err := org.Tenants.CreateEnrollment(ctx, tenant.ID) // hand code.Token to your installer

clinic, err := org.Tenants.Client(ctx, tenant.ID, nil) // acts as the Tenant; renews its token
session, err := clinic.Sessions.Create(ctx, nil)

machine, err := org.TenantMachines.Create(ctx, tenant.ID, &sai.TenantMachineCreateOptions{
	OS: "windows", Name: "intake-desk-3", RequestID: "intake-desk-3", Wait: true,
})
```

- `Tenants.List`, `Get`, `Update` (`ClearCloudMachineLimit: true` sends a null limit), `Delete`, `Token`.
- `TenantMachines.List`, `Get`, `Delete` (`"revoked"` or `"deleting"`), `Revoke`.
- `Usage.Get` and `Usage.Sessions`: what the Organisation is charged, per Tenant and per session.

## Errors

Every non-2xx response returns an error that embeds `sai.SaiError` (`Status`, `Code`, `Message`,
`Body`, `RetryAfter`): `*AuthenticationError` (401), `*BadRequestError` (400),
`*PermissionDeniedError` (403), `*NotFoundError` (404), `*ConflictError` (409),
`*LinkOnlyApprovalError` (`ApprovalURL()`), `*GoneError` (410), `*SpendCapReachedError` (403;
`ResetsAt()`), `*RateLimitError` (429), `*ServiceUnavailableError` (503), `*ConnectionError`,
`*BlockError`. Use `errors.As`; it also finds the parent types (`*SaiError`, and `*ConflictError` in
a `*LinkOnlyApprovalError`).

A task that ran out of credit ends with `result.Status == sai.TurnError` and `result.ErrorCode` set to
`insufficient_credits` or `free_computer_time_exhausted`: stop retrying for today.

## Configuration

| `sai.Options` | Env           | Default                  |
| ------------- | ------------- | ------------------------ |
| `APIKey`      | `SAI_API_KEY` | required                 |
| `BaseURL`     | `SAI_API_URL` | `https://api.simular.ai` |
| `Timeout`     |               | 60 seconds per request   |
| `HTTPClient`  |               | `http.DefaultClient`     |
| `OrgID`       | `SAI_ORG_ID`  | for `Tenants.Token()`    |
| `VersionTag`  |               | none (`x-sai-version`)   |

## Development

```bash
cd go
go vet ./...
go test ./...   # parity, conformance cases and docs snippets; needs Node on PATH
```
