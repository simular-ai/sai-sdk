package sai

import (
	"context"
	"errors"
	"fmt"
	"iter"
	"net/url"
	"slices"
	"strconv"
	"time"
)

// Maps to /v1/agents/*: new-session, message (wait=false), events, approve, abort. Every message
// gets a turn id (Turn.ID, read with Client.Turns); a message with Inputs, OutputSchema or
// SuccessCriteria is structured and its turn also returns a typed result.

const (
	defaultPollWait = 30 * time.Second
	// Between turn reads; GET /v1/agents/turns/{id} never holds.
	recordPollInterval = 2 * time.Second
	// How long to wait after a 429 that did not say.
	defaultRetryAfter = 30 * time.Second
)

// ThinkingLevel is how long the agent reasons before it acts: the levels of the "Thinking
// strength" agent setting. Ignored by models without extended thinking.
type ThinkingLevel string

// The thinking levels.
const (
	ThinkingOff    ThinkingLevel = "off"
	ThinkingLow    ThinkingLevel = "low"
	ThinkingMedium ThinkingLevel = "medium"
	ThinkingHigh   ThinkingLevel = "high"
	ThinkingXHigh  ThinkingLevel = "xhigh"
)

// ApprovalAnswer is what an ApprovalHandler answers: a Response (`yes`, `no`, `task`), with
// Selections for a choice, one list of option values per question.
type ApprovalAnswer struct {
	Response   string
	Selections [][]string
}

// ApprovalHandler answers an approval, or returns nil to leave it pending (e.g. a human answers
// it in a browser).
type ApprovalHandler func(approval *Approval) *ApprovalAnswer

// SessionOptions pick the computer. Machine may be empty when the account has one computer.
type SessionOptions struct {
	Machine string
}

// SendOptions are the options of Session.Send. Every field is optional.
type SendOptions struct {
	// Model is an id from Models.List (or `auto`); it sticks to the session until changed.
	Model       string
	Attachments []*Attachment
	// Inputs are the values for the `{{name}}` placeholders in the message. Makes the message
	// structured.
	Inputs map[string]any
	// OutputSchema is a JSON Schema (at most 32 KB) the turn's output must match. Makes the
	// message structured.
	OutputSchema map[string]any
	// SuccessCriteria is a guideline for a judge, or yes/no checks, the turn is checked against.
	// Makes the message structured.
	SuccessCriteria Criteria
	// IdempotencyKey: the same key again returns the earlier turn and sends nothing.
	IdempotencyKey string
	// RecordTrajectory keeps a screenshot and the action for each step (Turns.Trajectory).
	RecordTrajectory bool
	// ThinkingLevel is the thinking level for the turn this message starts, in place of the
	// account's agent setting. Like RecordTrajectory, it is refused with a ConflictError
	// (`session_busy`) while a turn is running.
	ThinkingLevel ThinkingLevel
	// Autonomous runs the turn this message starts without approval cards, as if "Trust for this
	// task" had been answered; the grant ends with the turn.
	Autonomous bool
}

// WaitOptions are the options of Turn.Wait. Every field is optional; a deadline on the context
// bounds the wait.
type WaitOptions struct {
	OnApproval ApprovalHandler
	// PollWait is how long the server may hold one poll; it caps at 60 seconds. Default 30 s.
	PollWait time.Duration
}

// RunOptions are SendOptions and WaitOptions together, for Session.Run.
type RunOptions struct {
	Model            string
	Attachments      []*Attachment
	Inputs           map[string]any
	OutputSchema     map[string]any
	SuccessCriteria  Criteria
	IdempotencyKey   string
	RecordTrajectory bool
	ThinkingLevel    ThinkingLevel
	Autonomous       bool
	OnApproval       ApprovalHandler
	PollWait         time.Duration
}

// EventsOptions are the options of Turn.Events.
type EventsOptions struct {
	// Raw also yields framing, reasoning and tool-call frames, as EventOther.
	Raw bool
	// PollWait is how long the server may hold one poll; it caps at 60 seconds. Default 30 s.
	PollWait time.Duration
}

// RespondOptions are the options of Respond.
type RespondOptions struct {
	// Selections answers a `choice` approval: one list of option values per question.
	Selections [][]string
}

// SessionsService: conversations with Sai on a computer. Sai decides every click.
type SessionsService struct {
	t        *transport
	machines *MachinesService
}

// Create starts a fresh conversation on a computer: the next message has no memory of earlier
// ones.
func (s *SessionsService) Create(ctx context.Context, opts *SessionOptions) (*Session, error) {
	machineID, err := s.machines.resolveID(ctx, machine(opts))
	if err != nil {
		return nil, err
	}
	session := &Session{t: s.t, MachineID: machineID}
	d, err := s.t.json(ctx, "POST", "/v1/agents/new-session", &request{json: map[string]any{"machineId": machineID, "channel": "api"}})
	if err != nil {
		// A free account's computer between claims has no conversation to rotate; the first
		// message starts one.
		var nf *NotFoundError
		if !errors.As(err, &nf) {
			return nil, err
		}
		return session, nil
	}
	session.ID = str(d["sessionId"])
	return session, nil
}

// List returns the API sessions on a computer, most recent first (up to 20). Active marks the one
// the next message without a session goes to.
func (s *SessionsService) List(ctx context.Context, opts *SessionOptions) ([]*SessionSummary, error) {
	machineID, err := s.machines.resolveID(ctx, machine(opts))
	if err != nil {
		return nil, err
	}
	d, err := s.t.json(ctx, "GET", "/v1/agents/sessions", &request{params: url.Values{"machineId": {machineID}, "channel": {"api"}}})
	if err != nil {
		return nil, err
	}
	out := []*SessionSummary{}
	for _, x := range objs(d["sessions"]) {
		out = append(out, parseSessionSummary(x))
	}
	return out, nil
}

// Resume reattaches to a session started elsewhere, e.g. to poll or abort it.
func (s *SessionsService) Resume(sessionID string, opts *SessionOptions) *Session {
	return &Session{t: s.t, ID: sessionID, MachineID: machine(opts)}
}

func machine(opts *SessionOptions) string {
	if opts == nil {
		return ""
	}
	return opts.Machine
}

// Session is a conversation with Sai. Each Send is a turn; turns share context. ID is empty until
// the first message starts one.
type Session struct {
	ID        string
	MachineID string
	t         *transport
}

// Send gives Sai a task, or steers the running one. It returns at once. Sent while a turn is
// running, the message steers that turn (Turn.Queued is true).
//
// Any of Inputs, OutputSchema or SuccessCriteria makes the message structured: the message is a
// template whose `{{name}}` placeholders are filled from Inputs, the output must match
// OutputSchema, and the turn is checked against SuccessCriteria. Wait then also returns the
// turn's record in TurnResult.Record. A structured message is refused with a ConflictError
// (`session_busy`) while a turn is running.
func (s *Session) Send(ctx context.Context, message string, opts *SendOptions) (*Turn, error) {
	if opts == nil {
		opts = &SendOptions{}
	}
	body := map[string]any{"message": message, "wait": false}
	if s.MachineID != "" {
		body["machineId"] = s.MachineID
	}
	if s.ID != "" {
		body["sessionId"] = s.ID
	}
	if opts.Model != "" {
		body["model"] = opts.Model
	}
	if len(opts.Attachments) > 0 {
		list := make([]any, len(opts.Attachments))
		for i, a := range opts.Attachments {
			if a.Raw != nil {
				list[i] = a.Raw
			} else {
				list[i] = map[string]any{"fileId": a.FileID, "name": a.Name, "mime": a.Mime, "size": a.Size}
			}
		}
		body["attachments"] = list
	}
	if opts.Autonomous {
		body["autonomous"] = true
	}
	options := map[string]any{}
	if opts.Inputs != nil {
		options["inputs"] = opts.Inputs
	}
	if opts.OutputSchema != nil {
		options["output_schema"] = opts.OutputSchema
	}
	if opts.SuccessCriteria != nil {
		options["success_criteria"] = opts.SuccessCriteria.criteria()
	}
	if opts.IdempotencyKey != "" {
		options["idempotency_key"] = opts.IdempotencyKey
	}
	if opts.RecordTrajectory {
		options["recordTrajectory"] = true
	}
	if opts.ThinkingLevel != "" {
		options["thinkingLevel"] = string(opts.ThinkingLevel)
	}
	if len(options) > 0 {
		body["options"] = options
	}
	structured := opts.Inputs != nil || opts.OutputSchema != nil || opts.SuccessCriteria != nil
	d, err := s.t.json(ctx, "POST", "/v1/agents/message", &request{json: body})
	if err != nil {
		return nil, err
	}
	d = obj(d)
	if truthy(d["idempotent_replay"]) {
		// The key was used before: this is that turn, and nothing was sent.
		record := parseTurnRecord(d)
		if record.SessionID != "" {
			s.ID = record.SessionID
		}
		if record.MachineID != "" {
			s.MachineID = record.MachineID
		}
		return &Turn{Session: s, ID: record.ID, t: s.t, structured: structured, replay: record, local: true}, nil
	}
	sessionID, _ := d["sessionId"].(string)
	if sessionID == "" {
		// Handled without starting a task (e.g. a plain acknowledgement): the reply is in `reply`,
		// or in `error` on servers before `reply` existed.
		text, ok := d["reply"].(string)
		if !ok {
			text = str(d["error"])
		}
		return &Turn{Session: s, t: s.t, last: localResult(s.ID, text), local: true}, nil
	}
	s.ID = sessionID
	if m, ok := d["machineId"].(string); ok {
		s.MachineID = m
	}
	return &Turn{Session: s, ID: str(d["turnId"]), Queued: truthy(d["queued"]), t: s.t, structured: structured}, nil
}

// Run is Send then Wait: the answer, or where it stopped.
func (s *Session) Run(ctx context.Context, message string, opts *RunOptions) (*TurnResult, error) {
	if opts == nil {
		opts = &RunOptions{}
	}
	turn, err := s.Send(ctx, message, &SendOptions{
		Model:            opts.Model,
		Attachments:      opts.Attachments,
		Inputs:           opts.Inputs,
		OutputSchema:     opts.OutputSchema,
		SuccessCriteria:  opts.SuccessCriteria,
		IdempotencyKey:   opts.IdempotencyKey,
		RecordTrajectory: opts.RecordTrajectory,
		ThinkingLevel:    opts.ThinkingLevel,
		Autonomous:       opts.Autonomous,
	})
	if err != nil {
		return nil, err
	}
	return turn.Wait(ctx, &WaitOptions{OnApproval: opts.OnApproval, PollWait: opts.PollWait})
}

// Abort stops the running turn. Pending approvals are denied. False if nothing was running.
func (s *Session) Abort(ctx context.Context) (bool, error) {
	if s.ID == "" {
		return false, nil
	}
	d, err := s.t.json(ctx, "POST", "/v1/agents/abort", &request{json: map[string]any{"sessionId": s.ID}})
	if err != nil {
		return false, err
	}
	return truthy(d["aborted"]), nil
}

// Respond answers an approval: `yes` (the default when response is empty), `no`, or `task`
// (allow for the rest of the task). A `choice` approval needs Selections. It returns a
// LinkOnlyApprovalError (with ApprovalURL) when only a browser can answer it, and otherwise
// `approved`, `approved_task` or `denied`.
func (s *Session) Respond(ctx context.Context, approval *Approval, response string, opts *RespondOptions) (string, error) {
	if approval.IsLinkOnly {
		return "", &LinkOnlyApprovalError{ConflictError{SaiError{
			Status:  409,
			Code:    "link_only",
			Message: "This approval must be completed in a browser. Open approval.URL.",
			Body:    map[string]any{"approvalUrl": nullable(approval.URL)},
		}}}
	}
	if response == "" {
		response = "yes"
	}
	body := map[string]any{"approvalId": approval.ID, "response": response}
	if opts != nil && opts.Selections != nil {
		body["selections"] = opts.Selections
	}
	d, err := s.t.json(ctx, "POST", "/v1/agents/approve", &request{json: body})
	if err != nil {
		return "", err
	}
	return str(d["status"]), nil
}

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// Turn is one message's work. Range over Events to watch it, or Wait for the result. ID is the
// turn the message started, or the running turn it joined (Turns.Get); empty when the message
// was answered without one.
type Turn struct {
	ID      string
	Queued  bool
	Session *Session

	t          *transport
	cursor     string
	last       *TurnResult
	structured bool
	replay     *TurnRecord
	// answered without starting a task, or an idempotent replay: no events to poll
	local bool
}

// Status is the last known status: running before the first poll.
func (t *Turn) Status() TurnStatus {
	if t.last == nil {
		return TurnRunning
	}
	return t.last.Status
}

// Result is the last known state, or nil before the first poll.
func (t *Turn) Result() *TurnResult { return t.last }

// Events yields events until the turn is idle or errors. It keeps going through
// `needs_approval`: answer with Turn.Respond inside the loop, or let a human answer a link-only
// approval in a browser. Without Raw, framing, reasoning and tool-call frames are skipped. A
// failed poll is yielded as the error, and ends the sequence.
func (t *Turn) Events(ctx context.Context, opts *EventsOptions) iter.Seq2[*Event, error] {
	if opts == nil {
		opts = &EventsOptions{}
	}
	return func(yield func(*Event, error) bool) {
		if t.local {
			return
		}
		for {
			page, err := t.poll(ctx, pollWait(opts.PollWait))
			if err != nil {
				yield(nil, err)
				return
			}
			for _, e := range objs(page["events"]) {
				ev := parseEvent(e)
				if (opts.Raw || ev.Kind != EventOther) && !yield(ev, nil) {
					return
				}
			}
			if st := str(page["status"]); st == string(TurnIdle) || st == string(TurnError) {
				return
			}
		}
	}
}

// Wait waits until the turn is done, or stops on an approval nobody answered. Without
// OnApproval, it returns with Status `needs_approval` and the Approval so the caller can decide.
// With it, the handler's answer is sent and waiting continues; a handler returning nil leaves the
// approval to someone else (a link-only one to a human) and keeps waiting. For a structured
// message, it then waits for the turn's record (TurnResult.Record: output, evidence), which is
// worked out after the turn.
func (t *Turn) Wait(ctx context.Context, opts *WaitOptions) (*TurnResult, error) {
	if opts == nil {
		opts = &WaitOptions{}
	}
	if t.replay != nil {
		record := t.replay
		if !record.Done {
			var err error
			if record, err = waitTurnRecord(ctx, t.t, record.ID, []TurnRecordStatus{RecordSucceeded, RecordFailed}); err != nil {
				return nil, err
			}
		}
		sessionID := record.SessionID
		if sessionID == "" {
			sessionID = t.Session.ID
		}
		t.last = replayResult(record, sessionID)
		return t.last, nil
	}
	if t.local {
		return t.last, nil
	}
	answered := map[string]bool{}
	for {
		wait := pollWait(opts.PollWait)
		if deadline, ok := ctx.Deadline(); ok {
			left := time.Until(deadline)
			if left <= 0 {
				return nil, fmt.Errorf("turn still %s (session %s): %w", t.Status(), t.Session.ID, context.DeadlineExceeded)
			}
			wait = max(time.Second, min(wait, left.Truncate(time.Second)))
		}
		page, err := t.poll(ctx, wait)
		if err != nil {
			return nil, err
		}
		status := str(page["status"])
		if status == string(TurnIdle) || status == string(TurnError) {
			if t.structured && t.ID != "" {
				record, err := waitTurnRecord(ctx, t.t, t.ID, []TurnRecordStatus{RecordSucceeded, RecordFailed})
				if err != nil {
					return nil, err
				}
				t.last = withRecord(t.last, record)
			}
			return t.last, nil
		}
		approval := t.last.Approval
		if status != string(TurnNeedsApproval) || approval == nil {
			continue
		}
		if opts.OnApproval == nil {
			return t.last, nil
		}
		if answered[approval.ID] {
			continue
		}
		answer := opts.OnApproval(approval)
		answered[approval.ID] = true
		if answer == nil {
			continue
		}
		if _, err := t.Session.Respond(ctx, approval, answer.Response, &RespondOptions{Selections: answer.Selections}); err != nil {
			// answered elsewhere or expired; the next poll shows the new state
			var conflict *ConflictError
			if !errors.As(err, &conflict) {
				return nil, err
			}
		}
	}
}

// Respond answers an approval on the turn's session; see Session.Respond.
func (t *Turn) Respond(ctx context.Context, approval *Approval, response string, opts *RespondOptions) (string, error) {
	return t.Session.Respond(ctx, approval, response, opts)
}

// Abort stops the turn's session; see Session.Abort.
func (t *Turn) Abort(ctx context.Context) (bool, error) {
	return t.Session.Abort(ctx)
}

func pollWait(d time.Duration) time.Duration {
	if d <= 0 {
		return defaultPollWait
	}
	return d
}

func (t *Turn) poll(ctx context.Context, wait time.Duration) (map[string]any, error) {
	var page map[string]any
	for {
		params := url.Values{"sessionId": {t.Session.ID}, "wait": {strconv.FormatFloat(wait.Seconds(), 'f', -1, 64)}}
		if t.cursor != "" {
			params.Set("since", t.cursor)
		}
		d, err := t.t.json(ctx, "GET", "/v1/agents/events", &request{params: params, timeout: wait + 30*time.Second})
		if err == nil {
			page = obj(d)
			break
		}
		if err := sleepAfterRateLimit(ctx, err); err != nil {
			return nil, err
		}
	}
	if c, ok := page["cursor"].(string); ok {
		t.cursor = c
	}
	var errText, errCode string
	if t.last != nil {
		errText, errCode = t.last.Error, t.last.ErrorCode
	}
	for _, e := range objs(page["events"]) {
		if e["type"] == "error" {
			if s, ok := e["errorText"].(string); ok {
				errText = s
			}
			if s, ok := e["code"].(string); ok {
				errCode = s
			}
		}
	}
	status := TurnStatus(str(page["status"]))
	if status == "" {
		status = TurnRunning
	}
	sessionID, ok := page["sessionId"].(string)
	if !ok {
		sessionID = t.Session.ID
	}
	var approval *Approval
	if a, ok := page["approval"].(map[string]any); ok {
		approval = parseApproval(a)
	}
	t.last = &TurnResult{
		Status:       status,
		Text:         str(page["text"]),
		SessionID:    sessionID,
		Approval:     approval,
		Error:        errText,
		ErrorCode:    errCode,
		Usage:        parseUsage(page["usage"]),
		SessionUsage: parseUsage(page["sessionUsage"]),
		OK:           status == TurnIdle,
	}
	return page, nil
}

// sleepAfterRateLimit waits out a RateLimitError, and returns any other error as is.
func sleepAfterRateLimit(ctx context.Context, err error) error {
	var rl *RateLimitError
	if !errors.As(err, &rl) {
		return err
	}
	wait := defaultRetryAfter
	if rl.RetryAfter != nil {
		wait = *rl.RetryAfter
	}
	return sleep(ctx, wait)
}

func sleep(ctx context.Context, d time.Duration) error {
	if d <= 0 {
		return ctx.Err()
	}
	timer := time.NewTimer(d)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-timer.C:
		return nil
	}
}

// waitTurnRecord reads the turn's record until its status is in stop. It fails with
// context.DeadlineExceeded rather than sleep past the context's deadline.
func waitTurnRecord(ctx context.Context, t *transport, turnID string, stop []TurnRecordStatus) (*TurnRecord, error) {
	for {
		d, err := t.json(ctx, "GET", "/v1/agents/turns/"+esc(turnID), nil)
		if err != nil {
			if err := sleepAfterRateLimit(ctx, err); err != nil {
				return nil, err
			}
			continue
		}
		record := parseTurnRecord(obj(d))
		if slices.Contains(stop, record.Status) {
			return record, nil
		}
		if deadline, ok := ctx.Deadline(); ok && time.Now().Add(recordPollInterval).After(deadline) {
			return nil, fmt.Errorf("turn %s still %s: %w", turnID, record.Status, context.DeadlineExceeded)
		}
		if err := sleep(ctx, recordPollInterval); err != nil {
			return nil, err
		}
	}
}

func withRecord(result *TurnResult, record *TurnRecord) *TurnResult {
	r := *result
	r.Record = record
	r.OK = result.Status == TurnIdle && record.OK
	return &r
}

// A turn that failed for these reasons still has the agent's answer; the turn itself did not
// break.
var answeredReasons = []string{"output_invalid", "criteria_not_met", "criteria_unchecked"}

// replayResult is the result the live path would have returned for this finished turn, from its
// record.
func replayResult(record *TurnRecord, sessionID string) *TurnResult {
	text := record.RawAnswer
	if text == "" {
		text = outputText(record.Output)
	}
	result := localResult(sessionID, text)
	if record.Status == RecordFailed && !slices.Contains(answeredReasons, record.ReasonCode) {
		result.Status = TurnError
		result.OK = false
		result.Text = ""
		result.Error = record.RawAnswer
		if result.Error == "" {
			reason := record.ReasonCode
			if reason == "" {
				reason = "unknown"
			}
			result.Error = fmt.Sprintf("The turn failed (%s).", reason)
		}
		result.ErrorCode = record.ErrorCode
	}
	result.Usage = record.Usage
	return withRecord(result, record)
}

// outputText is output as text: a plain message's answer as is, an OutputSchema object as JSON.
func outputText(output any) string {
	switch x := output.(type) {
	case nil:
		return ""
	case string:
		return x
	default:
		return stringify(x)
	}
}

func localResult(sessionID, text string) *TurnResult {
	return &TurnResult{Status: TurnIdle, Text: text, SessionID: sessionID, OK: true}
}
