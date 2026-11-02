package sai

import (
	"context"
	"net/url"
	"strconv"
)

// UsageOptions are the options of Usage.Get.
type UsageOptions struct {
	// Granularity is `hour`, `day` (the default) or `month`.
	Granularity string
	// From and To are `2026-10` for a month, `2026-10-15` for a day, `2026-10-15T09` for an hour.
	// Each defaults to a range that ends now.
	From string
	To   string
	// OrgID defaults to the client's OrgID (SAI_ORG_ID).
	OrgID string
}

// UsageSessionsOptions are the options of Usage.Sessions. From and To are required.
type UsageSessionsOptions struct {
	// From and To are UTC days (`YYYY-MM-DD`), both included, at most 93 days apart.
	From   string
	To     string
	Limit  int
	Cursor string
	// OrgID defaults to the client's OrgID (SAI_ORG_ID).
	OrgID string
}

// UsageService: what an Organisation is charged, per Tenant and per session. Takes an
// Organisation Key.
type UsageService struct {
	t     *transport
	orgID string
}

// Get returns what the Organisation is charged, in total and per Tenant, per Granularity from
// From to To.
func (s *UsageService) Get(ctx context.Context, opts *UsageOptions) (*OrgUsage, error) {
	if opts == nil {
		opts = &UsageOptions{}
	}
	org, err := s.org(opts.OrgID)
	if err != nil {
		return nil, err
	}
	params := url.Values{}
	setParam(params, "granularity", opts.Granularity)
	setParam(params, "from", opts.From)
	setParam(params, "to", opts.To)
	d, err := s.t.json(ctx, "GET", "/v1/orgs/"+esc(org)+"/usage", &request{params: params})
	if err != nil {
		return nil, err
	}
	return parseOrgUsage(obj(d)), nil
}

// Sessions returns one page of what each of a Tenant's sessions spent on AI calls, oldest first.
// Keep paging with NextCursor until it is empty: a page can be empty and not be the last.
func (s *UsageService) Sessions(ctx context.Context, tenantID string, opts *UsageSessionsOptions) (*SessionSpendPage, error) {
	if opts == nil {
		opts = &UsageSessionsOptions{}
	}
	org, err := s.org(opts.OrgID)
	if err != nil {
		return nil, err
	}
	params := url.Values{"tenantId": {tenantID}}
	setParam(params, "from", opts.From)
	setParam(params, "to", opts.To)
	if opts.Limit != 0 {
		params.Set("limit", strconv.Itoa(opts.Limit))
	}
	setParam(params, "cursor", opts.Cursor)
	d, err := s.t.json(ctx, "GET", "/v1/orgs/"+esc(org)+"/usage/sessions", &request{params: params})
	if err != nil {
		return nil, err
	}
	return parseSessionSpendPage(obj(d)), nil
}

func (s *UsageService) org(orgID string) (string, error) {
	if orgID == "" {
		orgID = s.orgID
	}
	if orgID == "" {
		return "", errNoOrg()
	}
	return orgID, nil
}

func setParam(params url.Values, key, value string) {
	if value != "" {
		params.Set(key, value)
	}
}
