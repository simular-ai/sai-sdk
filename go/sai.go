// Package sai is the Go SDK for the Sai API.
//
//   - Client.Sessions: give Sai a task on a computer and get the answer back.
//
//   - Client.Learn, Client.Judge: turn recorded turns or a task into Simulang code, repair it,
//     run, judge and repair it on a machine (policy iteration), judge turns.
//
//   - Client.Control: drive a computer yourself with Simulang.
//
//   - Client.Machines, Client.Models, Client.Files, Client.Account, Client.Auth.
//
//   - Client.Tenants, Client.TenantMachines: your customers under an Organisation (an
//     Organisation Key).
//
//   - Client.Usage: what the Organisation is charged, per Tenant and per session.
//
//     client, err := sai.New(sai.Options{}) // SAI_API_KEY, and SAI_API_URL if set
//     session, err := client.Sessions.Create(ctx, nil)
//     result, err := session.Run(ctx, "Open Notepad and type hello", nil)
//     fmt.Println(result.Text)
package sai

import (
	"context"
	"errors"
	"net/http"
	"os"
	"strings"
	"time"
)

// Options configure a Client. Every field is optional.
type Options struct {
	// APIKey defaults to SAI_API_KEY.
	APIKey string
	// BaseURL defaults to SAI_API_URL, then https://api.simular.ai.
	BaseURL string
	// Timeout is per request. Default 60 seconds.
	Timeout time.Duration
	// VersionTag routes requests to a tagged API revision.
	VersionTag string
	// HTTPClient replaces http.DefaultClient, e.g. in tests.
	HTTPClient *http.Client
	// OrgID is the Organisation that Tenants.Token, Tenants.Client and Usage act on. Defaults to
	// SAI_ORG_ID. Only an Organisation Key needs it.
	OrgID string
}

// Client is the Sai API client. It is safe for concurrent use.
type Client struct {
	Machines *MachinesService
	Sessions *SessionsService
	Turns    *TurnsService
	// Learn turns recorded turns into Simulang code, and repairs it (research preview).
	Learn *LearnService
	// Judge judges recorded turns against new criteria (research preview).
	Judge          *JudgeService
	Control        *ControlService
	Models         *ModelsService
	Files          *FilesService
	Account        *AccountService
	Auth           *AuthService
	Usage          *UsageService
	Tenants        *TenantsService
	TenantMachines *TenantMachinesService
}

// New returns a client. It fails when there is no API key.
func New(opts Options) (*Client, error) {
	key := opts.APIKey
	if key == "" {
		key = os.Getenv("SAI_API_KEY")
	}
	if key == "" {
		return nil, errors.New("no API key: pass APIKey or set SAI_API_KEY. Create one at https://platform.simular.ai")
	}
	return newClient(opts, key, nil), nil
}

func newClient(opts Options, key string, cred credential) *Client {
	baseURL := opts.BaseURL
	if baseURL == "" {
		baseURL = os.Getenv("SAI_API_URL")
	}
	if baseURL == "" {
		baseURL = DefaultBaseURL
	}
	timeout := opts.Timeout
	if timeout == 0 {
		timeout = 60 * time.Second
	}
	httpClient := opts.HTTPClient
	if httpClient == nil {
		httpClient = http.DefaultClient
	}
	orgID := opts.OrgID
	if orgID == "" {
		orgID = os.Getenv("SAI_ORG_ID")
	}
	t := &transport{
		baseURL:    strings.TrimRight(baseURL, "/"),
		timeout:    timeout,
		userAgent:  "sai-go/" + Version,
		versionTag: opts.VersionTag,
		key:        key,
		credential: cred,
		client:     httpClient,
	}
	machines := &MachinesService{t}
	return &Client{
		Machines:       machines,
		Sessions:       &SessionsService{t, machines},
		Turns:          &TurnsService{t},
		Learn:          &LearnService{t},
		Judge:          &JudgeService{t},
		Control:        &ControlService{t},
		Models:         &ModelsService{t},
		Files:          &FilesService{t},
		Account:        &AccountService{t},
		Auth:           &AuthService{t},
		Usage:          &UsageService{t, orgID},
		Tenants:        &TenantsService{t, orgID, func(c credential) *Client { return newClient(opts, "", c) }},
		TenantMachines: &TenantMachinesService{t},
	}
}

// ModelsService lists the models a session can run on.
type ModelsService struct{ t *transport }

// List returns the models a session can run on; Allowed says whether this plan may use each.
func (s *ModelsService) List(ctx context.Context) ([]*Model, error) {
	d, err := s.t.json(ctx, "GET", "/v1/agents/models", nil)
	if err != nil {
		return nil, err
	}
	out := []*Model{}
	for _, m := range objs(d["models"]) {
		out = append(out, parseModel(m))
	}
	return out, nil
}

// AccountService reads the account.
type AccountService struct{ t *transport }

// Get returns the plan and spendable credit. Slow-ish (billing lookup): not for a poll loop.
func (s *AccountService) Get(ctx context.Context) (*Account, error) {
	d, err := s.t.json(ctx, "GET", "/v1/agents/account", nil)
	if err != nil {
		return nil, err
	}
	return parseAccount(obj(d)), nil
}

// AuthService says who the key acts as.
type AuthService struct{ t *transport }

// Check returns who the key or token acts as. It returns an AuthenticationError for a missing or
// revoked key.
func (s *AuthService) Check(ctx context.Context) (*AuthInfo, error) {
	d, err := s.t.json(ctx, "GET", "/v1/agents/auth", nil)
	if err != nil {
		return nil, err
	}
	return parseAuthInfo(obj(d)), nil
}

// Ptr returns a pointer to v, for the optional fields of an options struct:
// `CloudMachineLimit: sai.Ptr(5)`.
func Ptr[T any](v T) *T { return &v }

func errNoOrg() error {
	return errors.New("no Organisation id: pass OrgID here or to sai.New, or set SAI_ORG_ID")
}
