package sai

import (
	"context"
	"fmt"
	"strings"
)

// MachinesService: the computers Sai works on. Cloud computers, or the customer's own PC with
// the Sai app.
type MachinesService struct{ t *transport }

// List returns the account's computers.
func (s *MachinesService) List(ctx context.Context) ([]*Machine, error) {
	d, err := s.t.json(ctx, "GET", "/v1/agents/machines", nil)
	if err != nil {
		return nil, err
	}
	out := []*Machine{}
	for _, m := range objs(d["machines"]) {
		out = append(out, parseMachine(m))
	}
	return out, nil
}

// Get returns one computer, or a NotFoundError.
func (s *MachinesService) Get(ctx context.Context, machineID string) (*Machine, error) {
	machines, err := s.List(ctx)
	if err != nil {
		return nil, err
	}
	for _, m := range machines {
		if m.ID == machineID {
			return m, nil
		}
	}
	return nil, &NotFoundError{SaiError{Status: 404, Message: fmt.Sprintf("Machine %s not found on this account.", machineID), Body: map[string]any{}}}
}

// Live returns the live screen: LiveURL, a page a person can open without a Simular sign-in, and
// a Guacamole tunnel for a viewer of your own. The machine must be running.
func (s *MachinesService) Live(ctx context.Context, machineID string) (*LiveView, error) {
	d, err := s.t.json(ctx, "POST", "/v1/agents/machines/"+esc(machineID)+"/live", nil)
	if err != nil {
		return nil, err
	}
	d = obj(d)
	v := &LiveView{
		MachineID:    machineID,
		LiveURL:      str(d["liveUrl"]),
		ExpiresAt:    int64Ptr(d["expiresAt"]),
		WebsocketURL: jsString(d["websocketUrl"]),
		Width:        int(num(d["width"])),
		Height:       int(num(d["height"])),
	}
	if id, ok := d["machineId"].(string); ok {
		v.MachineID = id
	}
	if _, ok := d["websocketUrl"]; !ok {
		v.WebsocketURL = "undefined"
	}
	return v, nil
}

// RevokeLive revokes every LiveURL handed out for the machine, and returns how many. A page
// already showing the screen keeps its connection until it closes, but stops taking input within
// seconds.
func (s *MachinesService) RevokeLive(ctx context.Context, machineID string) (int, error) {
	d, err := s.t.json(ctx, "DELETE", "/v1/agents/machines/"+esc(machineID)+"/live", nil)
	if err != nil {
		return 0, err
	}
	return int(num(d["revoked"])), nil
}

// resolveID is machineID, or the account's only computer.
func (s *MachinesService) resolveID(ctx context.Context, machineID string) (string, error) {
	if machineID != "" {
		return machineID, nil
	}
	machines, err := s.List(ctx)
	if err != nil {
		return "", err
	}
	switch len(machines) {
	case 1:
		return machines[0].ID, nil
	case 0:
		return "", &BadRequestError{SaiError{Status: 400, Message: "No computer on this account. Create one in the Sai app or the portal.", Body: map[string]any{}}}
	}
	names := make([]string, len(machines))
	for i, m := range machines {
		names[i] = m.ID
		if m.Name != "" {
			names[i] = fmt.Sprintf("%s (%s)", m.ID, m.Name)
		}
	}
	return "", &BadRequestError{SaiError{Status: 400, Message: "Several computers on this account; pass machine. Candidates: " + strings.Join(names, ", "), Body: map[string]any{}}}
}
