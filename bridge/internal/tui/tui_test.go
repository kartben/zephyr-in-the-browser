package tui

import (
	"errors"
	"strings"
	"testing"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
)

type fakeHost struct {
	snap         server.Snapshot
	refreshed    int
	stopped      int
	selectedPath string
	selectedBaud int
	attachErr    error
	attached     int
	detached     int
	closed       int
}

func (f *fakeHost) Snapshot() server.Snapshot { return f.snap }
func (f *fakeHost) SubscribeStatus(fn func(server.Snapshot)) func() {
	fn(f.snap)
	return func() {}
}
func (f *fakeHost) RefreshPorts() error {
	f.refreshed++
	return nil
}
func (f *fakeHost) StopSerial() { f.stopped++ }
func (f *fakeHost) SelectSerial(path string, baud int) error {
	f.selectedPath = path
	f.selectedBaud = baud
	return nil
}
func (f *fakeHost) AttachGdb(host string, port int) error {
	f.attached++
	return f.attachErr
}
func (f *fakeHost) DetachGdb() { f.detached++ }
func (f *fakeHost) Close() error {
	f.closed++
	return nil
}

func sampleSnap() server.Snapshot {
	path := "/dev/cu.usbmodem1234"
	return server.Snapshot{
		Version:  "0.2.0",
		WSURL:    "ws://localhost:8740/?token=abc",
		DeepLink: "https://example.com/?bridge=ws%3A%2F%2Flocalhost%3A8740",
		NetReady: true,
		Ports: []protocol.PortInfo{
			{Path: path, FriendlyName: "serial port"},
			{Path: "/dev/tty.debug-console", FriendlyName: "serial port"},
		},
		Serial: protocol.SerialStatus{
			Path:     &path,
			BaudRate: 115200,
			Phase:    "streaming",
		},
		GDB: protocol.GdbStatus{
			Host:  "127.0.0.1",
			Port:  3333,
			Phase: "idle",
		},
		Clients:    0,
		MaxClients: 8,
	}
}

func TestViewShowsBridgeStatus(t *testing.T) {
	view := render(sampleSnap(), 0, false, "", 80)
	plain := ansi.Strip(view)
	for _, want := range []string{
		"Zephyr bridge",
		"v0.2.0",
		"ws://localhost:8740/?token=abc",
		"/dev/cu.usbmodem1234",
		"ready (gvisor)",
		"0/8",
	} {
		if !strings.Contains(plain, want) {
			t.Fatalf("view missing %q:\n%s", want, plain)
		}
	}
}

func TestViewClipsLongDeepLink(t *testing.T) {
	s := sampleSnap()
	s.DeepLink = "https://example.com/?" + strings.Repeat("x", 200)
	view := render(s, 0, false, "", 40)
	for i, line := range strings.Split(view, "\n") {
		if ansi.StringWidth(line) > 40 {
			t.Fatalf("line %d wider than 40 cols (%d): %q", i, ansi.StringWidth(line), line)
		}
	}
}

// press feeds a key to the model and, like the Bubble Tea runtime, runs any
// command the update returned and feeds its message back in.
func press(t *testing.T, m model, key tea.KeyMsg) model {
	t.Helper()
	next, cmd := m.Update(key)
	m = next.(model)
	if cmd == nil {
		return m
	}
	msg := cmd()
	if msg == nil {
		return m
	}
	next, _ = m.Update(msg)
	return next.(model)
}

func TestUpdateKeys(t *testing.T) {
	host := &fakeHost{snap: sampleSnap()}
	m := model{host: host, baud: 115200, snap: host.snap, width: 80}

	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	m = next.(model)
	if cmd != nil {
		t.Fatal("unexpected cmd")
	}
	if m.selected != 1 {
		t.Fatalf("selected=%d", m.selected)
	}

	m = press(t, m, tea.KeyMsg{Type: tea.KeyEnter})
	if host.selectedPath != "/dev/tty.debug-console" || host.selectedBaud != 115200 {
		t.Fatalf("select got path=%q baud=%d", host.selectedPath, host.selectedBaud)
	}

	m = press(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	if !m.help {
		t.Fatal("help not toggled")
	}
	if !strings.Contains(ansi.Strip(m.View()), "Keys") {
		t.Fatal("help view missing Keys")
	}

	m = press(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}})
	if host.stopped != 1 {
		t.Fatalf("stopped=%d want 1", host.stopped)
	}

	m = press(t, m, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}})
	if host.refreshed != 1 {
		t.Fatalf("refreshed=%d want 1", host.refreshed)
	}

	_, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	if cmd == nil {
		t.Fatal("expected quit cmd")
	}

	host.attachErr = errors.New("refused")
	m2 := model{host: host, snap: host.snap, width: 80}
	m2 = press(t, m2, tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}})
	if m2.errMsg != "refused" {
		t.Fatalf("errMsg=%q", m2.errMsg)
	}
	if !strings.Contains(ansi.Strip(m2.View()), "refused") {
		t.Fatal("view missing the attach error")
	}
}

func TestStatusMsgClampsSelection(t *testing.T) {
	m := model{snap: sampleSnap(), selected: 5, width: 80}
	next, _ := m.Update(statusMsg(sampleSnap()))
	m = next.(model)
	if m.selected != 1 {
		t.Fatalf("selected=%d want 1", m.selected)
	}
}
