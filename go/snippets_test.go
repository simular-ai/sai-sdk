package sai_test

// Every Go block in the docs (sai-platform) runs against the mock server's fake API. See
// ../conformance/README.md#docs-snippets. The blocks are built into one program, a file and a
// function each (imports are per file in Go), then run one by one by name.

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"testing"
	"time"
)

type snippet struct {
	File    string `json:"file"`
	Line    int    `json:"line"`
	Context string `json:"context"`
	Code    string `json:"code"`
}

// split separates a block's import specs from its statements.
func split(code string) (imports, body []string) {
	lines := strings.Split(code, "\n")
	for i := 0; i < len(lines); i++ {
		l := strings.TrimSpace(lines[i])
		switch {
		case l == "import (":
			for i++; i < len(lines) && strings.TrimSpace(lines[i]) != ")"; i++ {
				if s := strings.TrimSpace(lines[i]); s != "" {
					imports = append(imports, s)
				}
			}
		case strings.HasPrefix(l, "import "):
			imports = append(imports, strings.TrimSpace(strings.TrimPrefix(l, "import ")))
		default:
			body = append(body, lines[i])
		}
	}
	return imports, body
}

// source is the block as a Go file of package main: imports first, then a function with the
// context and the block in a scope of its own.
func source(s snippet, name string) string {
	imports, body := split(s.Code)
	if s.Context != "" {
		ctxImports, ctxBody := split(s.Context)
		imports = append(ctxImports, imports...)
		body = append(append(append(ctxBody, "{"), body...), "}")
	}
	var unique []string
	for _, i := range imports {
		if !slices.Contains(unique, i) {
			unique = append(unique, i)
		}
	}
	return fmt.Sprintf("package main\n\nimport (\n\t%s\n)\n\nfunc init() { snippets[%q] = %s }\n\nfunc %s() {\n%s\n}\n",
		strings.Join(unique, "\n\t"), name, name, name, strings.Join(body, "\n"))
}

func loadSnippets(t *testing.T) []snippet {
	out, err := exec.Command("node", "../conformance/snippets.mjs", "--lang", "go").Output()
	if err != nil {
		msg := err.Error()
		if ee, ok := err.(*exec.ExitError); ok {
			msg = string(ee.Stderr)
		}
		if os.Getenv("SAI_DOCS_REQUIRED") == "1" {
			t.Fatal(msg)
		}
		t.Skip("no docs: check out sai-platform next to sai-sdk, or set SAI_DOCS_DIR: " + msg)
	}
	var snippets []snippet
	if err := json.Unmarshal(out, &snippets); err != nil {
		t.Fatal(err)
	}
	return snippets
}

func TestSnippets(t *testing.T) {
	snippets := loadSnippets(t)
	if len(snippets) == 0 {
		t.Skip("no Go blocks in the docs")
	}
	sdk, err := filepath.Abs(".")
	if err != nil {
		t.Fatal(err)
	}
	build := t.TempDir()
	work := t.TempDir()
	if err := os.CopyFS(work, os.DirFS("../conformance/fixtures")); err != nil {
		t.Fatal(err)
	}
	gomod := "module snippets\n\ngo 1.23\n\nrequire github.com/simular-ai/sai-sdk/go v0.0.0\n\nreplace github.com/simular-ai/sai-sdk/go => " + sdk + "\n"
	if err := os.WriteFile(filepath.Join(build, "go.mod"), []byte(gomod), 0o644); err != nil {
		t.Fatal(err)
	}
	main := "package main\n\nimport \"os\"\n\nvar snippets = map[string]func(){}\n\nfunc main() { snippets[os.Args[1]]() }\n"
	if err := os.WriteFile(filepath.Join(build, "main.go"), []byte(main), 0o644); err != nil {
		t.Fatal(err)
	}
	names := make([]string, len(snippets))
	for i, s := range snippets {
		names[i] = fmt.Sprintf("s%03d", i)
		if err := os.WriteFile(filepath.Join(build, names[i]+".go"), []byte(source(s, names[i])), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	// A block that does not compile is moved out, with its errors, and the rest built again.
	broken := map[string]string{}
	bin := filepath.Join(build, "snippets")
	for {
		cmd := exec.Command("go", "build", "-gcflags=-e", "-o", bin, ".")
		cmd.Dir = build
		cmd.Env = append(os.Environ(), "GOFLAGS=-mod=mod", "GOWORK=off")
		out, err := cmd.CombinedOutput()
		if err == nil {
			break
		}
		found := false
		for _, name := range names {
			re := regexp.MustCompile(`(?m)^\.?/?` + name + `\.go:.*$`)
			if msgs := re.FindAllString(string(out), -1); msgs != nil {
				broken[name] = strings.Join(msgs, "\n")
				found = true
				if err := os.Rename(filepath.Join(build, name+".go"), filepath.Join(build, name+".go.broken")); err != nil {
					t.Fatal(err)
				}
			}
		}
		if !found {
			t.Fatalf("go build: %s", out)
		}
	}

	url := mock(t)
	for i, s := range snippets {
		t.Run(fmt.Sprintf("%s:%d", s.File, s.Line), func(t *testing.T) {
			if msg, ok := broken[names[i]]; ok {
				t.Fatalf("does not compile:\n%s\n%s", msg, source(s, names[i]))
			}
			control(t, "reset", map[string]any{})
			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			cmd := exec.CommandContext(ctx, bin, names[i])
			cmd.Dir = work
			cmd.Env = append(os.Environ(),
				"SAI_API_KEY=sapi_docs",
				"SAI_ORG_KEY=sapi_docs_org",
				"SAI_API_URL="+url,
				"SAI_ORG_ID=org_docs",
			)
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("%v\n%s\n%s", err, out, source(s, names[i]))
			}
		})
	}
}
