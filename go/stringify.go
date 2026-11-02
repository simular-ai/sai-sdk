package sai

import (
	"encoding/json"
	"fmt"
	"math"
	"reflect"
	"sort"
	"strconv"
	"strings"
)

// field is one key of an object written by stringify, in order.
type field struct {
	key   string
	value any
}

// object is a JSON object whose keys keep their order.
type object []field

// stringify writes v as compact JSON exactly as JavaScript's JSON.stringify does: no HTML
// escaping, non-ASCII as is. The Simulang the control helpers send must match it byte for byte.
// Map keys are sorted, since a Go map has no order.
func stringify(v any) string {
	var b strings.Builder
	writeJS(&b, v)
	return b.String()
}

func writeJS(b *strings.Builder, v any) {
	switch x := v.(type) {
	case nil:
		b.WriteString("null")
	case object:
		b.WriteByte('{')
		for i, f := range x {
			if i > 0 {
				b.WriteByte(',')
			}
			writeJSString(b, f.key)
			b.WriteByte(':')
			writeJS(b, f.value)
		}
		b.WriteByte('}')
	case string:
		writeJSString(b, x)
	case bool:
		b.WriteString(strconv.FormatBool(x))
	case json.Number:
		f, err := x.Float64()
		if err != nil {
			b.WriteString(x.String())
		} else {
			b.WriteString(jsNumber(f))
		}
	default:
		rv := reflect.ValueOf(v)
		switch rv.Kind() {
		case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
			b.WriteString(strconv.FormatInt(rv.Int(), 10))
		case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
			b.WriteString(strconv.FormatUint(rv.Uint(), 10))
		case reflect.Float32, reflect.Float64:
			b.WriteString(jsNumber(rv.Float()))
		case reflect.Pointer, reflect.Interface:
			if rv.IsNil() {
				b.WriteString("null")
			} else {
				writeJS(b, rv.Elem().Interface())
			}
		case reflect.Slice, reflect.Array:
			if rv.Kind() == reflect.Slice && rv.IsNil() {
				b.WriteString("null")
				return
			}
			b.WriteByte('[')
			for i := 0; i < rv.Len(); i++ {
				if i > 0 {
					b.WriteByte(',')
				}
				writeJS(b, rv.Index(i).Interface())
			}
			b.WriteByte(']')
		case reflect.Map:
			if rv.IsNil() {
				b.WriteString("null")
				return
			}
			keys := make([]string, 0, rv.Len())
			values := map[string]any{}
			for _, k := range rv.MapKeys() {
				s := fmt.Sprint(k.Interface())
				keys = append(keys, s)
				values[s] = rv.MapIndex(k).Interface()
			}
			sort.Strings(keys)
			o := make(object, len(keys))
			for i, k := range keys {
				o[i] = field{k, values[k]}
			}
			writeJS(b, o)
		case reflect.String:
			writeJSString(b, rv.String())
		case reflect.Bool:
			b.WriteString(strconv.FormatBool(rv.Bool()))
		default:
			// Anything else goes through encoding/json, then back through here for exact output.
			raw, err := json.Marshal(v)
			if err != nil {
				b.WriteString("null")
				return
			}
			var generic any
			_ = json.Unmarshal(raw, &generic)
			writeJS(b, generic)
		}
	}
}

func writeJSString(b *strings.Builder, s string) {
	b.WriteByte('"')
	for _, r := range s {
		switch r {
		case '"':
			b.WriteString(`\"`)
		case '\\':
			b.WriteString(`\\`)
		case '\b':
			b.WriteString(`\b`)
		case '\f':
			b.WriteString(`\f`)
		case '\n':
			b.WriteString(`\n`)
		case '\r':
			b.WriteString(`\r`)
		case '\t':
			b.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(b, `\u%04x`, r)
			} else {
				b.WriteRune(r)
			}
		}
	}
	b.WriteByte('"')
}

// jsNumber formats a number as JavaScript's Number.prototype.toString does.
func jsNumber(f float64) string {
	if math.IsNaN(f) || math.IsInf(f, 0) {
		return "null"
	}
	if f == 0 {
		return "0"
	}
	abs := math.Abs(f)
	if abs >= 1e21 || abs < 1e-6 {
		s := strconv.FormatFloat(f, 'e', -1, 64)
		// Go writes e+21 / e-07; JavaScript writes e+21 / e-7.
		mant, exp, _ := strings.Cut(s, "e")
		sign := exp[0]
		exp = strings.TrimLeft(exp[1:], "0")
		return mant + "e" + string(sign) + exp
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
