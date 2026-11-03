package sai

import (
	"fmt"
	"strings"
	"time"
)

// SaiError is a non-2xx response from the Sai API, and the base of every error the SDK returns
// for one. Code is the machine-readable `error` string when the server sent one (`machine_busy`,
// `link_only`, ...); Message is the human text; Body is the parsed JSON body, unchanged.
//
// Each subtype embeds its parent and unwraps to it, so errors.As finds a *SaiError (or a
// *ConflictError) in any of them.
type SaiError struct {
	Status  int
	Code    string
	Message string
	Body    map[string]any
	// RetryAfter is how long to wait before retrying; nil when the server did not say.
	RetryAfter *time.Duration
	cause      error
}

func (e *SaiError) Error() string { return e.Message }

// Unwrap returns the underlying error of a ConnectionError, if any.
func (e *SaiError) Unwrap() error { return e.cause }

// ConnectionError: the API could not be reached (DNS, TLS, timeout).
type ConnectionError struct{ SaiError }

func (e *ConnectionError) Unwrap() error { return &e.SaiError }

// BadRequestError is a 400: the request was invalid, e.g. several computers and no machine.
type BadRequestError struct{ SaiError }

func (e *BadRequestError) Unwrap() error { return &e.SaiError }

// AuthenticationError is a 401: no key, or the key is unknown or revoked.
type AuthenticationError struct{ SaiError }

func (e *AuthenticationError) Unwrap() error { return &e.SaiError }

// PermissionDeniedError is a 403: the key is valid but the account may not do this (plan, ownership).
type PermissionDeniedError struct{ SaiError }

func (e *PermissionDeniedError) Unwrap() error { return &e.SaiError }

// NotFoundError is a 404.
type NotFoundError struct{ SaiError }

func (e *NotFoundError) Unwrap() error { return &e.SaiError }

// ConflictError is a 409: e.g. `machine_busy`, `link_only`, approval no longer pending.
type ConflictError struct{ SaiError }

func (e *ConflictError) Unwrap() error { return &e.SaiError }

// GoneError is a 410 `control_closed`: the control lease has ended (closed, sat idle, lost the
// computer to a Sai task, or the computer stopped answering). Body["reason"] says which. Open a
// new one.
type GoneError struct{ SaiError }

func (e *GoneError) Unwrap() error { return &e.SaiError }

// RateLimitError is a 429: a rate limit, or a free-plan budget that resets daily.
type RateLimitError struct{ SaiError }

func (e *RateLimitError) Unwrap() error { return &e.SaiError }

// ServiceUnavailableError is a 503: the computer did not come online, or no capacity. Honor
// RetryAfter.
type ServiceUnavailableError struct{ SaiError }

func (e *ServiceUnavailableError) Unwrap() error { return &e.SaiError }

// BlockError: a control helper's Simulang block failed on the computer. Kind is `exception`,
// `timeout` or `interrupted`.
type BlockError struct {
	SaiError
	Kind string
}

func (e *BlockError) Unwrap() error { return &e.SaiError }

func newBlockError(kind, message string) *BlockError {
	return &BlockError{SaiError: SaiError{Message: kind + ": " + message, Code: kind, Body: map[string]any{}}, Kind: kind}
}

// LinkOnlyApprovalError: the approval must be answered by a human in a browser: open ApprovalURL.
type LinkOnlyApprovalError struct{ ConflictError }

func (e *LinkOnlyApprovalError) Unwrap() error { return &e.ConflictError }

// ApprovalURL is the page where a person answers the approval; empty when the server sent none.
func (e *LinkOnlyApprovalError) ApprovalURL() string {
	s, _ := e.Body["approvalUrl"].(string)
	return s
}

// SpendCapReachedError is a 403 `spend_cap_reached`: the key reached its monthly spend limit, or
// (on a cloud machine create, Body["scope"] == "tenant") the Tenant reached its budget. Not
// retryable: the limit resets at ResetsAt, or raise it for the key in the portal.
type SpendCapReachedError struct{ PermissionDeniedError }

func (e *SpendCapReachedError) Unwrap() error { return &e.PermissionDeniedError }

// ResetsAt is when the limit resets (ISO 8601, 00:00 UTC on the 1st); empty when unknown.
func (e *SpendCapReachedError) ResetsAt() string {
	s, _ := e.Body["resetsAt"].(string)
	return s
}

func errorFor(status int, body map[string]any, retryAfter *time.Duration) error {
	errText, errIsString := body["error"].(string)
	detail, hasDetail := body["message"]
	// Two body shapes: `{ error: "<human text>" }` (/v1/agents) and
	// `{ error: "<code>", message: "<human text>" }` (/v1/machines/{id}/control, newer errors).
	code := ""
	if errIsString && (hasDetail || looksLikeCode(errText)) {
		code = errText
	}
	var message string
	if s, ok := detail.(string); ok {
		message = s
	} else if errIsString {
		message = errText
	} else {
		message = fmt.Sprintf("HTTP %d", status)
	}
	if status == 401 {
		message += " (SAI_API_KEY was rejected: it may be revoked.)"
	}
	// The Retry-After header wins; retryAfterSeconds is the same value in the body (rate_limited).
	if retryAfter == nil {
		if n, ok := body["retryAfterSeconds"].(float64); ok {
			d := seconds(n)
			retryAfter = &d
		}
	}
	base := SaiError{Status: status, Code: code, Message: message, Body: body, RetryAfter: retryAfter}
	switch code {
	case "link_only":
		return &LinkOnlyApprovalError{ConflictError{base}}
	case "spend_cap_reached":
		return &SpendCapReachedError{PermissionDeniedError{base}}
	}
	switch status {
	case 400:
		return &BadRequestError{base}
	case 401:
		return &AuthenticationError{base}
	case 403:
		return &PermissionDeniedError{base}
	case 404:
		return &NotFoundError{base}
	case 409:
		return &ConflictError{base}
	case 410:
		return &GoneError{base}
	case 429:
		return &RateLimitError{base}
	case 503:
		return &ServiceUnavailableError{base}
	}
	return &base
}

func looksLikeCode(s string) bool {
	return s != "" && !strings.Contains(s, " ") && s == strings.ToLower(s)
}

func seconds(n float64) time.Duration { return time.Duration(n * float64(time.Second)) }
