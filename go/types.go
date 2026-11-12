package sai

// Response objects. Each keeps the server's JSON in Raw, so a field the SDK does not model yet is
// still reachable. A pointer field, or a field tagged omitempty, is null when the server did not
// send it.

// Account is the plan and spendable credit.
type Account struct {
	UserID    string `json:"user_id"`
	PlanID    string `json:"plan_id,omitempty"`
	PlanTitle string `json:"plan_title"`
	Free      bool   `json:"free"`
	Unlimited bool   `json:"unlimited"`
	// CreditsUSD is the spendable credit in USD; nil on the unlimited plan or when billing could
	// not be reached.
	CreditsUSD *float64       `json:"credits_usd"`
	Raw        map[string]any `json:"-"`
}

func parseAccount(d map[string]any) *Account {
	plan, credits := obj(d["plan"]), obj(d["credits"])
	return &Account{
		UserID:     str(d["userId"]),
		PlanID:     str(plan["id"]),
		PlanTitle:  str(plan["title"]),
		Free:       truthy(plan["free"]),
		Unlimited:  truthy(plan["unlimited"]),
		CreditsUSD: floatPtr(credits["usd"]),
		Raw:        d,
	}
}

// Model is a model a session can run on; Allowed says whether this plan may use it.
type Model struct {
	ID       string         `json:"id"`
	Name     string         `json:"name"`
	Provider string         `json:"provider"`
	Tier     string         `json:"tier"`
	CostTier string         `json:"cost_tier"`
	Allowed  bool           `json:"allowed"`
	Raw      map[string]any `json:"-"`
}

func parseModel(d map[string]any) *Model {
	id := str(d["id"])
	name := id
	if s, ok := d["name"].(string); ok {
		name = s
	}
	allowed, present := d["allowed"]
	return &Model{
		ID:       id,
		Name:     name,
		Provider: str(d["provider"]),
		Tier:     str(d["tier"]),
		CostTier: str(d["costTier"]),
		Allowed:  !present || truthy(allowed),
		Raw:      d,
	}
}

// Machine is a computer Sai works on: a cloud computer, or a PC with the Sai app.
type Machine struct {
	ID   string `json:"id"`
	Name string `json:"name,omitempty"`
	// Kind is `cloud` (hosted by Simular) or `own` (a desktop with the Sai app).
	Kind string `json:"kind"`
	// Online is true when a message can reach it now (a hibernated cloud computer wakes on the
	// first message).
	Online bool `json:"online"`
	// State is `running`, `starting`, `asleep`, `creating` or `unknown`; empty on servers that do
	// not send it yet.
	State string `json:"state,omitempty"`
	// Status is the server's internal lifecycle value; it may gain values at any time. Use State.
	Status  string `json:"status,omitempty"`
	CanWake bool   `json:"can_wake"`
	// OS is `windows`, `linux`, `macOS` or `android`; empty when unknown.
	OS  string         `json:"os,omitempty"`
	Raw map[string]any `json:"-"`
}

func parseMachine(d map[string]any) *Machine {
	return &Machine{
		ID:      str(d["machineId"]),
		Name:    str(d["name"]),
		Kind:    str(d["kind"]),
		Online:  truthy(d["online"]),
		State:   str(d["state"]),
		Status:  str(d["status"]),
		CanWake: truthy(d["canWake"]),
		OS:      str(d["os"]),
		Raw:     d,
	}
}

// Tenant is one of your customers under an Organisation.
type Tenant struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	// ExternalID is your id for the customer. Unique in the Organisation; set on create only.
	ExternalID string            `json:"external_id,omitempty"`
	Metadata   map[string]string `json:"metadata"`
	// Status is `active` or `disabled`.
	Status string `json:"status"`
	// CreatedAt is Unix time in milliseconds.
	CreatedAt  int64  `json:"created_at"`
	DisabledAt *int64 `json:"disabled_at"`
	// MachineCount is the number of enrolled machines.
	MachineCount int `json:"machine_count"`
	// CloudMachineLimit is the most cloud machines the Tenant may have at once; nil: no limit.
	CloudMachineLimit *int `json:"cloud_machine_limit"`
	// ResidentialProxy is the Tenant's residential proxy switch. It has no effect yet: traffic goes
	// direct. Set by Get and Update; nil from List.
	ResidentialProxy *bool `json:"residential_proxy"`
	// CloudMachineCount is set by Get and Update; nil from List.
	CloudMachineCount *int `json:"cloud_machine_count"`
	// OwnComputerAccess is whether learn jobs and direct control may run code on the Tenant's
	// enrolled machines. Set by Get and Update; nil from List and from older servers.
	OwnComputerAccess *bool          `json:"own_computer_access"`
	Raw               map[string]any `json:"-"`
}

func parseTenant(d map[string]any) *Tenant {
	metadata := map[string]string{}
	for k, v := range obj(d["metadata"]) {
		if s, ok := v.(string); ok {
			metadata[k] = s
		}
	}
	var proxy *bool
	if b, ok := d["residentialProxy"].(bool); ok {
		proxy = &b
	}
	var own *bool
	if b, ok := d["ownComputerAccess"].(bool); ok {
		own = &b
	}
	return &Tenant{
		ID:                str(d["tenantId"]),
		Name:              str(d["name"]),
		ExternalID:        str(d["externalId"]),
		Metadata:          metadata,
		Status:            str(d["status"]),
		CreatedAt:         int64(num(d["createdAt"])),
		DisabledAt:        int64Ptr(d["disabledAt"]),
		MachineCount:      int(num(d["machineCount"])),
		CloudMachineLimit: intPtr(d["cloudMachineLimit"]),
		ResidentialProxy:  proxy,
		CloudMachineCount: intPtr(d["cloudMachineCount"]),
		OwnComputerAccess: own,
		Raw:               d,
	}
}

// TenantPage is one page of Tenants.
type TenantPage struct {
	Tenants []*Tenant `json:"tenants"`
	// NextCursor is the Cursor for the next page; empty on the last page.
	NextCursor string `json:"next_cursor,omitempty"`
}

// TenantMachine is a Tenant's computer: its own, enrolled, or a cloud machine Sai hosts for it.
type TenantMachine struct {
	ID       string `json:"id"`
	Name     string `json:"name,omitempty"`
	Platform string `json:"platform,omitempty"`
	// Status is sent by older servers only; read State.
	Status string `json:"status"`
	// Online is true when an enrolled machine reported in the last 3 minutes, or a cloud machine
	// is `ready`.
	Online         bool   `json:"online"`
	LastSeen       *int64 `json:"last_seen"`
	RuntimeVersion string `json:"runtime_version,omitempty"`
	// Kind is `enrolled` or `cloud`.
	Kind string `json:"kind"`
	// State is `online` or `offline` for an enrolled machine; `provisioning`, `ready`, `starting`,
	// `hibernated`, `deleting` or `failed` for a cloud one.
	State string `json:"state"`
	// MachineClass is the billing class of a cloud machine, e.g. `win32-4c8g`.
	MachineClass string `json:"machine_class,omitempty"`
	// CreatedAt is Unix time in milliseconds; nil from servers before cloud machines.
	CreatedAt *int64         `json:"created_at"`
	Raw       map[string]any `json:"-"`
}

func parseTenantMachine(d map[string]any) *TenantMachine {
	// Servers before cloud machines send `online` and `status` and no `kind` or `state`.
	state := str(d["state"])
	if state == "" {
		state = "offline"
		if truthy(d["online"]) {
			state = "online"
		}
	}
	online := state == "online" || state == "ready"
	if v, ok := d["online"]; ok {
		online = truthy(v)
	}
	kind := "enrolled"
	if d["kind"] == "cloud" {
		kind = "cloud"
	}
	return &TenantMachine{
		ID:             str(d["machineId"]),
		Name:           str(d["name"]),
		Platform:       str(d["platform"]),
		Status:         str(d["status"]),
		Online:         online,
		LastSeen:       int64Ptr(d["lastSeen"]),
		RuntimeVersion: str(d["runtimeVersion"]),
		Kind:           kind,
		State:          state,
		MachineClass:   str(d["machineClass"]),
		CreatedAt:      int64Ptr(d["createdAt"]),
		Raw:            d,
	}
}

// Enrollment is a single-use code that enrolls one computer into a Tenant.
type Enrollment struct {
	// Token is single use. Treat it as a secret until the Sai runtime redeems it.
	Token string `json:"token"`
	// ExpiresAt is Unix time in milliseconds, 15 minutes after it was created.
	ExpiresAt int64          `json:"expires_at"`
	Raw       map[string]any `json:"-"`
}

func parseEnrollment(d map[string]any) *Enrollment {
	return &Enrollment{Token: str(d["enrollmentToken"]), ExpiresAt: int64(num(d["expiresAt"])), Raw: d}
}

// TenantToken is a one-hour token that acts as a Tenant.
type TenantToken struct {
	// Token is the APIKey of a client that acts as the Tenant.
	Token string `json:"token"`
	// ExpiresAt is Unix time in milliseconds, an hour after the exchange. Exchange again then.
	ExpiresAt int64          `json:"expires_at"`
	TenantID  string         `json:"tenant_id"`
	Raw       map[string]any `json:"-"`
}

func parseTenantToken(d map[string]any) *TenantToken {
	return &TenantToken{Token: str(d["token"]), ExpiresAt: int64(num(d["expiresAt"])), TenantID: str(d["tenantId"]), Raw: d}
}

// Attachment is a file uploaded with Files.Upload. Pass it in Attachments.
type Attachment struct {
	FileID string         `json:"file_id"`
	Name   string         `json:"name"`
	Mime   string         `json:"mime"`
	Size   int64          `json:"size"`
	Raw    map[string]any `json:"-"`
}

func parseAttachment(d map[string]any) *Attachment {
	return &Attachment{FileID: str(d["fileId"]), Name: str(d["name"]), Mime: str(d["mime"]), Size: int64(num(d["size"])), Raw: d}
}

// LiveView is a computer's live screen. Both URLs carry a token: keep them private.
type LiveView struct {
	MachineID string `json:"machine_id"`
	// LiveURL is a page that shows the screen with no Simular sign-in: send it to the person who
	// should act (a sign-in, a captcha). Whoever opens it can use the mouse and keyboard while no
	// Sai turn is running. It works until ExpiresAt or Machines.RevokeLive. Empty where the server
	// does not offer the page.
	LiveURL string `json:"live_url,omitempty"`
	// ExpiresAt is when LiveURL stops working, Unix time in milliseconds; nil without LiveURL.
	ExpiresAt *int64 `json:"expires_at"`
	// WebsocketURL is a Guacamole tunnel for a viewer of your own. It takes input too.
	WebsocketURL string `json:"websocket_url"`
	Width        int    `json:"width"`
	Height       int    `json:"height"`
}

// Approval: Sai is waiting for permission, or for an answer to a choice question.
type Approval struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	Description string `json:"description"`
	// Type is `exec`, `choice`, ...; a `choice` needs selections when approved.
	Type string `json:"type"`
	// IsLinkOnly: a human must answer in a browser at URL; the API cannot.
	IsLinkOnly bool             `json:"is_link_only"`
	URL        string           `json:"url,omitempty"`
	Command    string           `json:"command,omitempty"`
	Questions  []map[string]any `json:"questions"`
	Raw        map[string]any   `json:"-"`
}

func parseApproval(d map[string]any) *Approval {
	return &Approval{
		ID:          str(d["approvalId"]),
		Title:       str(d["title"]),
		Description: str(d["description"]),
		Type:        str(d["approvalType"]),
		IsLinkOnly:  truthy(d["isLinkOnly"]),
		URL:         str(d["approvalUrl"]),
		Command:     str(d["command"]),
		Questions:   objs(d["questions"]),
		Raw:         d,
	}
}

// Usage is the tokens and cost of model calls.
type Usage struct {
	InputTokens      int64          `json:"input_tokens"`
	OutputTokens     int64          `json:"output_tokens"`
	CacheReadTokens  int64          `json:"cache_read_tokens"`
	CacheWriteTokens int64          `json:"cache_write_tokens"`
	CostUSD          float64        `json:"cost_usd"`
	ModelCalls       int            `json:"model_calls"`
	ByModel          map[string]any `json:"by_model"`
}

func parseUsage(v any) *Usage {
	u, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	return &Usage{
		InputTokens:      int64(num(u["inputTokens"])),
		OutputTokens:     int64(num(u["outputTokens"])),
		CacheReadTokens:  int64(num(u["cacheReadTokens"])),
		CacheWriteTokens: int64(num(u["cacheWriteTokens"])),
		CostUSD:          num(u["costUsd"]),
		ModelCalls:       int(num(u["modelCalls"])),
		ByModel:          obj(u["byModel"]),
	}
}

// EventKind is the SDK's name for what happened in a turn.
type EventKind string

// The event kinds. EventOther appears only with EventsOptions.Raw.
const (
	EventStep      EventKind = "step"
	EventMessage   EventKind = "message"
	EventApproval  EventKind = "approval"
	EventToolError EventKind = "tool_error"
	EventError     EventKind = "error"
	EventFinished  EventKind = "finished"
	EventOther     EventKind = "other"
)

// EventKinds lists every EventKind.
var EventKinds = []EventKind{EventStep, EventMessage, EventApproval, EventToolError, EventError, EventFinished, EventOther}

// Wire event type → SDK kind. Anything not listed is framing or internal detail, and is yielded
// only with Raw.
var eventKinds = map[string]EventKind{
	"data-progress":         EventStep,
	"text-delta":            EventMessage,
	"data-approval-request": EventApproval,
	"tool-output-error":     EventToolError,
	"error":                 EventError,
	"finish":                EventFinished,
}

// Event is one thing that happened in a turn. Kind is the SDK's name; Type is the wire type.
type Event struct {
	Kind     EventKind `json:"kind"`
	Type     string    `json:"type"`
	Text     string    `json:"text,omitempty"`
	Approval *Approval `json:"approval"`
	// Code is `insufficient_credits` or `free_computer_time_exhausted` on errors: stop retrying
	// today.
	Code string         `json:"code,omitempty"`
	Raw  map[string]any `json:"-"`
}

func parseEvent(d map[string]any) *Event {
	t := str(d["type"])
	data := obj(d["data"])
	ev := &Event{Type: t, Code: str(d["code"]), Raw: d}
	switch t {
	case "data-progress":
		ev.Text = str(data["text"])
	case "text-delta", "reasoning-delta":
		ev.Text = str(d["delta"])
	case "tool-output-error", "error":
		ev.Text = str(d["errorText"])
	case "data-approval-request":
		if truthy(data["approvalId"]) {
			ev.Approval = parseApproval(data)
			ev.Text = ev.Approval.Title
		}
	}
	ev.Kind = EventOther
	if k, ok := eventKinds[t]; ok {
		ev.Kind = k
	}
	return ev
}

// TurnStatus is where a turn stands: TurnRunning while polling, then one of the others.
type TurnStatus string

// The turn statuses.
const (
	TurnRunning       TurnStatus = "running"
	TurnIdle          TurnStatus = "idle"
	TurnNeedsApproval TurnStatus = "needs_approval"
	TurnError         TurnStatus = "error"
)

// TurnStatuses lists every TurnStatus.
var TurnStatuses = []TurnStatus{TurnRunning, TurnIdle, TurnNeedsApproval, TurnError}

// TurnResult is where a turn stopped. Status is `idle` (done: Text is the answer), `error`, or
// `needs_approval` (waiting on Approval; answer it and call Wait again). Record is the turn's
// record for a structured message (one with Inputs, OutputSchema or SuccessCriteria).
type TurnResult struct {
	Status       TurnStatus  `json:"status"`
	Text         string      `json:"text"`
	SessionID    string      `json:"session_id"`
	Approval     *Approval   `json:"approval"`
	Error        string      `json:"error,omitempty"`
	ErrorCode    string      `json:"error_code,omitempty"`
	Usage        *Usage      `json:"usage"`
	SessionUsage *Usage      `json:"session_usage"`
	Record       *TurnRecord `json:"record"`
	// OK: idle, and for a structured message, the turn succeeded.
	OK bool `json:"ok"`
}

// Check is one yes/no constraint a turn is checked against.
type Check struct {
	// ID is letters, digits, `_` or `-`; at most 64 characters.
	ID    string `json:"id"`
	Check string `json:"check"`
	// ReturnEvidence also returns one sentence of evidence for this check (an extra model call).
	ReturnEvidence bool `json:"return_evidence,omitempty"`
}

// Criteria is what a judge checks: CriteriaText, a guideline in a sentence, or Checks.
type Criteria interface{ criteria() any }

// CriteriaText is a guideline for a judge, in words.
type CriteriaText string

// Checks is a list of yes/no checks.
type Checks []Check

func (c CriteriaText) criteria() any { return string(c) }
func (c Checks) criteria() any {
	out := make([]map[string]any, len(c))
	for i, x := range c {
		m := map[string]any{"id": x.ID, "check": x.Check}
		if x.ReturnEvidence {
			m["returnEvidence"] = true
		}
		out[i] = m
	}
	return out
}

// Evidence is the verdict on one success criterion.
type Evidence struct {
	// ID is the check's id; empty for a natural-language criteria.
	ID     string `json:"id,omitempty"`
	Passed bool   `json:"passed"`
	// Score is the probability that the check holds (Checks only).
	Score *float64 `json:"score"`
	// Evidence is always set for a natural-language criteria; for a Check, only with
	// ReturnEvidence.
	Evidence string `json:"evidence,omitempty"`
}

// TurnRecordStatus is where a turn's record stands.
type TurnRecordStatus string

// The turn record statuses, from GET /v1/agents/turns/{id}.
const (
	RecordRunning    TurnRecordStatus = "running"
	RecordNeedsInput TurnRecordStatus = "needs_input"
	RecordFinalizing TurnRecordStatus = "finalizing"
	RecordSucceeded  TurnRecordStatus = "succeeded"
	RecordFailed     TurnRecordStatus = "failed"
)

// TurnRecordStatuses lists every TurnRecordStatus.
var TurnRecordStatuses = []TurnRecordStatus{RecordRunning, RecordNeedsInput, RecordFinalizing, RecordSucceeded, RecordFailed}

// TurnRecord is a turn's record. Status is `running`, `needs_input` (an approval or question is
// pending), `finalizing` (the agent is done; output and checks are being worked out), `succeeded`
// or `failed`. On `failed`, ReasonCode says why: `agent_error` (with ErrorCode when known),
// `machine_unavailable`, `not_started`, and for a structured message `output_invalid` (see
// RawAnswer and OutputErrors), `criteria_not_met` or `criteria_unchecked`.
type TurnRecord struct {
	ID        string           `json:"id"`
	SessionID string           `json:"session_id,omitempty"`
	MachineID string           `json:"machine_id"`
	Status    TurnRecordStatus `json:"status"`
	// Output is the agent's final text; with OutputSchema, an object matching it.
	Output     any    `json:"output"`
	ReasonCode string `json:"reason_code,omitempty"`
	RawAnswer  string `json:"raw_answer,omitempty"`
	// ErrorCode is `insufficient_credits` or `free_computer_time_exhausted`, for a known
	// `agent_error`.
	ErrorCode    string   `json:"error_code,omitempty"`
	OutputErrors []string `json:"output_errors"`
	// Evidence is empty for a plain message.
	Evidence []Evidence `json:"evidence"`
	// Usage is the tokens of every model call the agent made in the turn.
	Usage            *Usage `json:"usage"`
	RecordTrajectory bool   `json:"record_trajectory"`
	// TrajectoryRecorded: at least one step was stored (Turns.Trajectory).
	TrajectoryRecorded bool           `json:"trajectory_recorded"`
	Template           string         `json:"template,omitempty"`
	Inputs             map[string]any `json:"inputs"`
	// Replayed is true when IdempotencyKey matched an earlier turn: this is that turn, and nothing
	// was sent.
	Replayed bool           `json:"replayed"`
	Done     bool           `json:"done"`
	OK       bool           `json:"ok"`
	Raw      map[string]any `json:"-"`
}

func parseTurnRecord(d map[string]any) *TurnRecord {
	status := TurnRecordStatus(str(d["status"]))
	if status == "" {
		status = RecordRunning
	}
	trajectory := obj(d["trajectory"])
	evidence := []Evidence{}
	for _, e := range objs(d["evidence"]) {
		evidence = append(evidence, Evidence{
			ID:       str(e["id"]),
			Passed:   truthy(e["passed"]),
			Score:    floatPtr(e["score"]),
			Evidence: str(e["evidence"]),
		})
	}
	inputs, _ := d["inputs"].(map[string]any)
	return &TurnRecord{
		ID:                 str(d["turnId"]),
		SessionID:          str(d["sessionId"]),
		MachineID:          str(d["machineId"]),
		Status:             status,
		Output:             d["output"],
		ReasonCode:         str(d["reason_code"]),
		RawAnswer:          str(d["raw_answer"]),
		ErrorCode:          str(d["error_code"]),
		OutputErrors:       strs(d["output_errors"]),
		Evidence:           evidence,
		Usage:              parseUsage(d["usage"]),
		RecordTrajectory:   truthy(d["recordTrajectory"]),
		TrajectoryRecorded: truthy(trajectory["recorded"]),
		Template:           str(d["template"]),
		Inputs:             inputs,
		Replayed:           truthy(d["idempotent_replay"]),
		Done:               status == RecordSucceeded || status == RecordFailed,
		OK:                 status == RecordSucceeded,
		Raw:                d,
	}
}

// TrajectoryStep is one step the agent took: what it did, and why. Fetch its screen with
// Turns.Screenshot.
type TrajectoryStep struct {
	Index int `json:"index"`
	// Final marks the screenshot taken when the turn ended, after the last step.
	Final     bool   `json:"final"`
	Timestamp string `json:"timestamp"`
	Title     string `json:"title,omitempty"`
	Code      string `json:"code,omitempty"`
	// Rationale is the agent's text before the action.
	Rationale     string         `json:"rationale,omitempty"`
	Error         string         `json:"error,omitempty"`
	HasScreenshot bool           `json:"has_screenshot"`
	Raw           map[string]any `json:"-"`
}

func parseTrajectoryStep(d map[string]any) *TrajectoryStep {
	return &TrajectoryStep{
		Index:         int(num(d["index"])),
		Final:         truthy(d["final"]),
		Timestamp:     str(d["timestamp"]),
		Title:         str(d["title"]),
		Code:          str(d["code"]),
		Rationale:     str(d["rationale"]),
		Error:         str(d["error"]),
		HasScreenshot: truthy(d["screenshot"]),
		Raw:           d,
	}
}

// ExecError is how a Simulang block failed.
type ExecError struct {
	// Kind is `exception`, `timeout` or `interrupted`.
	Kind    string `json:"kind"`
	Message string `json:"message"`
	Stack   string `json:"stack,omitempty"`
}

// ExecResult is what one Simulang block returned. A block that threw is still a result: check
// Error.
type ExecResult struct {
	Result any        `json:"result"`
	Logs   []string   `json:"logs"`
	Error  *ExecError `json:"error"`
	// Screenshot is the screenshot the block captured (page or app snapshot, pageContent), decoded.
	Screenshot []byte `json:"screenshot"`
	// ScreenshotMimeType is `image/jpeg` or `image/png`.
	ScreenshotMimeType string           `json:"screenshot_mime_type,omitempty"`
	ScreenshotOmitted  bool             `json:"screenshot_omitted"`
	Variables          []map[string]any `json:"variables"`
	DurationMs         int64            `json:"duration_ms"`
	OK                 bool             `json:"ok"`
	Raw                map[string]any   `json:"-"`
}

func parseExecResult(d map[string]any) *ExecResult {
	obs := obj(d["observations"])
	shot := obj(obs["screenshot"])
	r := &ExecResult{
		Result:             d["result"],
		Logs:               strs(d["logs"]),
		Screenshot:         decodeBase64(str(shot["base64"])),
		ScreenshotMimeType: str(shot["mimeType"]),
		ScreenshotOmitted:  truthy(obs["screenshotOmitted"]),
		Variables:          objs(d["variables"]),
		DurationMs:         int64(num(d["durationMs"])),
		Raw:                d,
	}
	if truthy(d["error"]) {
		e := obj(d["error"])
		r.Error = &ExecError{Kind: str(e["kind"]), Message: str(e["message"]), Stack: str(e["stack"])}
	}
	r.OK = r.Error == nil
	return r
}

// LearnParameter is one input of learned code: a `{{name}}` in the template and a key of main's
// params.
type LearnParameter struct {
	Name         string `json:"name"`
	DefaultValue string `json:"default_value"`
	Description  string `json:"description,omitempty"`
}

// Evaluation is how learned code did on one run, for Learn.Create with InitialCode.
type Evaluation struct {
	Inputs map[string]any
	// Result is the run's result from ControlLease.Exec or Run; its screenshot is not sent.
	Result *ExecResult
	// Judgement is the id of a judgement of the run.
	Judgement string
	Passed    *bool
	Note      string
}

// LearnReset is what a reset did before a run or before the agent run.
type LearnReset struct {
	// Kind is `code` or `task`.
	Kind       string `json:"kind"`
	OK         bool   `json:"ok"`
	DurationMs *int64 `json:"duration_ms"`
	// TurnID is a reset task's turn.
	TurnID string `json:"turn_id,omitempty"`
	Error  string `json:"error,omitempty"`
}

func parseLearnReset(v any) *LearnReset {
	r, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	kind := "code"
	if r["kind"] == "task" {
		kind = "task"
	}
	return &LearnReset{Kind: kind, OK: truthy(r["ok"]), DurationMs: int64Ptr(r["durationMs"]), TurnID: str(r["turnId"]), Error: str(r["error"])}
}

// LearnRollout is one run of a version of the code in a learn job.
type LearnRollout struct {
	Index int `json:"index"`
	// Verdict is `passed`, `failed`, `error` (the run could not be judged), `stopped` (the job
	// stopped during this run), or empty while the run is going.
	Verdict     string         `json:"verdict,omitempty"`
	Reset       *LearnReset    `json:"reset"`
	Error       string         `json:"error,omitempty"`
	Result      map[string]any `json:"result"`
	DurationMs  *int64         `json:"duration_ms"`
	JudgementID string         `json:"judgement_id,omitempty"`
	// Summary is the judge's summary.
	Summary string `json:"summary,omitempty"`
	// ContinuationTurnID is, with ContinueWithAgent, the agent's turn after this failed run.
	ContinuationTurnID   string `json:"continuation_turn_id,omitempty"`
	ContinuationTimedOut bool   `json:"continuation_timed_out"`
}

// LearnIteration is one version of the code in a learn job and its runs.
type LearnIteration struct {
	// Index is 1-based.
	Index int `json:"index"`
	// LearnID is the convert or heal record that wrote this version (Learn.Get reads it).
	LearnID string `json:"learn_id,omitempty"`
	// Changes is what the repair changed and why.
	Changes  string         `json:"changes,omitempty"`
	Passed   int            `json:"passed"`
	Runs     int            `json:"runs"`
	Rollouts []LearnRollout `json:"rollouts"`
}

func parseIteration(d map[string]any) LearnIteration {
	it := LearnIteration{
		Index:    int(num(d["index"])),
		LearnID:  str(d["learnId"]),
		Changes:  str(d["changes"]),
		Passed:   int(num(d["passed"])),
		Runs:     int(num(d["runs"])),
		Rollouts: []LearnRollout{},
	}
	for _, r := range objs(d["rollouts"]) {
		result, _ := r["result"].(map[string]any)
		it.Rollouts = append(it.Rollouts, LearnRollout{
			Index:                int(num(r["index"])),
			Verdict:              str(r["verdict"]),
			Reset:                parseLearnReset(r["reset"]),
			Error:                str(r["error"]),
			Result:               result,
			DurationMs:           int64Ptr(r["durationMs"]),
			JudgementID:          str(r["judgementId"]),
			Summary:              str(r["summary"]),
			ContinuationTurnID:   str(r["continuationTurnId"]),
			ContinuationTimedOut: truthy(r["continuationTimedOut"]),
		})
	}
	return it
}

// LearnTestResult is how the returned code did when it was run, on Inputs only.
type LearnTestResult struct {
	// Status is `not_judged` (the code was not run all its runs), `passed` (it passed every run)
	// or `failed` (a run failed).
	Status       string         `json:"status"`
	PassedRuns   int            `json:"passed_runs"`
	RequiredRuns int            `json:"required_runs"`
	Inputs       map[string]any `json:"inputs"`
}

// LearnProgress is the step a running learn job is on.
type LearnProgress struct {
	Step      string `json:"step"`
	Iteration *int   `json:"iteration"`
	Rollout   *int   `json:"rollout"`
}

// AgentJudgement is, with JudgeInitialAgentRun, the judgement of a job's agent run.
type AgentJudgement struct {
	JudgementID string `json:"judgement_id"`
	Verdict     string `json:"verdict"`
	Summary     string `json:"summary,omitempty"`
}

// LearnValidation is what is wrong with learned code.
type LearnValidation struct {
	Errors   []string `json:"errors"`
	Warnings []string `json:"warnings"`
}

// LearnResult is the result of Learn.Create: Simulang code made from recorded turns or from an
// agent run, a repair of code you sent, or a learn job that runs, judges and repairs the code.
// Run the code with ControlLease.Run. Research preview.
type LearnResult struct {
	ID string `json:"id"`
	// Mode is `convert` (code from turns), `heal` (a repair of InitialCode), or `policyIteration`
	// (a job that runs the code).
	Mode string `json:"mode"`
	// Status is whether the call did its work: `running` while a job runs, `succeeded`, `failed`
	// when it wrote no code (e.g. Validation.Errors), `stopped` when a job ended early (see
	// StopReason). How the code did is TestResult.
	Status string `json:"status"`
	// StopReason is why a job ended early, e.g. `cancelled`, `time_limit`, `agent_failed`.
	StopReason string `json:"stop_reason,omitempty"`
	// Message is one sentence on why a job stopped.
	Message    string           `json:"message,omitempty"`
	TestResult *LearnTestResult `json:"test_result"`
	// Progress is the step a running job is on.
	Progress *LearnProgress `json:"progress"`
	// AgentTurnID is a job's agent run; pass it in turns to start again from that run.
	AgentTurnID string `json:"agent_turn_id,omitempty"`
	// AgentRunEnd is how the agent run ended when it gave no answer; empty when it answered.
	// `time_limit` (still converted), `needs_input` or the turn's `reason_code`, e.g.
	// `agent_error`; every end but `time_limit` stops the job (`agent_failed`) before conversion.
	AgentRunEnd    string          `json:"agent_run_end,omitempty"`
	AgentRunReset  *LearnReset     `json:"agent_run_reset"`
	AgentJudgement *AgentJudgement `json:"agent_judgement"`
	// Version is the iteration Code is from.
	Version    *int             `json:"version"`
	Iterations []LearnIteration `json:"iterations"`
	Title      string           `json:"title,omitempty"`
	// Template is the task with `{{name}}` placeholders: send it with Inputs to run it with the
	// agent.
	Template   string           `json:"template,omitempty"`
	Parameters []LearnParameter `json:"parameters"`
	// Code is `async function main(params = { ... })`.
	Code         string          `json:"code"`
	OutputSchema map[string]any  `json:"output_schema"`
	Validation   LearnValidation `json:"validation"`
	// Changes is, for `heal`, what changed and why.
	Changes     string   `json:"changes,omitempty"`
	SourceTurns []string `json:"source_turns"`
	Usage       *Usage   `json:"usage"`
	// Error is the error code when the request failed, e.g. `trajectory_not_recorded`.
	Error string `json:"error,omitempty"`
	// Replayed is true when IdempotencyKey matched an earlier call: this is that call's result.
	Replayed bool           `json:"replayed"`
	OK       bool           `json:"ok"`
	Raw      map[string]any `json:"-"`
}

func parseLearnResult(d map[string]any) *LearnResult {
	v := obj(d["validation"])
	status := str(d["status"])
	if status == "" {
		status = "running"
	}
	mode := str(d["mode"])
	if mode != "heal" && mode != "policyIteration" {
		mode = "convert"
	}
	r := &LearnResult{
		ID:            str(d["learnId"]),
		Mode:          mode,
		Status:        status,
		StopReason:    str(d["stopReason"]),
		Message:       str(d["message"]),
		AgentTurnID:   str(d["agentTurnId"]),
		AgentRunEnd:   str(d["agentRunEnd"]),
		AgentRunReset: parseLearnReset(d["agentRunReset"]),
		Version:       intPtr(d["version"]),
		Iterations:    []LearnIteration{},
		Title:         str(d["title"]),
		Template:      str(d["template"]),
		Parameters:    []LearnParameter{},
		Code:          str(d["code"]),
		Validation:    LearnValidation{Errors: strs(v["errors"]), Warnings: strs(v["warnings"])},
		Changes:       str(d["changes"]),
		SourceTurns:   strs(d["sourceTurns"]),
		Usage:         parseUsage(d["usage"]),
		Error:         str(d["error"]),
		Replayed:      truthy(d["idempotent_replay"]),
		OK:            status == "succeeded",
		Raw:           d,
	}
	if truthy(d["testResult"]) {
		t := obj(d["testResult"])
		ts := str(t["status"])
		if ts == "" {
			ts = "not_judged"
		}
		var inputs map[string]any
		if truthy(t["inputs"]) {
			inputs = obj(t["inputs"])
		}
		r.TestResult = &LearnTestResult{Status: ts, PassedRuns: int(num(t["passedRuns"])), RequiredRuns: int(num(t["requiredRuns"])), Inputs: inputs}
	}
	if truthy(d["progress"]) {
		p := obj(d["progress"])
		r.Progress = &LearnProgress{Step: str(p["step"]), Iteration: intPtr(p["iteration"]), Rollout: intPtr(p["rollout"])}
	}
	if truthy(d["agentJudgement"]) {
		a := obj(d["agentJudgement"])
		r.AgentJudgement = &AgentJudgement{JudgementID: str(a["judgementId"]), Verdict: str(a["verdict"]), Summary: str(a["summary"])}
	}
	for _, it := range objs(d["iterations"]) {
		r.Iterations = append(r.Iterations, parseIteration(it))
	}
	for _, p := range objs(d["parameters"]) {
		r.Parameters = append(r.Parameters, LearnParameter{Name: str(p["name"]), DefaultValue: str(p["defaultValue"]), Description: str(p["description"])})
	}
	if truthy(d["outputSchema"]) {
		r.OutputSchema = obj(d["outputSchema"])
	}
	return r
}

// LearnRun is one run of a learn job's code, from Learn.Rollout.
type LearnRun struct {
	LearnID   string `json:"learn_id"`
	Iteration int    `json:"iteration"`
	Rollout   int    `json:"rollout"`
	// Run is what the run returned and logged: `{ result, logs, error, durationMs }`.
	Run map[string]any `json:"run"`
	// Judgement is the judge's record of the run, when it was judged.
	Judgement map[string]any `json:"judgement"`
	Raw       map[string]any `json:"-"`
}

func parseLearnRun(d map[string]any) *LearnRun {
	r := &LearnRun{LearnID: str(d["learnId"]), Iteration: int(num(d["iteration"])), Rollout: int(num(d["rollout"])), Run: obj(d["run"]), Raw: d}
	if truthy(d["judgement"]) {
		r.Judgement = obj(d["judgement"])
	}
	return r
}

// CriterionResult is the verdict on one criterion of a judgement.
type CriterionResult struct {
	// ID is the check's id; empty for a natural-language criteria.
	ID    string `json:"id,omitempty"`
	Check string `json:"check"`
	// Verdict is `passed`, `failed`, or `unverifiable` when the record cannot show it.
	Verdict  string   `json:"verdict"`
	Score    *float64 `json:"score"`
	Evidence string   `json:"evidence,omitempty"`
}

// Judgement is the result of Judge.Create. It never changes the turns it judged. Research preview.
type Judgement struct {
	ID string `json:"id"`
	// Verdict is `passed`, `failed` or `unverifiable`.
	Verdict  string            `json:"verdict,omitempty"`
	Summary  string            `json:"summary,omitempty"`
	Task     string            `json:"task,omitempty"`
	Criteria []CriterionResult `json:"criteria"`
	Turns    []string          `json:"turns"`
	Usage    *Usage            `json:"usage"`
	Replayed bool              `json:"replayed"`
	OK       bool              `json:"ok"`
	Raw      map[string]any    `json:"-"`
}

func parseJudgement(d map[string]any) *Judgement {
	j := &Judgement{
		ID:       str(d["judgementId"]),
		Verdict:  str(d["verdict"]),
		Summary:  str(d["summary"]),
		Task:     str(d["task"]),
		Criteria: []CriterionResult{},
		Turns:    strs(d["turns"]),
		Usage:    parseUsage(d["usage"]),
		Replayed: truthy(d["idempotent_replay"]),
		Raw:      d,
	}
	for _, c := range objs(d["criteria"]) {
		verdict := str(c["verdict"])
		if verdict == "" {
			verdict = "unverifiable"
		}
		j.Criteria = append(j.Criteria, CriterionResult{ID: str(c["id"]), Check: str(c["check"]), Verdict: verdict, Score: floatPtr(c["score"]), Evidence: str(c["evidence"])})
	}
	j.OK = j.Verdict == "passed"
	return j
}

// AuthInfo is who the key or token acts as.
type AuthInfo struct {
	UserID string `json:"user_id"`
	// AuthType is `apiKey` for a key, `firebase` for a signed-in session or a Tenant token.
	AuthType string `json:"auth_type"`
	// TenantID is set when the credential is a Tenant token.
	TenantID string         `json:"tenant_id,omitempty"`
	OrgID    string         `json:"org_id,omitempty"`
	Raw      map[string]any `json:"-"`
}

func parseAuthInfo(d map[string]any) *AuthInfo {
	return &AuthInfo{UserID: str(d["userId"]), AuthType: str(d["authType"]), TenantID: str(d["tenantId"]), OrgID: str(d["orgId"]), Raw: d}
}

// SessionSummary is a session on a computer, from Sessions.List.
type SessionSummary struct {
	ID    string `json:"id"`
	Title string `json:"title"`
	// UpdatedAt is Unix time in milliseconds.
	UpdatedAt int64 `json:"updated_at"`
	// Active marks the session the next message on this computer goes to.
	Active bool           `json:"active"`
	Raw    map[string]any `json:"-"`
}

func parseSessionSummary(d map[string]any) *SessionSummary {
	return &SessionSummary{ID: str(d["sessionId"]), Title: str(d["title"]), UpdatedAt: int64(num(d["updatedAt"])), Active: truthy(d["active"]), Raw: d}
}

// CategoryUsage is one kind of spend.
type CategoryUsage struct {
	CostCents int64 `json:"cost_cents"`
}

// TenantUsage is one Tenant's spend in an Organisation usage report.
type TenantUsage struct {
	TenantID   string `json:"tenant_id"`
	Name       string `json:"name,omitempty"`
	ExternalID string `json:"external_id,omitempty"`
	CostCents  int64  `json:"cost_cents"`
	// ByCategory is by kind of spend, such as `token` for AI calls and `compute` for computer time.
	ByCategory map[string]CategoryUsage `json:"by_category"`
}

// UsageBucket is one period of an Organisation usage report, or the whole range (Totals).
type UsageBucket struct {
	// Bucket is the period, e.g. `2026-10`; empty on Totals.
	Bucket    string `json:"bucket,omitempty"`
	CostCents int64  `json:"cost_cents"`
	// ByTenant is keyed by Tenant id. Spend tied to no Tenant is in CostCents only.
	ByTenant map[string]TenantUsage `json:"by_tenant"`
}

// OrgUsage is what an Organisation is charged, per Tenant, from Usage.Get.
type OrgUsage struct {
	Granularity string         `json:"granularity"`
	From        string         `json:"from"`
	To          string         `json:"to"`
	Totals      UsageBucket    `json:"totals"`
	Buckets     []UsageBucket  `json:"buckets"`
	Raw         map[string]any `json:"-"`
}

func parseUsageBucket(d map[string]any) UsageBucket {
	b := UsageBucket{Bucket: str(d["bucket"]), CostCents: int64(num(d["costCents"])), ByTenant: map[string]TenantUsage{}}
	for key, v := range obj(d["byTenant"]) {
		t := obj(v)
		u := TenantUsage{TenantID: key, Name: str(t["name"]), ExternalID: str(t["externalId"]), CostCents: int64(num(t["costCents"])), ByCategory: map[string]CategoryUsage{}}
		if s, ok := t["tenantId"].(string); ok {
			u.TenantID = s
		}
		for cat, c := range obj(t["byCategory"]) {
			u.ByCategory[cat] = CategoryUsage{CostCents: int64(num(obj(c)["costCents"]))}
		}
		b.ByTenant[key] = u
	}
	return b
}

func parseOrgUsage(d map[string]any) *OrgUsage {
	u := &OrgUsage{Granularity: str(d["granularity"]), From: str(d["from"]), To: str(d["to"]), Totals: parseUsageBucket(obj(d["totals"])), Buckets: []UsageBucket{}, Raw: d}
	if list, ok := d["buckets"].([]any); ok {
		for _, b := range list {
			u.Buckets = append(u.Buckets, parseUsageBucket(obj(b)))
		}
	}
	return u
}

// SessionSpend is what one of a Tenant's sessions spent on AI calls: in a date range, or so far
// when looked up by SessionIDs.
type SessionSpend struct {
	SessionID string `json:"session_id"`
	// Title is empty when the session has no title.
	Title string `json:"title,omitempty"`
	// CostUSD is in US dollars, not rounded to cents. Nil only from a SessionIDs lookup, when the
	// session can't be read in full right now (never 0 for that); Settled is then false.
	CostUSD *float64 `json:"cost_usd"`
	// ModelCalls is nil together with CostUSD.
	ModelCalls *int `json:"model_calls"`
	// FirstDay and LastDay are the UTC days (`YYYY-MM-DD`) the session's spend was first and last
	// counted, over its whole life. Empty from a SessionIDs lookup.
	FirstDay string `json:"first_day"`
	LastDay  string `json:"last_day"`
	// Settled is, from a SessionIDs lookup, true once the session's latest task has ended and
	// every charge for it has come in. Nil on a list page.
	Settled *bool `json:"settled"`
}

// SessionSpendPage is one page of Usage.Sessions. A page can be empty and still have a
// NextCursor.
type SessionSpendPage struct {
	Sessions []SessionSpend `json:"sessions"`
	// NextCursor is the Cursor for the next page; empty on the last page.
	NextCursor string `json:"next_cursor,omitempty"`
	// DataThrough is when the figures are complete up to (ISO 8601); empty when unknown, and from
	// a SessionIDs lookup.
	DataThrough string `json:"data_through,omitempty"`
	// AsOf is, from a SessionIDs lookup, when the figures were read (ISO 8601); empty on a list
	// page.
	AsOf string         `json:"as_of,omitempty"`
	Raw  map[string]any `json:"-"`
}

func parseSessionSpendPage(d map[string]any) *SessionSpendPage {
	p := &SessionSpendPage{Sessions: []SessionSpend{}, NextCursor: str(d["nextCursor"]), DataThrough: str(d["dataThrough"]), AsOf: str(d["asOf"]), Raw: d}
	if list, ok := d["sessions"].([]any); ok {
		for _, x := range list {
			s := obj(x)
			var settled *bool
			if b, ok := s["settled"].(bool); ok {
				settled = &b
			}
			p.Sessions = append(p.Sessions, SessionSpend{
				SessionID:  str(s["sessionId"]),
				Title:      str(s["title"]),
				CostUSD:    floatPtr(s["costUsd"]),
				ModelCalls: intPtr(s["modelCalls"]),
				FirstDay:   str(s["firstDay"]),
				LastDay:    str(s["lastDay"]),
				Settled:    settled,
			})
		}
	}
	return p
}
