package sai_test

import (
	"bufio"
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"sync"
	"testing"
)

// The mock Sai API (../conformance/server.mjs), started once for every test that needs it. Its
// stdin stays open as a pipe, so it exits with this process.
var (
	mockOnce sync.Once
	mockURL  string
	mockErr  error
	mockCmd  *exec.Cmd
)

func TestMain(m *testing.M) {
	code := m.Run()
	if mockCmd != nil {
		_ = mockCmd.Process.Kill()
		_ = mockCmd.Wait()
	}
	os.Exit(code)
}

func mock(t *testing.T) string {
	t.Helper()
	mockOnce.Do(func() {
		cmd := exec.Command("node", "../conformance/server.mjs")
		cmd.Stderr = os.Stderr
		if _, mockErr = cmd.StdinPipe(); mockErr != nil {
			return
		}
		out, err := cmd.StdoutPipe()
		if err != nil {
			mockErr = err
			return
		}
		if mockErr = cmd.Start(); mockErr != nil {
			return
		}
		mockCmd = cmd
		line, err := bufio.NewReader(out).ReadString('\n')
		if !strings.HasPrefix(line, "SAI_MOCK_URL=") {
			mockErr = fmt.Errorf("mock server did not start: %q %v", line, err)
			return
		}
		mockURL = strings.TrimSpace(strings.TrimPrefix(line, "SAI_MOCK_URL="))
	})
	if mockErr != nil {
		t.Fatal(mockErr)
	}
	return mockURL
}

// control posts to the mock server's /__mock/ routes.
func control(t *testing.T, path string, body any) map[string]any {
	t.Helper()
	b, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	res, err := http.Post(mock(t)+"/__mock/"+path, "application/json", bytes.NewReader(b))
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(res.Body)
	var out map[string]any
	if err := json.Unmarshal(data, &out); err != nil {
		t.Fatalf("/__mock/%s: %s", path, data)
	}
	return out
}
