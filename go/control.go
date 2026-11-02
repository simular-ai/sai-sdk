package sai

import (
	"context"
	"errors"
	"sort"
	"sync"
	"time"
)

// Direct control: drive a cloud computer with Simulang. No agent. Maps to
// /v1/machines/{id}/control, a lease on the machine: at most one per machine, so the machine id
// is the handle. Research preview, open to every account; model calls the code makes are billed
// as usual.

func controlPath(machineID string) string { return "/v1/machines/" + esc(machineID) + "/control" }

// ControlService opens control leases.
type ControlService struct{ t *transport }

// Open takes a cloud computer. It returns once the lease holds it, up to ~3 minutes when a Sai
// task holds it or it has to start; at once if the lease is already open. Close it when done
// (defer lease.Close(ctx)): Sai's tasks on that computer wait until then.
func (s *ControlService) Open(ctx context.Context, machineID string) (*ControlLease, error) {
	d, err := s.t.json(ctx, "POST", controlPath(machineID), &request{timeout: 240 * time.Second})
	if err != nil {
		return nil, err
	}
	return &ControlLease{MachineID: machineID, IdleTimeoutSec: int(num(obj(d)["expiresAfterIdleSec"])), t: s.t, path: controlPath(machineID)}, nil
}

// ExecOptions are the options of ControlLease.Exec and Run.
type ExecOptions struct {
	// Timeout is how long the block may run on the computer.
	Timeout time.Duration
}

// ShellOptions are the options of ControlLease.Shell.
type ShellOptions struct {
	Cwd     string
	Timeout time.Duration
}

// ShellResult is what a shell command printed and how it exited.
type ShellResult struct {
	Stdout   string `json:"stdout"`
	Stderr   string `json:"stderr"`
	ExitCode int    `json:"exit_code"`
	TimedOut bool   `json:"timed_out"`
}

// ControlLease holds one cloud computer and runs Simulang blocks on it.
type ControlLease struct {
	MachineID      string
	IdleTimeoutSec int

	t      *transport
	path   string
	mu     sync.Mutex
	closed bool
}

// Exec runs one Simulang (JavaScript) block. Use `var` for anything the next block needs. A
// block that throws, times out or is interrupted still returns a result: check Error. It returns
// a GoneError once the lease has ended (closed, idle, taken by a Sai task, or the computer
// stopped answering): open again.
func (l *ControlLease) Exec(ctx context.Context, code string, opts *ExecOptions) (*ExecResult, error) {
	body := map[string]any{"code": code}
	timeout := 120 * time.Second
	if opts != nil && opts.Timeout > 0 {
		body["timeoutMs"] = opts.Timeout.Milliseconds()
		timeout = opts.Timeout
	}
	d, err := l.t.json(ctx, "POST", l.path+"/exec", &request{json: body, timeout: timeout + 45*time.Second})
	if err != nil {
		return nil, err
	}
	return parseExecResult(obj(d)), nil
}

// Run runs code from Learn.Create: its main with inputs over the parameters' defaults (an
// argument to main replaces its whole default object, so missing inputs keep their defaults).
// main's return value is ExecResult.Result. To run code of your own, pass &LearnResult{Code: ...}:
// it gets inputs as is.
func (l *ControlLease) Run(ctx context.Context, learned *LearnResult, inputs map[string]any, opts *ExecOptions) (*ExecResult, error) {
	args := object{}
	index := map[string]int{}
	for _, p := range learned.Parameters {
		if i, ok := index[p.Name]; ok {
			args[i].value = p.DefaultValue
			continue
		}
		index[p.Name] = len(args)
		args = append(args, field{p.Name, p.DefaultValue})
	}
	keys := make([]string, 0, len(inputs))
	for k := range inputs {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	for _, k := range keys {
		if i, ok := index[k]; ok {
			args[i].value = inputs[k]
		} else {
			args = append(args, field{k, inputs[k]})
		}
	}
	return l.Exec(ctx, learned.Code+"\nawait main("+stringify(args)+")", opts)
}

// Shell runs a shell command on the computer.
func (l *ControlLease) Shell(ctx context.Context, command string, opts *ShellOptions) (*ShellResult, error) {
	args := object{{"command", command}}
	exec := &ExecOptions{}
	if opts != nil {
		if opts.Cwd != "" {
			args = append(args, field{"cwd", opts.Cwd})
		}
		exec.Timeout = opts.Timeout
	}
	r, err := l.helper(ctx, "await machine.exec("+stringify(args)+")", exec)
	if err != nil {
		return nil, err
	}
	m := obj(r.Result)
	return &ShellResult{Stdout: str(m["stdout"]), Stderr: str(m["stderr"]), ExitCode: int(num(m["exitCode"])), TimedOut: truthy(m["timedOut"])}, nil
}

// ReadFile returns a text file's contents.
func (l *ControlLease) ReadFile(ctx context.Context, path string) (string, error) {
	r, err := l.helper(ctx, "await machine.readFile("+stringify(object{{"path", path}})+")", nil)
	if err != nil {
		return "", err
	}
	return str(r.Result), nil
}

// WriteFile writes text to a file, replacing it.
func (l *ControlLease) WriteFile(ctx context.Context, path, text string) error {
	_, err := l.helper(ctx, "await machine.writeToFile("+stringify(object{{"path", path}, {"text", text}, {"overwrite", true}})+")", nil)
	return err
}

// Screenshot returns the whole screen as image bytes (usually JPEG; use Exec for the MIME type).
// It needs the computer's screen-capture service, and returns a BlockError where it is off (a
// page or app snapshot still carries an image).
func (l *ControlLease) Screenshot(ctx context.Context) ([]byte, error) {
	r, err := l.helper(ctx, "var __sai_page = await machine.pageContent(); null", nil)
	if err != nil {
		return nil, err
	}
	if r.Screenshot == nil {
		if r.ScreenshotOmitted {
			return nil, newBlockError("exception", "screenshot too large to return")
		}
		return nil, newBlockError("exception", "no screenshot")
	}
	return r.Screenshot, nil
}

// Interrupt stops the running block at its next step. False if nothing was running.
func (l *ControlLease) Interrupt(ctx context.Context) (bool, error) {
	d, err := l.t.json(ctx, "POST", l.path+"/interrupt", nil)
	if err != nil {
		return false, err
	}
	return truthy(d["interrupted"]), nil
}

// Get returns the lease: `{ status: open|closed, closedReason?, lastExecAt, ... }`.
func (l *ControlLease) Get(ctx context.Context) (map[string]any, error) {
	return l.t.json(ctx, "GET", l.path, nil)
}

// Close clears the REPL and releases the computer. Safe to call twice.
func (l *ControlLease) Close(ctx context.Context) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	if _, err := l.t.do(ctx, "DELETE", l.path, nil); err != nil {
		var gone *GoneError
		if !errors.As(err, &gone) {
			return err
		}
	}
	l.closed = true
	return nil
}

// helper runs a block and turns its failure into a BlockError.
func (l *ControlLease) helper(ctx context.Context, code string, opts *ExecOptions) (*ExecResult, error) {
	r, err := l.Exec(ctx, code, opts)
	if err != nil {
		return nil, err
	}
	if r.Error != nil {
		return nil, newBlockError(r.Error.Kind, r.Error.Message)
	}
	return r, nil
}
