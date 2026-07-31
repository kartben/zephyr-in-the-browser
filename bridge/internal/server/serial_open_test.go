package server

import (
	"testing"
	"time"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/config"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/gdb"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/serial"
)

type stuckHandle struct{ closed chan struct{} }

func (s *stuckHandle) Close() error                { close(s.closed); return nil }
func (s *stuckHandle) Write(b []byte) (int, error) { return len(b), nil }

// A wedged USB serial node blocks open(2) in the kernel forever. The daemon
// has to report that and stay usable — it used to wait on the call inline, so
// Start() never returned and the whole bridge went dark with no error.
func TestSelectSerialGivesUpOnAnOpenThatNeverReturns(t *testing.T) {
	prev := serialOpenTimeout
	serialOpenTimeout = 50 * time.Millisecond
	defer func() { serialOpenTimeout = prev }()

	release := make(chan struct{})
	defer close(release)
	opened := make(chan *stuckHandle, 1)

	b, err := Start(config.Config{
		Host: "127.0.0.1", Port: 0, MaxClients: 2, BaudRate: 115200,
		GdbHost: "127.0.0.1", GdbPort: 3333, NoTUI: true, AutoSerial: false,
		Forwards: map[string]string{},
	}, Hooks{
		Log:       func(string) {},
		ListPorts: func() ([]protocol.PortInfo, error) { return nil, nil },
		OpenSerial: func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (serial.Handle, error) {
			<-release // never returns while the test runs
			h := &stuckHandle{closed: make(chan struct{})}
			opened <- h
			return h, nil
		},
		OpenGdb: func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
			return nil, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = b.Close() }()

	done := make(chan error, 1)
	go func() { done <- b.SelectSerial("/dev/ttyWEDGED", 115200) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("want an error for a port that never opens")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("SelectSerial blocked on a wedged open instead of giving up")
	}

	// The failure has to be visible to the page, not just returned inline.
	if st := b.Snapshot().Serial; st.Phase != "error" {
		t.Fatalf("serial phase = %q, want %q (detail %q)", st.Phase, "error", st.Detail)
	}
	// And the daemon keeps serving everything else.
	if b.ListenPort() == 0 {
		t.Fatal("bridge stopped listening")
	}
}

// If the syscall does eventually return, that handle must not leak — nothing
// is reading it and the page has already been told the port failed.
func TestLateSerialOpenIsClosed(t *testing.T) {
	prev := serialOpenTimeout
	serialOpenTimeout = 50 * time.Millisecond
	defer func() { serialOpenTimeout = prev }()

	release := make(chan struct{})
	opened := make(chan *stuckHandle, 1)

	b, err := Start(config.Config{
		Host: "127.0.0.1", Port: 0, MaxClients: 2, BaudRate: 115200,
		GdbHost: "127.0.0.1", GdbPort: 3333, NoTUI: true, AutoSerial: false,
		Forwards: map[string]string{},
	}, Hooks{
		Log:       func(string) {},
		ListPorts: func() ([]protocol.PortInfo, error) { return nil, nil },
		OpenSerial: func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (serial.Handle, error) {
			<-release
			h := &stuckHandle{closed: make(chan struct{})}
			opened <- h
			return h, nil
		},
		OpenGdb: func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
			return nil, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = b.Close() }()

	if err := b.SelectSerial("/dev/ttyWEDGED", 115200); err == nil {
		t.Fatal("want a timeout error")
	}
	close(release) // the kernel finally lets go

	h := <-opened
	select {
	case <-h.closed:
	case <-time.After(2 * time.Second):
		t.Fatal("late handle was never closed")
	}
}
