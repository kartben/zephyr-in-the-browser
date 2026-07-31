package server_test

import (
	"sync"
	"testing"
	"time"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/config"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/serial"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
)

// asyncSerial models the real port: Close() returns immediately and the reader
// goroutine fires onClose a moment later, like go.bug.st/serial does.
type asyncSerial struct {
	path    string
	onClose func()
	mu      sync.Mutex
	closed  bool
	done    chan struct{}
}

func (f *asyncSerial) Close() error {
	f.mu.Lock()
	if f.closed {
		f.mu.Unlock()
		return nil
	}
	f.closed = true
	f.mu.Unlock()
	go func() {
		time.Sleep(30 * time.Millisecond) // reader goroutine notices, then reports
		f.onClose()
		close(f.done)
	}()
	return nil
}
func (f *asyncSerial) Write(b []byte) (int, error) { return len(b), nil }
func (f *asyncSerial) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

func TestReselectPortKeepsNewSessionLive(t *testing.T) {
	var mu sync.Mutex
	var opened []*asyncSerial

	b, err := server.Start(config.Config{
		Host: "127.0.0.1", Port: 0, MaxClients: 2, BaudRate: 115200,
		GdbHost: "127.0.0.1", GdbPort: 3333, PagesURL: "https://example.test/",
		NoTUI: true, Forwards: map[string]string{},
	}, server.Hooks{
		Log: func(string) {},
		ListPorts: func() ([]protocol.PortInfo, error) {
			return []protocol.PortInfo{{Path: "/dev/ttyA"}, {Path: "/dev/ttyB"}}, nil
		},
		OpenSerial: func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (serial.Handle, error) {
			f := &asyncSerial{path: path, onClose: onClose, done: make(chan struct{})}
			mu.Lock()
			opened = append(opened, f)
			mu.Unlock()
			return f, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()

	if err := b.SelectSerial("/dev/ttyA", 115200); err != nil {
		t.Fatal(err)
	}
	if err := b.SelectSerial("/dev/ttyB", 115200); err != nil {
		t.Fatal(err)
	}

	// Let port A's reader goroutine report its (stale) close.
	time.Sleep(150 * time.Millisecond)

	snap := b.Snapshot()
	if snap.Serial.Phase != "streaming" {
		t.Errorf("phase = %q, want streaming (port A's stale onClose clobbered port B)", snap.Serial.Phase)
	}
	if snap.Serial.Path == nil || *snap.Serial.Path != "/dev/ttyB" {
		t.Errorf("path = %v, want /dev/ttyB", snap.Serial.Path)
	}

	// StopSerial must actually close port B; if the stale callback nilled the
	// handle, B leaks (open fd + a reader goroutine still pumping CTF data).
	b.StopSerial()
	mu.Lock()
	defer mu.Unlock()
	for _, f := range opened {
		if !f.isClosed() {
			t.Errorf("port %s leaked: never closed", f.path)
		}
	}
}
