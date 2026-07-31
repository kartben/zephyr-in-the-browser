package tui

import (
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/x/ansi"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
)

type fakeHost struct {
	mu           sync.Mutex
	snap         server.Snapshot
	listeners    []func(server.Snapshot)
	refreshed    int
	stopped      int
	selectedPath string
	selectedBaud int
	attachErr    error
	attached     int
	detached     int
	closed       int

	// notify makes every mutating call fan out to subscribers synchronously,
	// the way server.Bridge.notifyStatus does.
	notify bool
	// attachedCh signals an AttachGdb call to tests that need to wait for one.
	attachedCh chan struct{}
}

func (f *fakeHost) Snapshot() server.Snapshot {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.snap
}

func (f *fakeHost) SubscribeStatus(fn func(server.Snapshot)) func() {
	f.mu.Lock()
	f.listeners = append(f.listeners, fn)
	snap := f.snap
	f.mu.Unlock()
	fn(snap)
	return func() {}
}

// fanout mimics server.Bridge: listeners run synchronously, on the caller's
// goroutine, while it is still inside the host call.
func (f *fakeHost) fanout() {
	if !f.notify {
		return
	}
	f.mu.Lock()
	listeners := make([]func(server.Snapshot), len(f.listeners))
	copy(listeners, f.listeners)
	snap := f.snap
	f.mu.Unlock()
	for _, fn := range listeners {
		fn(snap)
	}
}

func (f *fakeHost) RefreshPorts() error {
	f.mu.Lock()
	f.refreshed++
	f.mu.Unlock()
	f.fanout()
	return nil
}

func (f *fakeHost) StopSerial() {
	f.mu.Lock()
	f.stopped++
	f.mu.Unlock()
	f.fanout()
}

func (f *fakeHost) SelectSerial(path string, baud int) error {
	f.mu.Lock()
	f.selectedPath = path
	f.selectedBaud = baud
	f.mu.Unlock()
	f.fanout()
	return nil
}

func (f *fakeHost) AttachGdb(host string, port int) error {
	f.mu.Lock()
	f.attached++
	err := f.attachErr
	ch := f.attachedCh
	f.mu.Unlock()
	f.fanout()
	if ch != nil {
		ch <- struct{}{}
	}
	return err
}

func (f *fakeHost) DetachGdb() {
	f.mu.Lock()
	f.detached++
	f.mu.Unlock()
	f.fanout()
}

func (f *fakeHost) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
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

// runCmd executes a command the way Bubble Tea does — on its own goroutine —
// and feeds the resulting message back into the model.
func runCmd(t *testing.T, m model, cmd tea.Cmd) model {
	t.Helper()
	if cmd == nil {
		t.Fatal("expected a command")
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	select {
	case msg := <-done:
		next, _ := m.Update(msg)
		return next.(model)
	case <-time.After(2 * time.Second):
		t.Fatal("command did not finish within 2s")
		return m
	}
}

func TestViewShowsBridgeStatus(t *testing.T) {
	view := render(sampleSnap(), 0, false, "", "", 80)
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
	view := render(s, 0, false, "", "", 40)
	for i, line := range strings.Split(view, "\n") {
		if ansi.StringWidth(line) > 40 {
			t.Fatalf("line %d wider than 40 cols (%d): %q", i, ansi.StringWidth(line), line)
		}
	}
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

	next, cmd = m.Update(tea.KeyMsg{Type: tea.KeyEnter})
	m = runCmd(t, next.(model), cmd)
	if host.selectedPath != "/dev/tty.debug-console" || host.selectedBaud != 115200 {
		t.Fatalf("select got path=%q baud=%d", host.selectedPath, host.selectedBaud)
	}
	if m.busy != "" {
		t.Fatalf("busy not cleared: %q", m.busy)
	}

	next, _ = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'?'}})
	m = next.(model)
	if !m.help {
		t.Fatal("help not toggled")
	}
	if !strings.Contains(ansi.Strip(m.View()), "Keys") {
		t.Fatal("help view missing Keys")
	}

	next, cmd = m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'q'}})
	_ = next
	if cmd == nil {
		t.Fatal("expected quit cmd")
	}

	host.attachErr = errors.New("refused")
	m2 := model{host: host, snap: host.snap, width: 80}
	next, cmd = m2.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}})
	m2 = runCmd(t, next.(model), cmd)
	if m2.errMsg != "refused" {
		t.Fatalf("errMsg=%q", m2.errMsg)
	}
}

// Update must never call the host inline: it runs on the same goroutine that
// drains Bubble Tea's message channel, so a blocking call there freezes the
// UI and deadlocks against any status notification the call triggers.
func TestActionKeysDeferHostCallsToCommands(t *testing.T) {
	keys := []struct {
		name string
		msg  tea.KeyMsg
	}{
		{"r", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'r'}}},
		{"s", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'s'}}},
		{"g", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}}},
		{"G", tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'G'}}},
		{"enter", tea.KeyMsg{Type: tea.KeyEnter}},
	}
	for _, k := range keys {
		t.Run(k.name, func(t *testing.T) {
			host := &fakeHost{snap: sampleSnap()}
			m := model{host: host, baud: 115200, snap: host.snap, width: 80}

			next, cmd := m.Update(k.msg)
			m = next.(model)
			if cmd == nil {
				t.Fatal("no command returned — the host call ran inline on the event loop")
			}
			host.mu.Lock()
			touched := host.refreshed + host.stopped + host.attached + host.detached
			if host.selectedPath != "" {
				touched++
			}
			host.mu.Unlock()
			if touched != 0 {
				t.Fatal("host was called from Update instead of the command")
			}
			if m.busy == "" {
				t.Fatal("busy not set while the command is in flight")
			}
			if !strings.Contains(ansi.Strip(m.View()), m.busy) {
				t.Fatalf("view does not surface busy state %q", m.busy)
			}

			m = runCmd(t, m, cmd)
			if m.busy != "" {
				t.Fatalf("busy not cleared after command: %q", m.busy)
			}
		})
	}
}

func TestBusyIgnoresRepeatedActionKeys(t *testing.T) {
	host := &fakeHost{snap: sampleSnap()}
	m := model{host: host, baud: 115200, snap: host.snap, width: 80, busy: "attaching GDB"}

	next, cmd := m.Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'g'}})
	if cmd != nil {
		t.Fatal("second attach dispatched while one was in flight")
	}
	// Navigation stays live so the UI never feels stuck.
	next, _ = next.(model).Update(tea.KeyMsg{Type: tea.KeyRunes, Runes: []rune{'j'}})
	if next.(model).selected != 1 {
		t.Fatal("navigation blocked while busy")
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

func TestStatusPumpNeverBlocksAndCoalesces(t *testing.T) {
	p := newStatusPump()

	// Far more pushes than the one-slot wake channel, with nothing draining:
	// push must still return.
	done := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			s := sampleSnap()
			s.CtfBytes = uint64(i)
			p.push(s)
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("push blocked — a bridge goroutine would stall here")
	}

	// Intermediates collapse: a take yields the newest snapshot only.
	got, ok := p.take()
	if !ok {
		t.Fatal("no snapshot pending")
	}
	if got.CtfBytes != 999 {
		t.Fatalf("CtfBytes=%d want the newest (999)", got.CtfBytes)
	}
	if _, ok := p.take(); ok {
		t.Fatal("take returned a stale snapshot after draining")
	}
}

// The regression test for the freeze: a host that notifies status listeners
// synchronously from inside a host call, wired to a real tea.Program exactly
// as Run wires it. Before the fix, pressing g made the event loop wait on
// tea.Program.Send while being the only goroutine that could receive it.
func TestProgramSurvivesSynchronousStatusNotification(t *testing.T) {
	host := &fakeHost{snap: sampleSnap(), notify: true, attachedCh: make(chan struct{}, 1)}
	m := model{host: host, baud: 115200, snap: host.snap, width: 80}

	pr, pw := io.Pipe()
	defer pw.Close()
	p := tea.NewProgram(m, tea.WithInput(pr), tea.WithOutput(io.Discard))

	pump := newStatusPump()
	unsub := host.SubscribeStatus(pump.push)
	defer unsub()
	pumpDone := make(chan struct{})
	go pump.run(p.Send, pumpDone)
	defer close(pumpDone)

	exited := make(chan error, 1)
	go func() {
		_, err := p.Run()
		exited <- err
	}()

	if _, err := pw.Write([]byte("g")); err != nil {
		t.Fatalf("write g: %v", err)
	}
	select {
	case <-host.attachedCh:
	case <-time.After(5 * time.Second):
		p.Kill()
		t.Fatal("AttachGdb never ran: the event loop deadlocked on a status notification")
	}

	if _, err := pw.Write([]byte("q")); err != nil {
		t.Fatalf("write q: %v", err)
	}
	select {
	case err := <-exited:
		if err != nil {
			t.Fatalf("program exited with %v", err)
		}
	case <-time.After(5 * time.Second):
		p.Kill()
		t.Fatal("program did not quit after g — the UI was still wedged")
	}
}
