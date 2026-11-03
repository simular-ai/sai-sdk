package sai_test

// The shared conformance suite (../conformance/README.md): each case's steps become calls on this
// SDK, against the mock server, which checks the requests and the outcomes.

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"

	sai "github.com/simular-ai/sai-sdk/go"
)

type step struct {
	Call string         `json:"call"`
	Args map[string]any `json:"args"`
	Save string         `json:"save"`
	Pick *string        `json:"pick"`
}

type conformanceCase struct {
	ID     string `json:"id"`
	Client struct {
		APIKey     *string `json:"api_key"`
		OrgID      string  `json:"org_id"`
		VersionTag string  `json:"version_tag"`
	} `json:"client"`
	Steps []step `json:"steps"`
}

func loadCases(t *testing.T) []conformanceCase {
	files, err := filepath.Glob("../conformance/cases/*.json")
	if err != nil || len(files) == 0 {
		t.Fatalf("no cases: %v", err)
	}
	slices.Sort(files)
	var out []conformanceCase
	for _, f := range files {
		data, err := os.ReadFile(f)
		if err != nil {
			t.Fatal(err)
		}
		var file struct {
			Cases []conformanceCase `json:"cases"`
		}
		if err := json.Unmarshal(data, &file); err != nil {
			t.Fatalf("%s: %v", f, err)
		}
		out = append(out, file.Cases...)
	}
	return out
}

func TestConformance(t *testing.T) {
	url := mock(t)
	// As in the other runners, an org_id the case leaves out is no org id.
	t.Setenv("SAI_ORG_ID", "")
	for _, c := range loadCases(t) {
		t.Run(c.ID, func(t *testing.T) {
			control(t, "start", map[string]any{"case": c.ID})
			key := "sapi_test"
			if c.Client.APIKey != nil {
				key = *c.Client.APIKey
			}
			client, err := sai.New(sai.Options{APIKey: key, BaseURL: url, OrgID: c.Client.OrgID, VersionTag: c.Client.VersionTag})
			if err != nil {
				t.Fatal(err)
			}
			// No deadline: a deadline caps the poll waits, and the cases expect the defaults.
			ctx := context.Background()
			saved := map[string]any{"client": client}
			for index, s := range c.Steps {
				outcome := map[string]any{"index": index}
				value, err := invoke(ctx, saved, s)
				if err != nil {
					outcome["error"] = projectError(err)
				} else {
					outcome["result"] = project(value)
					if s.Save != "" {
						if s.Pick != nil {
							value = pick(value, *s.Pick)
						}
						saved[s.Save] = value
					}
				}
				control(t, "step", outcome)
			}
			failures, _ := control(t, "finish", map[string]any{})["failures"].([]any)
			for _, f := range failures {
				t.Error(f)
			}
		})
	}
}

// ─── Calls ───────────────────────────────────────────────────────────────────

type args map[string]any

func invoke(ctx context.Context, saved map[string]any, s step) (any, error) {
	parts := strings.Split(s.Call, ".")
	target, rest := saved["client"], parts
	if v, ok := saved[parts[0]]; ok && parts[0] != "client" {
		target, rest = v, parts[1:]
	}
	a := args(resolve(saved, map[string]any(s.Args)).(map[string]any))
	if a == nil {
		a = args{}
	}
	method := strings.Join(rest, ".")
	switch x := target.(type) {
	case *sai.Client:
		return callClient(ctx, x, method, a)
	case *sai.Session:
		return callSession(ctx, x, method, a)
	case *sai.Turn:
		return callTurn(ctx, x, method, a)
	case *sai.ControlLease:
		return callLease(ctx, x, method, a)
	}
	return nil, fmt.Errorf("no target for %s", s.Call)
}

// resolve replaces `{ "$ref": name }` with the saved object, everywhere in the arguments.
func resolve(saved map[string]any, v any) any {
	switch x := v.(type) {
	case []any:
		out := make([]any, len(x))
		for i, e := range x {
			out[i] = resolve(saved, e)
		}
		return out
	case map[string]any:
		if ref, ok := x["$ref"].(string); ok {
			return saved[ref]
		}
		if x == nil {
			return map[string]any{}
		}
		out := map[string]any{}
		for k, e := range x {
			out[k] = resolve(saved, e)
		}
		return out
	}
	return v
}

func (a args) has(k string) bool { _, ok := a[k]; return ok }
func (a args) str(k string) string {
	s, _ := a[k].(string)
	return s
}
func (a args) int(k string) int {
	f, _ := a[k].(float64)
	return int(f)
}
func (a args) bool(k string) bool {
	b, _ := a[k].(bool)
	return b
}
func (a args) obj(k string) map[string]any {
	m, _ := a[k].(map[string]any)
	return m
}
func (a args) seconds(k string) time.Duration {
	f, _ := a[k].(float64)
	return time.Duration(f * float64(time.Second))
}
func (a args) ms(k string) time.Duration {
	f, _ := a[k].(float64)
	return time.Duration(f * float64(time.Millisecond))
}

// id is an id string, or the ID of a saved object.
func id(v any) string {
	if s, ok := v.(string); ok {
		return s
	}
	rv := reflect.ValueOf(v)
	if !rv.IsValid() || rv.Kind() == reflect.Pointer && rv.IsNil() {
		return ""
	}
	return reflect.Indirect(rv).FieldByName("ID").String()
}

func ids(v any) []string {
	list, _ := v.([]any)
	out := []string{}
	for _, x := range list {
		out = append(out, id(x))
	}
	return out
}

func strMap(v any) map[string]string {
	m, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	out := map[string]string{}
	for k, x := range m {
		out[k], _ = x.(string)
	}
	return out
}

func criteria(v any) sai.Criteria {
	if s, ok := v.(string); ok {
		return sai.CriteriaText(s)
	}
	checks := sai.Checks{}
	for _, x := range v.([]any) {
		c := x.(map[string]any)
		check := sai.Check{ID: c["id"].(string), Check: c["check"].(string)}
		check.ReturnEvidence, _ = c["return_evidence"].(bool)
		checks = append(checks, check)
	}
	return checks
}

func selections(v any) [][]string {
	list, ok := v.([]any)
	if !ok {
		return nil
	}
	out := [][]string{}
	for _, q := range list {
		values := []string{}
		for _, x := range q.([]any) {
			values = append(values, x.(string))
		}
		out = append(out, values)
	}
	return out
}

func approval(v any) *sai.Approval {
	if a, ok := v.(*sai.Approval); ok {
		return a
	}
	return &sai.Approval{ID: id(v)}
}

func sendOpts(a args) *sai.SendOptions {
	o := &sai.SendOptions{
		Model:            a.str("model"),
		Inputs:           a.obj("inputs"),
		OutputSchema:     a.obj("output_schema"),
		IdempotencyKey:   a.str("idempotency_key"),
		RecordTrajectory: a.bool("record_trajectory"),
		ThinkingLevel:    sai.ThinkingLevel(a.str("thinking_level")),
		Autonomous:       a.bool("autonomous"),
	}
	if list, ok := a["attachments"].([]any); ok {
		for _, x := range list {
			o.Attachments = append(o.Attachments, x.(*sai.Attachment))
		}
	}
	if a.has("success_criteria") {
		o.SuccessCriteria = criteria(a["success_criteria"])
	}
	return o
}

func waitOpts(a args) *sai.WaitOptions {
	o := &sai.WaitOptions{PollWait: a.seconds("poll_wait")}
	if h, ok := a["on_approval"].(map[string]any); ok {
		answers, _ := h["answers"].([]any)
		o.OnApproval = func(*sai.Approval) *sai.ApprovalAnswer {
			if len(answers) == 0 {
				return nil
			}
			next := answers[0]
			answers = answers[1:]
			switch x := next.(type) {
			case string:
				return &sai.ApprovalAnswer{Response: x}
			case []any:
				return &sai.ApprovalAnswer{Response: x[0].(string), Selections: selections(x[1])}
			}
			return nil
		}
	}
	return o
}

func callClient(ctx context.Context, c *sai.Client, method string, a args) (any, error) {
	switch method {
	case "machines.list":
		return c.Machines.List(ctx)
	case "machines.get":
		return c.Machines.Get(ctx, a.str("machine_id"))
	case "machines.live":
		return c.Machines.Live(ctx, id(a["machine"]))
	case "machines.revoke_live":
		return c.Machines.RevokeLive(ctx, id(a["machine"]))
	case "sessions.create":
		return c.Sessions.Create(ctx, &sai.SessionOptions{Machine: id(a["machine"])})
	case "sessions.resume":
		return c.Sessions.Resume(a.str("session_id"), &sai.SessionOptions{Machine: id(a["machine"])}), nil
	case "sessions.list":
		return c.Sessions.List(ctx, &sai.SessionOptions{Machine: id(a["machine"])})
	case "turns.get":
		return c.Turns.Get(ctx, id(a["turn"]))
	case "turns.wait":
		return c.Turns.Wait(ctx, id(a["turn"]))
	case "turns.trajectory":
		return c.Turns.Trajectory(ctx, id(a["turn"]))
	case "turns.screenshot":
		return c.Turns.Screenshot(ctx, id(a["turn"]), a.int("index"))
	case "learn.create":
		o := &sai.LearnOptions{
			TaskTemplate:         a.str("task_template"),
			Inputs:               a.obj("inputs"),
			InitialCode:          a.str("initial_code"),
			Guidance:             a.str("guidance"),
			History:              a.str("history"),
			RunsWithoutReset:     a.bool("runs_without_reset"),
			MaxIterations:        a.int("max_iterations"),
			Rollouts:             a.int("rollouts"),
			Machine:              id(a["machine"]),
			JudgeInitialAgentRun: a.bool("judge_initial_agent_run"),
			ContinueWithAgent:    a.bool("continue_with_agent"),
			RolloutMinutes:       a.int("rollout_minutes"),
			AgentRunMinutes:      a.int("agent_run_minutes"),
			ContinuationMinutes:  a.int("continuation_minutes"),
			MaxJobMinutes:        a.int("max_job_minutes"),
			Model:                a.str("model"),
			IdempotencyKey:       a.str("idempotency_key"),
		}
		if a.has("criteria") {
			o.Criteria = criteria(a["criteria"])
		}
		if r := a.obj("reset"); r != nil {
			o.Reset = &sai.ResetAction{Code: args(r).str("code"), Task: args(r).str("task")}
		}
		if list, ok := a["evaluations"].([]any); ok {
			o.Evaluations = []sai.Evaluation{}
			for _, x := range list {
				e := args(x.(map[string]any))
				ev := sai.Evaluation{Inputs: e.obj("inputs"), Judgement: e.str("judgement"), Note: e.str("note")}
				ev.Result, _ = e["result"].(*sai.ExecResult)
				if e.has("passed") {
					passed := e.bool("passed")
					ev.Passed = &passed
				}
				o.Evaluations = append(o.Evaluations, ev)
			}
		}
		return c.Learn.Create(ctx, ids(a["turns"]), o)
	case "learn.get":
		return c.Learn.Get(ctx, a.str("learn_id"))
	case "learn.wait":
		return c.Learn.Wait(ctx, id(a["job"]), &sai.LearnWaitOptions{PollInterval: a.ms("poll_ms")})
	case "learn.cancel":
		return nil, c.Learn.Cancel(ctx, id(a["job"]))
	case "learn.rollout":
		return c.Learn.Rollout(ctx, id(a["job"]), a.int("iteration"), a.int("rollout"))
	case "judge.create":
		return c.Judge.Create(ctx, ids(a["turns"]), criteria(a["criteria"]), &sai.JudgeOptions{Task: a.str("task"), IdempotencyKey: a.str("idempotency_key")})
	case "judge.get":
		return c.Judge.Get(ctx, a.str("judgement_id"))
	case "control.open":
		return c.Control.Open(ctx, id(a["machine"]))
	case "models.list":
		return c.Models.List(ctx)
	case "files.upload":
		data, err := base64.StdEncoding.DecodeString(a.str("data_base64"))
		if err != nil {
			return nil, err
		}
		return c.Files.Upload(ctx, a.str("name"), bytes.NewReader(data))
	case "account.get":
		return c.Account.Get(ctx)
	case "auth.check":
		return c.Auth.Check(ctx)
	case "usage.get":
		return c.Usage.Get(ctx, &sai.UsageOptions{Granularity: a.str("granularity"), From: a.str("from"), To: a.str("to"), OrgID: a.str("org_id")})
	case "usage.sessions":
		return c.Usage.Sessions(ctx, id(a["tenant"]), &sai.UsageSessionsOptions{From: a.str("from"), To: a.str("to"), Limit: a.int("limit"), Cursor: a.str("cursor"), OrgID: a.str("org_id")})
	case "tenants.create":
		return c.Tenants.Create(ctx, a.str("name"), &sai.TenantCreateOptions{ExternalID: a.str("external_id"), Metadata: strMap(a["metadata"])})
	case "tenants.list":
		return c.Tenants.List(ctx, &sai.TenantListOptions{Status: a.str("status"), ExternalID: a.str("external_id"), Limit: a.int("limit"), Cursor: a.str("cursor")})
	case "tenants.get":
		return c.Tenants.Get(ctx, id(a["tenant"]))
	case "tenants.update":
		o := &sai.TenantUpdateOptions{Name: a.str("name"), Metadata: strMap(a["metadata"]), Status: a.str("status")}
		if a.has("cloud_machine_limit") {
			if a["cloud_machine_limit"] == nil {
				o.ClearCloudMachineLimit = true
			} else {
				limit := a.int("cloud_machine_limit")
				o.CloudMachineLimit = &limit
			}
		}
		if a.has("residential_proxy") {
			proxy := a.bool("residential_proxy")
			o.ResidentialProxy = &proxy
		}
		return c.Tenants.Update(ctx, id(a["tenant"]), o)
	case "tenants.delete":
		return nil, c.Tenants.Delete(ctx, id(a["tenant"]))
	case "tenants.create_enrollment":
		return c.Tenants.CreateEnrollment(ctx, id(a["tenant"]))
	case "tenants.token":
		return c.Tenants.Token(ctx, id(a["tenant"]), &sai.TenantTokenOptions{OrgID: a.str("org_id")})
	case "tenants.client":
		return c.Tenants.Client(ctx, id(a["tenant"]), &sai.TenantTokenOptions{OrgID: a.str("org_id")})
	case "tenant_machines.create":
		return c.TenantMachines.Create(ctx, id(a["tenant"]), &sai.TenantMachineCreateOptions{OS: a.str("os"), Name: a.str("name"), RequestID: a.str("request_id"), Wait: a.bool("wait")})
	case "tenant_machines.list":
		return c.TenantMachines.List(ctx, id(a["tenant"]))
	case "tenant_machines.get":
		return c.TenantMachines.Get(ctx, id(a["tenant"]), a.str("machine_id"))
	case "tenant_machines.delete":
		return c.TenantMachines.Delete(ctx, id(a["tenant"]), id(a["machine"]))
	case "tenant_machines.revoke":
		return nil, c.TenantMachines.Revoke(ctx, id(a["tenant"]), id(a["machine"]))
	}
	return nil, fmt.Errorf("unknown call client.%s", method)
}

func callSession(ctx context.Context, s *sai.Session, method string, a args) (any, error) {
	switch method {
	case "send":
		return s.Send(ctx, a.str("message"), sendOpts(a))
	case "run":
		so, wo := sendOpts(a), waitOpts(a)
		return s.Run(ctx, a.str("message"), &sai.RunOptions{
			Model: so.Model, Attachments: so.Attachments, Inputs: so.Inputs, OutputSchema: so.OutputSchema,
			SuccessCriteria: so.SuccessCriteria, IdempotencyKey: so.IdempotencyKey, RecordTrajectory: so.RecordTrajectory,
			ThinkingLevel: so.ThinkingLevel, Autonomous: so.Autonomous, OnApproval: wo.OnApproval, PollWait: wo.PollWait,
		})
	case "abort":
		return s.Abort(ctx)
	case "respond":
		return s.Respond(ctx, approval(a["approval"]), a.str("response"), &sai.RespondOptions{Selections: selections(a["selections"])})
	}
	return nil, fmt.Errorf("unknown call Session.%s", method)
}

func callTurn(ctx context.Context, t *sai.Turn, method string, a args) (any, error) {
	switch method {
	case "events":
		out := []*sai.Event{}
		for ev, err := range t.Events(ctx, &sai.EventsOptions{Raw: a.bool("raw"), PollWait: a.seconds("poll_wait")}) {
			if err != nil {
				return nil, err
			}
			out = append(out, ev)
		}
		return out, nil
	case "wait":
		return t.Wait(ctx, waitOpts(a))
	case "respond":
		return t.Respond(ctx, approval(a["approval"]), a.str("response"), &sai.RespondOptions{Selections: selections(a["selections"])})
	case "abort":
		return t.Abort(ctx)
	}
	return nil, fmt.Errorf("unknown call Turn.%s", method)
}

func callLease(ctx context.Context, l *sai.ControlLease, method string, a args) (any, error) {
	switch method {
	case "exec":
		return l.Exec(ctx, a.str("code"), &sai.ExecOptions{Timeout: a.ms("timeout_ms")})
	case "run":
		learned, ok := a["learned"].(*sai.LearnResult)
		if !ok {
			learned = &sai.LearnResult{Code: a.str("learned")}
		}
		return l.Run(ctx, learned, a.obj("inputs"), &sai.ExecOptions{Timeout: a.ms("timeout_ms")})
	case "shell":
		return l.Shell(ctx, a.str("command"), &sai.ShellOptions{Cwd: a.str("cwd"), Timeout: a.ms("timeout_ms")})
	case "read_file":
		return l.ReadFile(ctx, a.str("path"))
	case "write_file":
		return nil, l.WriteFile(ctx, a.str("path"), a.str("text"))
	case "screenshot":
		return l.Screenshot(ctx)
	case "interrupt":
		return l.Interrupt(ctx)
	case "get":
		v, err := l.Get(ctx)
		return opaque{v}, err
	case "close":
		return nil, l.Close(ctx)
	}
	return nil, fmt.Errorf("unknown call ControlLease.%s", method)
}

// ─── Projection ──────────────────────────────────────────────────────────────

// opaque is free-form JSON a call returned: projected as is.
type opaque struct{ value any }

func nullable(s string) any {
	if s == "" {
		return nil
	}
	return s
}

// project turns a result into the suite's JSON: the json tag names (snake_case), Raw left out,
// nil and empty omitempty fields as null, bytes as `{ "$base64": … }`, maps with their keys as
// they are.
func project(v any) any {
	switch x := v.(type) {
	case nil:
		return nil
	case opaque:
		return x.value
	case []byte:
		if x == nil {
			return nil
		}
		return map[string]any{"$base64": base64.StdEncoding.EncodeToString(x)}
	case *sai.Client:
		return map[string]any{}
	case *sai.Session:
		return map[string]any{"id": nullable(x.ID), "machine_id": nullable(x.MachineID)}
	case *sai.Turn:
		return map[string]any{"id": nullable(x.ID), "queued": x.Queued, "status": string(x.Status())}
	case *sai.ControlLease:
		return map[string]any{"machine_id": x.MachineID, "idle_timeout_sec": x.IdleTimeoutSec}
	}
	rv := reflect.ValueOf(v)
	switch rv.Kind() {
	case reflect.Pointer, reflect.Interface:
		if rv.IsNil() {
			return nil
		}
		return project(rv.Elem().Interface())
	case reflect.Struct:
		out := map[string]any{}
		for i := 0; i < rv.NumField(); i++ {
			f := rv.Type().Field(i)
			name, opts, _ := strings.Cut(f.Tag.Get("json"), ",")
			if !f.IsExported() || name == "-" || name == "" {
				continue
			}
			if opts == "omitempty" && rv.Field(i).IsZero() {
				out[name] = nil
			} else {
				out[name] = project(rv.Field(i).Interface())
			}
		}
		return out
	case reflect.Slice:
		out := make([]any, rv.Len())
		for i := range out {
			out[i] = project(rv.Index(i).Interface())
		}
		return out
	case reflect.Map:
		if rv.IsNil() {
			return nil
		}
		out := map[string]any{}
		for _, k := range rv.MapKeys() {
			out[k.String()] = project(rv.MapIndex(k).Interface())
		}
		return out
	case reflect.String:
		return rv.String()
	}
	return v
}

// pick follows a dotted path of snake_case field names and list indexes.
func pick(v any, path string) any {
	for _, part := range strings.Split(path, ".") {
		rv := reflect.Indirect(reflect.ValueOf(v))
		if rv.Kind() == reflect.Slice {
			i, _ := strconv.Atoi(part)
			v = rv.Index(i).Interface()
			continue
		}
		for i := 0; i < rv.NumField(); i++ {
			if name, _, _ := strings.Cut(rv.Type().Field(i).Tag.Get("json"), ","); name == part {
				v = rv.Field(i).Interface()
				break
			}
		}
	}
	return v
}

func projectError(err error) map[string]any {
	var base *sai.SaiError
	if !errors.As(err, &base) {
		return map[string]any{"class": "Error", "message": err.Error()}
	}
	out := map[string]any{
		"class":       reflect.TypeOf(err).Elem().Name(),
		"status":      base.Status,
		"code":        nullable(base.Code),
		"message":     base.Message,
		"retry_after": nil,
		"body":        base.Body,
	}
	if base.RetryAfter != nil {
		out["retry_after"] = base.RetryAfter.Seconds()
	}
	var link *sai.LinkOnlyApprovalError
	if errors.As(err, &link) {
		out["approval_url"] = nullable(link.ApprovalURL())
	}
	var spend *sai.SpendCapReachedError
	if errors.As(err, &spend) {
		out["resets_at"] = nullable(spend.ResetsAt())
	}
	var block *sai.BlockError
	if errors.As(err, &block) {
		out["kind"] = block.Kind
	}
	return out
}
