package sai

import (
	"context"
	"fmt"
	"time"
)

// Learn and judge (research preview): turn recorded turns, or a task the agent does first, into
// Simulang code you own; repair that code; run, judge and repair it on a machine until it passes
// (policy iteration); and judge turns against criteria you choose now. Maps to /v1/agents/learn
// and /v1/agents/judge.

const (
	// A conversion is two model calls of up to a minute or two each, plus one retry.
	learnTimeout = 600 * time.Second
	judgeTimeout = 180 * time.Second
	// The last log lines of a run sent with an evaluation; the API takes 20 KB per result.
	evalLogLines = 30
	// How often Wait reads a learn job; a job's steps take tens of seconds to minutes.
	learnPollInterval = 10 * time.Second
)

// ResetAction runs before the agent run and before every run of the code: Simulang Code, or a
// Task for the agent. Set one.
type ResetAction struct {
	Code string
	Task string
}

// LearnOptions are the options of Learn.Create. Every field is optional.
type LearnOptions struct {
	// TaskTemplate is the task, with `{{name}}` placeholders. Without turns, the agent does this
	// task first. With turns, it defaults to the first turn's.
	TaskTemplate string
	// Inputs has a value for every placeholder; with turns, defaults to the first turn's.
	Inputs map[string]any
	// InitialCode is code to repair (with MaxIterations 0), or to start the run-judge-repair loop
	// from.
	InitialCode string
	// Evaluations is how InitialCode did on runs (a repair only).
	Evaluations []Evaluation
	// Guidance is what you know about the task, for writing and repairing the code.
	Guidance string
	// History is, for a repair, what earlier versions of the code changed and how they failed.
	History string
	// RunsWithoutReset: the code will be run again and again with no reset in between, so it
	// opens the app or URL itself instead of assuming the screen it starts on.
	RunsWithoutReset bool
	// MaxIterations is how many code versions to run, judge and repair: 0 (the default) only
	// writes the code; 3 allows up to two repairs. At most 5.
	MaxIterations int
	// Rollouts is runs per code version; a version passes when all of them pass. Default 3.
	Rollouts int
	// Machine is the machine to run on; optional with one machine.
	Machine string
	// Criteria is what "done" means for the judge; default: the task as written, with its inputs.
	Criteria Criteria
	Reset    *ResetAction
	// JudgeInitialAgentRun judges the agent run first; if it fails, the job stops with the
	// judgement and writes no code.
	JudgeInitialAgentRun bool
	// ContinueWithAgent lets the agent finish the task after a failed run; its turn feeds the
	// repair.
	ContinueWithAgent bool
	// RolloutMinutes limits each run of the code. Default 15.
	RolloutMinutes int
	// AgentRunMinutes limits the agent run and each reset task. Default 15.
	AgentRunMinutes int
	// ContinuationMinutes limits each continuation. Default 15.
	ContinuationMinutes int
	// MaxJobMinutes limits the whole job. Default 615, at most 690.
	MaxJobMinutes int
	// Model is a model id from Models.List; without it, Sai picks the model.
	Model string
	// IdempotencyKey: the same key again returns the earlier result and runs nothing.
	IdempotencyKey string
}

// LearnWaitOptions are the options of Learn.Wait.
type LearnWaitOptions struct {
	// PollInterval is how often the job is read. Default 10 seconds.
	PollInterval time.Duration
}

// LearnService makes Simulang code from turns, and repairs it.
type LearnService struct{ t *transport }

func evaluationJSON(e Evaluation) map[string]any {
	out := map[string]any{"inputs": e.Inputs}
	if r := e.Result; r != nil {
		logs := r.Logs
		if len(logs) > evalLogLines {
			logs = logs[len(logs)-evalLogLines:]
		}
		result := map[string]any{"result": r.Result, "logs": logs}
		if r.Error != nil {
			result["error"] = map[string]any{"kind": r.Error.Kind, "message": r.Error.Message}
		}
		out["result"] = result
	}
	if e.Judgement != "" {
		out["judgement"] = e.Judgement
	}
	if e.Passed != nil {
		out["passed"] = *e.Passed
	}
	if e.Note != "" {
		out["note"] = e.Note
	}
	return out
}

// Create makes Simulang code, and optionally runs, judges and repairs it on a machine.
//
//   - Create(ctx, turns, nil): code from recorded turns (ordered, one session, each sent with
//     RecordTrajectory). Returns with the code; a longer task takes longer.
//   - Create(ctx, nil, &LearnOptions{InitialCode, Guidance or Evaluations}): a repair.
//   - With MaxIterations: a job on the machine (from turns, or after the agent does
//     TaskTemplate). Returns at once with Status `running`; read it with Wait.
//
// A result with Validation.Errors comes back `failed`.
func (s *LearnService) Create(ctx context.Context, turns []string, opts *LearnOptions) (*LearnResult, error) {
	if opts == nil {
		opts = &LearnOptions{}
	}
	for _, t := range turns {
		if t == "" {
			return nil, errNoTurnID
		}
	}
	if turns == nil {
		turns = []string{}
	}
	body := map[string]any{"turns": turns}
	set := func(key string, v any, ok bool) {
		if ok {
			body[key] = v
		}
	}
	set("taskTemplate", opts.TaskTemplate, opts.TaskTemplate != "")
	set("inputs", opts.Inputs, opts.Inputs != nil)
	set("initialCode", opts.InitialCode, opts.InitialCode != "")
	if opts.Evaluations != nil {
		list := make([]any, len(opts.Evaluations))
		for i, e := range opts.Evaluations {
			list[i] = evaluationJSON(e)
		}
		body["evaluations"] = list
	}
	set("guidance", opts.Guidance, opts.Guidance != "")
	set("machineId", opts.Machine, opts.Machine != "")
	set("history", opts.History, opts.History != "")
	set("runsWithoutReset", true, opts.RunsWithoutReset)
	set("maxIterations", opts.MaxIterations, opts.MaxIterations != 0)
	set("rollouts", opts.Rollouts, opts.Rollouts != 0)
	if opts.Criteria != nil {
		body["criteria"] = opts.Criteria.criteria()
	}
	if r := opts.Reset; r != nil {
		if r.Task != "" {
			body["reset"] = map[string]any{"task": r.Task}
		} else {
			body["reset"] = map[string]any{"code": r.Code}
		}
	}
	set("judgeInitialAgentRun", true, opts.JudgeInitialAgentRun)
	set("continueWithAgent", true, opts.ContinueWithAgent)
	set("rolloutMinutes", opts.RolloutMinutes, opts.RolloutMinutes != 0)
	set("agentRunMinutes", opts.AgentRunMinutes, opts.AgentRunMinutes != 0)
	set("continuationMinutes", opts.ContinuationMinutes, opts.ContinuationMinutes != 0)
	set("maxJobMinutes", opts.MaxJobMinutes, opts.MaxJobMinutes != 0)
	set("model", opts.Model, opts.Model != "")
	set("idempotency_key", opts.IdempotencyKey, opts.IdempotencyKey != "")
	d, err := s.t.json(ctx, "POST", "/v1/agents/learn", &request{json: body, timeout: learnTimeout})
	if err != nil {
		return nil, err
	}
	return parseLearnResult(obj(d)), nil
}

// Get returns a learn call's result, or a job's progress so far.
func (s *LearnService) Get(ctx context.Context, learnID string) (*LearnResult, error) {
	d, err := s.t.json(ctx, "GET", "/v1/agents/learn/"+esc(learnID), nil)
	if err != nil {
		return nil, err
	}
	return parseLearnResult(obj(d)), nil
}

// Wait reads a learn job until it ends (`succeeded`, `failed` or `stopped`). A deadline on the
// context bounds the wait; the job keeps running.
func (s *LearnService) Wait(ctx context.Context, learnID string, opts *LearnWaitOptions) (*LearnResult, error) {
	poll := learnPollInterval
	if opts != nil && opts.PollInterval > 0 {
		poll = opts.PollInterval
	}
	for {
		r, err := s.Get(ctx, learnID)
		if err != nil {
			if err := sleepAfterRateLimit(ctx, err); err != nil {
				return nil, err
			}
			continue
		}
		if r.Status != "running" {
			return r, nil
		}
		if deadline, ok := ctx.Deadline(); ok && time.Now().Add(poll).After(deadline) {
			return nil, fmt.Errorf("learn job %s is still running: %w", learnID, context.DeadlineExceeded)
		}
		if err := sleep(ctx, poll); err != nil {
			return nil, err
		}
	}
}

// Cancel stops a learn job at once, whatever step it is on. It keeps the last complete results
// and reads `stopped` / `cancelled` once it has ended, normally within seconds.
func (s *LearnService) Cancel(ctx context.Context, learnID string) error {
	_, err := s.t.json(ctx, "POST", "/v1/agents/learn/"+esc(learnID)+"/cancel", nil)
	return err
}

// Rollout returns one run of a learn job's code: what it returned and logged, and its judgement.
func (s *LearnService) Rollout(ctx context.Context, learnID string, iteration, rollout int) (*LearnRun, error) {
	d, err := s.t.json(ctx, "GET", fmt.Sprintf("/v1/agents/learn/%s/iterations/%d/rollouts/%d", esc(learnID), iteration, rollout), nil)
	if err != nil {
		return nil, err
	}
	return parseLearnRun(obj(d)), nil
}

// JudgeOptions are the options of Judge.Create.
type JudgeOptions struct {
	// Task defaults to the first turn's message.
	Task           string
	IdempotencyKey string
}

// JudgeService judges recorded turns.
type JudgeService struct{ t *transport }

// Create judges recorded turns (one session, as one task) against criteria: a sentence for a
// model to judge, or Checks. Nothing runs again, and the turns do not change.
func (s *JudgeService) Create(ctx context.Context, turns []string, criteria Criteria, opts *JudgeOptions) (*Judgement, error) {
	for _, t := range turns {
		if t == "" {
			return nil, errNoTurnID
		}
	}
	if turns == nil {
		turns = []string{}
	}
	body := map[string]any{"turns": turns}
	if criteria != nil {
		body["criteria"] = criteria.criteria()
	}
	if opts != nil && opts.Task != "" {
		body["task"] = opts.Task
	}
	if opts != nil && opts.IdempotencyKey != "" {
		body["idempotency_key"] = opts.IdempotencyKey
	}
	d, err := s.t.json(ctx, "POST", "/v1/agents/judge", &request{json: body, timeout: judgeTimeout})
	if err != nil {
		return nil, err
	}
	return parseJudgement(obj(d)), nil
}

// Get returns a judgement.
func (s *JudgeService) Get(ctx context.Context, judgementID string) (*Judgement, error) {
	d, err := s.t.json(ctx, "GET", "/v1/agents/judge/"+esc(judgementID), nil)
	if err != nil {
		return nil, err
	}
	return parseJudgement(obj(d)), nil
}
