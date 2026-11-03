package sai_test

// Parity with surface.json, the contract every language's SDK implements (../AGENTS.md).

import (
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"reflect"
	"slices"
	"strings"
	"testing"
	"unicode"

	sai "github.com/simular-ai/sai-sdk/go"
)

type surface struct {
	Resources          map[string][]string `json:"resources"`
	Objects            map[string][]string `json:"objects"`
	Errors             []string            `json:"errors"`
	EventKinds         []string            `json:"event_kinds"`
	TurnStatuses       []string            `json:"turn_statuses"`
	TurnRecordStatuses []string            `json:"turn_record_statuses"`
}

func loadSurface(t *testing.T) surface {
	data, err := os.ReadFile("../surface.json")
	if err != nil {
		t.Fatal(err)
	}
	var s surface
	if err := json.Unmarshal(data, &s); err != nil {
		t.Fatal(err)
	}
	return s
}

// snake is a Go name in snake_case: RevokeLive → revoke_live, TenantMachines → tenant_machines.
func snake(name string) string {
	var b strings.Builder
	r := []rune(name)
	for i, c := range r {
		if unicode.IsUpper(c) {
			if i > 0 && (unicode.IsLower(r[i-1]) || i+1 < len(r) && unicode.IsLower(r[i+1])) {
				b.WriteByte('_')
			}
			c = unicode.ToLower(c)
		}
		b.WriteRune(c)
	}
	return b.String()
}

// methods lists a type's exported methods in snake_case. A method without arguments and one
// result is an accessor (Turn.Status), the way a property is in Python, and not part of the surface.
func methods(typ reflect.Type) []string {
	var out []string
	for i := 0; i < typ.NumMethod(); i++ {
		m := typ.Method(i)
		if m.Type.NumIn() == 1 && m.Type.NumOut() == 1 {
			continue
		}
		out = append(out, snake(m.Name))
	}
	slices.Sort(out)
	return out
}

func sorted(s []string) []string {
	s = slices.Clone(s)
	slices.Sort(s)
	return s
}

func TestSurfaceResources(t *testing.T) {
	s := loadSurface(t)
	client, err := sai.New(sai.Options{APIKey: "sapi_test"})
	if err != nil {
		t.Fatal(err)
	}
	v := reflect.ValueOf(client).Elem()
	fields := map[string]reflect.Value{}
	var names []string
	for i := 0; i < v.NumField(); i++ {
		if f := v.Type().Field(i); f.IsExported() {
			fields[snake(f.Name)] = v.Field(i)
			names = append(names, snake(f.Name))
		}
	}
	slices.Sort(names)
	if want := sorted(s.Resources["client"]); !slices.Equal(names, want) {
		t.Errorf("client resources = %v, want %v", names, want)
	}
	if got := methods(reflect.TypeOf(client)); len(got) != 0 {
		t.Errorf("client methods = %v, want none", got)
	}
	for resource, want := range s.Resources {
		if resource == "client" {
			continue
		}
		f, ok := fields[resource]
		if !ok {
			continue
		}
		if got := methods(f.Type()); !slices.Equal(got, sorted(want)) {
			t.Errorf("%s methods = %v, want %v", resource, got, sorted(want))
		}
	}
}

func TestSurfaceObjects(t *testing.T) {
	s := loadSurface(t)
	for name, typ := range map[string]reflect.Type{
		"Session":      reflect.TypeOf(&sai.Session{}),
		"Turn":         reflect.TypeOf(&sai.Turn{}),
		"ControlLease": reflect.TypeOf(&sai.ControlLease{}),
	} {
		if got, want := methods(typ), sorted(s.Objects[name]); !slices.Equal(got, want) {
			t.Errorf("%s methods = %v, want %v", name, got, want)
		}
	}
}

// TestSurfaceErrors reads the package's exported error types (SaiError and the types embedding
// one) from its source, so an error type added to one SDK only fails here.
func TestSurfaceErrors(t *testing.T) {
	s := loadSurface(t)
	pkgs, err := parser.ParseDir(token.NewFileSet(), ".", func(fi fs.FileInfo) bool {
		return !strings.HasSuffix(fi.Name(), "_test.go")
	}, 0)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, f := range pkgs["sai"].Files {
		for _, decl := range f.Decls {
			if g, ok := decl.(*ast.GenDecl); ok && g.Tok == token.TYPE {
				for _, spec := range g.Specs {
					ts := spec.(*ast.TypeSpec)
					st, ok := ts.Type.(*ast.StructType)
					// SaiError, and the types that embed an error type first.
					isErr := ts.Name.Name == "SaiError" || ok && len(st.Fields.List) > 0 && st.Fields.List[0].Names == nil
					if name := ts.Name; name.IsExported() && isErr {
						names = append(names, name.Name)
					}
				}
			}
		}
	}
	slices.Sort(names)
	if want := sorted(s.Errors); !slices.Equal(names, want) {
		t.Errorf("errors = %v, want %v", names, want)
	}
	// Each one is a *SaiError to errors.As.
	for _, e := range []error{&sai.SpendCapReachedError{}, &sai.LinkOnlyApprovalError{}, &sai.BlockError{}, &sai.ConnectionError{}} {
		var base *sai.SaiError
		if !errors.As(e, &base) {
			t.Errorf("%T is not a *SaiError to errors.As", e)
		}
	}
	var conflict *sai.ConflictError
	if !errors.As(error(&sai.LinkOnlyApprovalError{}), &conflict) {
		t.Error("LinkOnlyApprovalError is not a *ConflictError to errors.As")
	}
}

func TestSurfaceEnums(t *testing.T) {
	s := loadSurface(t)
	strs := func(v any) []string {
		var out []string
		rv := reflect.ValueOf(v)
		for i := 0; i < rv.Len(); i++ {
			out = append(out, rv.Index(i).String())
		}
		return out
	}
	if got := strs(sai.EventKinds); !slices.Equal(sorted(got), sorted(s.EventKinds)) {
		t.Errorf("event kinds = %v, want %v", got, s.EventKinds)
	}
	if got := strs(sai.TurnStatuses); !slices.Equal(sorted(got), sorted(s.TurnStatuses)) {
		t.Errorf("turn statuses = %v, want %v", got, s.TurnStatuses)
	}
	if got := strs(sai.TurnRecordStatuses); !slices.Equal(got, s.TurnRecordStatuses) {
		t.Errorf("turn record statuses = %v, want %v", got, s.TurnRecordStatuses)
	}
}
