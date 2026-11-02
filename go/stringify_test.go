package sai

import "testing"

// The Simulang the control helpers send must be byte for byte what JSON.stringify writes.
func TestStringify(t *testing.T) {
	for _, c := range []struct {
		in   any
		want string
	}{
		{object{{"path", `C:\a "b".txt`}}, `{"path":"C:\\a \"b\".txt"}`},
		{"<a href='x'>&</a>", `"<a href='x'>&</a>"`},
		{"héllo 日本 \u2028 😀", "\"héllo 日本 \u2028 😀\""},
		{"\x00\x1f\b\f\n\r\t\x7f", `"\u0000\u001f\b\f\n\r\t` + "\x7f" + `"`},
		{object{{"z", 1}, {"a", true}, {"m", nil}}, `{"z":1,"a":true,"m":null}`},
		{map[string]any{"b": 1.5, "a": []any{"x", 3}}, `{"a":["x",3],"b":1.5}`},
		{1e21, "1e+21"},
		{1e-7, "1e-7"},
		{123456789012.0, "123456789012"},
		{-0.5, "-0.5"},
	} {
		if got := stringify(c.in); got != c.want {
			t.Errorf("stringify(%#v) = %s, want %s", c.in, got, c.want)
		}
	}
}

func TestEsc(t *testing.T) {
	if got, want := esc("m 1/ä?!*'()~"), "m%201%2F%C3%A4%3F!*'()~"; got != want {
		t.Errorf("esc = %s, want %s", got, want)
	}
}
