package sai

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultBaseURL is the Sai API.
const DefaultBaseURL = "https://api.simular.ai"

// credential returns the bearer token before each request.
type credential func(ctx context.Context) (string, error)

type request struct {
	params  url.Values
	json    any
	body    []byte
	headers map[string]string
	timeout time.Duration
}

type response struct {
	status int
	body   []byte
}

// transport is the one place requests are made: auth header, error mapping, timeouts.
type transport struct {
	baseURL    string
	timeout    time.Duration
	userAgent  string
	versionTag string
	key        string
	credential credential
	client     *http.Client
}

func (t *transport) do(ctx context.Context, method, path string, r *request) (*response, error) {
	if r == nil {
		r = &request{}
	}
	target := t.baseURL + path
	if len(r.params) > 0 {
		target += "?" + r.params.Encode()
	}
	u, err := url.Parse(target)
	if err != nil {
		return nil, err
	}
	timeout := r.timeout
	if timeout == 0 {
		timeout = t.timeout
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	var body io.Reader
	if r.json != nil {
		b, err := marshalJSON(r.json)
		if err != nil {
			return nil, err
		}
		body = bytes.NewReader(b)
	} else if r.body != nil {
		body = bytes.NewReader(r.body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", t.userAgent)
	// routes the request to a tagged API revision
	if t.versionTag != "" {
		req.Header.Set("x-sai-version", t.versionTag)
	}
	token := t.key
	if t.credential != nil {
		if token, err = t.credential(ctx); err != nil {
			return nil, err
		}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	for k, v := range r.headers {
		req.Header.Set(k, v)
	}
	if r.json != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := t.client.Do(req)
	if err != nil {
		return nil, connectionError(u.Host, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, connectionError(u.Host, err)
	}
	if res.StatusCode >= 400 {
		return nil, toError(res, data)
	}
	return &response{status: res.StatusCode, body: data}, nil
}

// json makes the request and decodes the body; an empty body is nil.
func (t *transport) json(ctx context.Context, method, path string, r *request) (map[string]any, error) {
	res, err := t.do(ctx, method, path, r)
	if err != nil {
		return nil, err
	}
	if len(bytes.TrimSpace(res.body)) == 0 {
		return nil, nil
	}
	var v any
	if err := json.Unmarshal(res.body, &v); err != nil {
		return nil, err
	}
	m, _ := v.(map[string]any)
	return m, nil
}

func connectionError(host string, err error) error {
	var ne net.Error
	if errors.Is(err, context.DeadlineExceeded) || errors.Is(err, context.Canceled) || (errors.As(err, &ne) && ne.Timeout()) {
		return &ConnectionError{SaiError{Message: fmt.Sprintf("Request to %s timed out.", host), Body: map[string]any{}, cause: err}}
	}
	detail := err.Error()
	var ue *url.Error
	if errors.As(err, &ue) {
		detail = ue.Err.Error()
	}
	return &ConnectionError{SaiError{
		Message: fmt.Sprintf("Could not reach the Sai API at %s: %s. Check the network and SAI_API_URL.", host, detail),
		Body:    map[string]any{},
		cause:   err,
	}}
}

func toError(res *http.Response, data []byte) error {
	var body map[string]any
	var parsed any
	if err := json.Unmarshal(data, &parsed); err == nil {
		if m, ok := parsed.(map[string]any); ok {
			body = m
		} else {
			body = map[string]any{"error": jsString(parsed)}
		}
	} else {
		text := string(data)
		if r := []rune(text); len(r) > 500 {
			text = string(r[:500])
		}
		if text == "" {
			text = strings.TrimSpace(strings.TrimPrefix(res.Status, strconv.Itoa(res.StatusCode)))
		}
		body = map[string]any{"error": text}
	}
	var retryAfter *time.Duration
	if raw := strings.TrimSpace(res.Header.Get("Retry-After")); raw != "" {
		if n, err := strconv.ParseFloat(raw, 64); err == nil {
			d := seconds(n)
			retryAfter = &d
		}
	}
	return errorFor(res.StatusCode, body, retryAfter)
}

// jsString is JavaScript's String(v) for a parsed JSON value that is not an object.
func jsString(v any) string {
	switch x := v.(type) {
	case nil:
		return "null"
	case string:
		return x
	case []any:
		parts := make([]string, len(x))
		for i, e := range x {
			if e != nil {
				parts[i] = jsString(e)
			}
		}
		return strings.Join(parts, ",")
	case map[string]any:
		return "[object Object]"
	default:
		return stringify(x)
	}
}

func marshalJSON(v any) ([]byte, error) {
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	if err := enc.Encode(v); err != nil {
		return nil, err
	}
	return bytes.TrimRight(buf.Bytes(), "\n"), nil
}

// esc percent-encodes a path segment as JavaScript's encodeURIComponent does.
func esc(s string) string {
	var b strings.Builder
	for _, c := range []byte(s) {
		if 'a' <= c && c <= 'z' || 'A' <= c && c <= 'Z' || '0' <= c && c <= '9' || strings.IndexByte("-_.!~*'()", c) >= 0 {
			b.WriteByte(c)
		} else {
			fmt.Fprintf(&b, "%%%02X", c)
		}
	}
	return b.String()
}
