package sai

import (
	"context"
	"errors"
	"strconv"
)

// TurnsService reads what a message started or joined: a turn's status, output, evidence, usage,
// and its trajectory when the message set RecordTrajectory. Maps to /v1/agents/turns/*.
type TurnsService struct{ t *transport }

var errNoTurnID = errors.New("this turn has no id: the message was answered without starting one")

// Get returns the turn's record now. It never waits: `finalizing` while the result is worked out.
func (s *TurnsService) Get(ctx context.Context, turnID string) (*TurnRecord, error) {
	if turnID == "" {
		return nil, errNoTurnID
	}
	d, err := s.t.json(ctx, "GET", "/v1/agents/turns/"+esc(turnID), nil)
	if err != nil {
		return nil, err
	}
	return parseTurnRecord(obj(d)), nil
}

// Wait reads the turn until it is `succeeded`, `failed` or `needs_input`. On `needs_input`,
// answer the approval on the turn's session (Sessions.Resume(record.SessionID)) and wait again.
// A deadline on the context bounds the wait.
func (s *TurnsService) Wait(ctx context.Context, turnID string) (*TurnRecord, error) {
	if turnID == "" {
		return nil, errNoTurnID
	}
	return waitTurnRecord(ctx, s.t, turnID, []TurnRecordStatus{RecordSucceeded, RecordFailed, RecordNeedsInput})
}

// Trajectory returns the steps the agent took, in order. Recorded only when the message set
// RecordTrajectory.
func (s *TurnsService) Trajectory(ctx context.Context, turnID string) ([]*TrajectoryStep, error) {
	if turnID == "" {
		return nil, errNoTurnID
	}
	d, err := s.t.json(ctx, "GET", "/v1/agents/turns/"+esc(turnID)+"/trajectory", nil)
	if err != nil {
		return nil, err
	}
	out := []*TrajectoryStep{}
	for _, x := range objs(d["steps"]) {
		out = append(out, parseTrajectoryStep(x))
	}
	return out, nil
}

// Screenshot returns the screen before step index (the last one is after the turn), as JPEG
// bytes.
func (s *TurnsService) Screenshot(ctx context.Context, turnID string, index int) ([]byte, error) {
	if turnID == "" {
		return nil, errNoTurnID
	}
	res, err := s.t.do(ctx, "GET", "/v1/agents/turns/"+esc(turnID)+"/trajectory/screenshots/"+strconv.Itoa(index), nil)
	if err != nil {
		return nil, err
	}
	return res.body, nil
}
