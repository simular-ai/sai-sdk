package sai

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"sync"
	"time"
)

const (
	// Tenants.Client exchanges again when its token has less than this left.
	tokenRefreshMargin = 5 * time.Minute
	// Between machine reads while TenantMachines.Create waits.
	machinePollInterval = 5 * time.Second
	machineWaitTimeout  = 10 * time.Minute
)

func tenantPath(tenantID string) string { return "/v1/tenants/" + esc(tenantID) }

// TenantCreateOptions are the options of Tenants.Create.
type TenantCreateOptions struct {
	// ExternalID is your id for the customer, unique in the Organisation. It cannot change later.
	ExternalID string
	Metadata   map[string]string
}

// TenantListOptions are the options of Tenants.List.
type TenantListOptions struct {
	Status string
	// ExternalID finds the Tenant with that id (zero or one). It cannot be combined with Status.
	ExternalID string
	Limit      int
	Cursor     string
}

// TenantUpdateOptions are the options of Tenants.Update; only the fields set are sent.
type TenantUpdateOptions struct {
	Name string
	// Metadata replaces the whole map.
	Metadata map[string]string
	// Status `disabled` stops the Tenant's tokens and machines; `active` brings it back.
	Status string
	// CloudMachineLimit (0 to 1000) caps the Tenant's cloud machines. Lowering it deletes
	// nothing: creates are refused until the count fits.
	CloudMachineLimit *int
	// ClearCloudMachineLimit sends a null CloudMachineLimit, which removes the cap.
	ClearCloudMachineLimit bool
	// ResidentialProxy is the Tenant's residential proxy switch; it has no effect yet, and
	// traffic goes direct. Only the Organisation Key or an owner may set it and the limit.
	ResidentialProxy *bool
}

// TenantTokenOptions are the options of Tenants.Token and Tenants.Client.
type TenantTokenOptions struct {
	// OrgID defaults to the client's OrgID (SAI_ORG_ID).
	OrgID string
}

// TenantsService: your customers, under an Organisation. Every call takes an Organisation Key.
type TenantsService struct {
	t              *transport
	orgID          string
	withCredential func(credential) *Client
}

// Create creates a Tenant.
func (s *TenantsService) Create(ctx context.Context, name string, opts *TenantCreateOptions) (*Tenant, error) {
	body := map[string]any{"name": name}
	if opts != nil && opts.ExternalID != "" {
		body["externalId"] = opts.ExternalID
	}
	if opts != nil && opts.Metadata != nil {
		body["metadata"] = opts.Metadata
	}
	d, err := s.t.json(ctx, "POST", "/v1/tenants", &request{json: body})
	if err != nil {
		return nil, err
	}
	return parseTenant(obj(d)), nil
}

// List returns one page of Tenants, newest first.
func (s *TenantsService) List(ctx context.Context, opts *TenantListOptions) (*TenantPage, error) {
	params := url.Values{}
	if opts != nil {
		if opts.Status != "" {
			params.Set("status", opts.Status)
		}
		if opts.ExternalID != "" {
			params.Set("externalId", opts.ExternalID)
		}
		if opts.Limit != 0 {
			params.Set("limit", strconv.Itoa(opts.Limit))
		}
		if opts.Cursor != "" {
			params.Set("cursor", opts.Cursor)
		}
	}
	d, err := s.t.json(ctx, "GET", "/v1/tenants", &request{params: params})
	if err != nil {
		return nil, err
	}
	page := &TenantPage{Tenants: []*Tenant{}, NextCursor: str(d["nextCursor"])}
	for _, x := range objs(d["tenants"]) {
		page.Tenants = append(page.Tenants, parseTenant(x))
	}
	return page, nil
}

// Get returns a Tenant.
func (s *TenantsService) Get(ctx context.Context, tenantID string) (*Tenant, error) {
	d, err := s.t.json(ctx, "GET", tenantPath(tenantID), nil)
	if err != nil {
		return nil, err
	}
	return parseTenant(obj(d)), nil
}

// Update changes a Tenant; see TenantUpdateOptions.
func (s *TenantsService) Update(ctx context.Context, tenantID string, opts *TenantUpdateOptions) (*Tenant, error) {
	body := map[string]any{}
	if opts != nil {
		if opts.Name != "" {
			body["name"] = opts.Name
		}
		if opts.Metadata != nil {
			body["metadata"] = opts.Metadata
		}
		if opts.Status != "" {
			body["status"] = opts.Status
		}
		if opts.CloudMachineLimit != nil {
			body["cloudMachineLimit"] = *opts.CloudMachineLimit
		} else if opts.ClearCloudMachineLimit {
			body["cloudMachineLimit"] = nil
		}
		if opts.ResidentialProxy != nil {
			body["residentialProxy"] = *opts.ResidentialProxy
		}
	}
	d, err := s.t.json(ctx, "PATCH", tenantPath(tenantID), &request{json: body})
	if err != nil {
		return nil, err
	}
	return parseTenant(obj(d)), nil
}

// Delete disables the Tenant and revokes every enrolled machine. Cloud machines stay and
// hibernate: delete them with TenantMachines.Delete. Its data is kept: erase it from the console.
func (s *TenantsService) Delete(ctx context.Context, tenantID string) error {
	_, err := s.t.do(ctx, "DELETE", tenantPath(tenantID), nil)
	return err
}

// CreateEnrollment returns a single-use code that enrolls one computer into the Tenant. It
// expires in 15 minutes.
func (s *TenantsService) CreateEnrollment(ctx context.Context, tenantID string) (*Enrollment, error) {
	d, err := s.t.json(ctx, "POST", tenantPath(tenantID)+"/enrollments", nil)
	if err != nil {
		return nil, err
	}
	return parseEnrollment(obj(d)), nil
}

// Token exchanges the Organisation Key for a one-hour token that acts as the Tenant.
func (s *TenantsService) Token(ctx context.Context, tenantID string, opts *TenantTokenOptions) (*TenantToken, error) {
	orgID := s.orgID
	if opts != nil && opts.OrgID != "" {
		orgID = opts.OrgID
	}
	if orgID == "" {
		return nil, errNoOrg()
	}
	d, err := s.t.json(ctx, "POST", "/v1/orgs/"+esc(orgID)+"/tenants/"+esc(tenantID)+"/token", nil)
	if err != nil {
		return nil, err
	}
	return parseTenantToken(obj(d)), nil
}

// Client returns a client that acts as the Tenant. It exchanges a token now, and again before a
// request when the token has less than five minutes left. It uses this client's Organisation Key.
func (s *TenantsService) Client(ctx context.Context, tenantID string, opts *TenantTokenOptions) (*Client, error) {
	current, err := s.Token(ctx, tenantID, opts)
	if err != nil {
		return nil, err
	}
	var mu sync.Mutex
	return s.withCredential(func(ctx context.Context) (string, error) {
		mu.Lock()
		defer mu.Unlock()
		if time.Until(time.UnixMilli(current.ExpiresAt)) >= tokenRefreshMargin {
			return current.Token, nil
		}
		next, err := s.Token(ctx, tenantID, opts)
		if err != nil {
			return "", err
		}
		current = next
		return current.Token, nil
	}), nil
}

// TenantMachineCreateOptions are the options of TenantMachines.Create.
type TenantMachineCreateOptions struct {
	// OS is `windows` or `linux`; the size follows it.
	OS string
	// Name (up to 64 characters) is a label you show your users.
	Name string
	// RequestID (letters, digits, `_` and `-`, up to 128) makes a retry safe: the same id and
	// body return the first machine, and the same id with another body returns a ConflictError
	// (`request_id_reused`). Without one, every call creates a machine.
	RequestID string
	// Wait reads the machine until it is `ready`.
	Wait bool
	// Timeout bounds Wait. Default 10 minutes.
	Timeout time.Duration
}

// TenantMachinesService: a Tenant's computers, enrolled and cloud. Every call takes an
// Organisation Key.
type TenantMachinesService struct{ t *transport }

// Create creates a cloud machine for the Tenant. It returns at once with State `provisioning`.
// With Wait it reads the machine every 5 seconds until it is `ready`; a machine that fails or is
// deleted returns a SaiError, and no `ready` within Timeout returns an error wrapping
// context.DeadlineExceeded.
func (s *TenantMachinesService) Create(ctx context.Context, tenantID string, opts *TenantMachineCreateOptions) (*TenantMachine, error) {
	if opts == nil {
		opts = &TenantMachineCreateOptions{}
	}
	body := map[string]any{"os": opts.OS}
	if opts.Name != "" {
		body["name"] = opts.Name
	}
	if opts.RequestID != "" {
		body["requestId"] = opts.RequestID
	}
	d, err := s.t.json(ctx, "POST", tenantPath(tenantID)+"/machines", &request{json: body})
	if err != nil {
		return nil, err
	}
	machine := parseTenantMachine(obj(d))
	if !opts.Wait {
		return machine, nil
	}
	timeout := opts.Timeout
	if timeout <= 0 {
		timeout = machineWaitTimeout
	}
	deadline := time.Now().Add(timeout)
	for machine.State != "ready" {
		if machine.State == "failed" || machine.State == "deleting" {
			return nil, &SaiError{Message: fmt.Sprintf("Cloud machine %s is %s and will not become ready.", machine.ID, machine.State), Body: machine.Raw}
		}
		if time.Now().Add(machinePollInterval).After(deadline) {
			return nil, fmt.Errorf("cloud machine %s still %s: %w", machine.ID, machine.State, context.DeadlineExceeded)
		}
		if err := sleep(ctx, machinePollInterval); err != nil {
			return nil, err
		}
		next, err := s.Get(ctx, tenantID, machine.ID)
		if err != nil {
			if err := sleepAfterRateLimit(ctx, err); err != nil {
				return nil, err
			}
			continue
		}
		machine = next
	}
	return machine, nil
}

// List returns both kinds, enrolled and cloud. A cloud machine is listed from the moment it is
// created.
func (s *TenantMachinesService) List(ctx context.Context, tenantID string) ([]*TenantMachine, error) {
	d, err := s.t.json(ctx, "GET", tenantPath(tenantID)+"/machines", nil)
	if err != nil {
		return nil, err
	}
	out := []*TenantMachine{}
	for _, x := range objs(d["machines"]) {
		out = append(out, parseTenantMachine(x))
	}
	return out, nil
}

// Get returns one of the Tenant's machines.
func (s *TenantMachinesService) Get(ctx context.Context, tenantID, machineID string) (*TenantMachine, error) {
	d, err := s.t.json(ctx, "GET", tenantPath(tenantID)+"/machines/"+esc(machineID), nil)
	if err != nil {
		return nil, err
	}
	return parseTenantMachine(obj(d)), nil
}

// Delete signs an enrolled machine out at once (`revoked`); enroll it again with a new code to
// bring it back. A cloud machine is deleted with its disk (`deleting`), which cannot be undone;
// it leaves the list when the deletion finishes.
func (s *TenantMachinesService) Delete(ctx context.Context, tenantID, machineID string) (string, error) {
	res, err := s.t.do(ctx, "DELETE", tenantPath(tenantID)+"/machines/"+esc(machineID), nil)
	if err != nil {
		return "", err
	}
	if res.status == 202 {
		return "deleting", nil
	}
	return "revoked", nil
}

// Revoke is Delete without its answer. On a cloud machine it deletes the machine: use Delete.
func (s *TenantMachinesService) Revoke(ctx context.Context, tenantID, machineID string) error {
	_, err := s.Delete(ctx, tenantID, machineID)
	return err
}
