package tui

import (
	"io"
	"sync"
	"testing"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
)

// notifyingHost mimics *server.Bridge: an action mutates state and then fans
// the new snapshot out to subscribers synchronously, inline, on whichever
// goroutine made the call.
type notifyingHost struct {
	mu        sync.Mutex
	snap      server.Snapshot
	listeners []func(server.Snapshot)
	selects   int
}

func (h *notifyingHost) Snapshot() server.Snapshot {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.snap
}

func (h *notifyingHost) SubscribeStatus(fn func(server.Snapshot)) func() {
	h.mu.Lock()
	h.listeners = append(h.listeners, fn)
	h.mu.Unlock()
	fn(h.Snapshot()) // Bridge.SubscribeStatus primes new subscribers too
	return func() {}
}

func (h *notifyingHost) notify() {
	snap := h.Snapshot()
	h.mu.Lock()
	ls := append([]func(server.Snapshot){}, h.listeners...)
	h.mu.Unlock()
	for _, fn := range ls {
		fn(snap)
	}
}

func (h *notifyingHost) RefreshPorts() error { h.notify(); return nil }
func (h *notifyingHost) StopSerial()         { h.notify() }
func (h *notifyingHost) SelectSerial(path string, baud int) error {
	h.mu.Lock()
	h.snap.Serial.Path = &path
	h.snap.Serial.Phase = "streaming"
	h.selects++
	h.mu.Unlock()
	h.notify()
	return nil
}
func (h *notifyingHost) AttachGdb(string, int) error { h.notify(); return nil }
func (h *notifyingHost) DetachGdb()                  { h.notify() }
func (h *notifyingHost) Close() error                { return nil }

func (h *notifyingHost) selectCount() int {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.selects
}

// TestActionKeysDoNotWedgeEventLoop drives the real wiring: every action key
// reaches a host that notifies inline. If a status callback reaches
// Program.Send on the event loop's own goroutine it blocks on the unbuffered
// p.msgs that only that loop drains, and the TUI wedges — no repaint, no
// further keys, not even Ctrl-C. The trailing q proves the loop is still live.
func TestActionKeysDoNotWedgeEventLoop(t *testing.T) {
	host := &notifyingHost{snap: sampleSnap()}
	pr, pw := io.Pipe()
	defer pw.Close()

	done := make(chan error, 1)
	go func() {
		done <- runProgram(host, 115200, tea.WithInput(pr), tea.WithOutput(io.Discard), tea.WithoutRenderer())
	}()

	go func() {
		// enter=select, s=stop, r=refresh, g=attach, G=detach, then quit.
		for _, key := range []string{"\r", "s", "r", "g", "G", "\r", "q"} {
			time.Sleep(30 * time.Millisecond)
			if _, err := pw.Write([]byte(key)); err != nil {
				return
			}
		}
	}()

	select {
	case err := <-done:
		if err != nil {
			t.Fatalf("runProgram: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("TUI wedged: an action key deadlocked the Bubble Tea event loop")
	}

	if n := host.selectCount(); n != 2 {
		t.Fatalf("SelectSerial called %d times, want 2", n)
	}
}

// TestStatusPumpNeverBlocks pins the property the fix rests on: the bridge
// calls its listeners inline, so pushing a snapshot must return even when
// nothing is draining and even under a burst from a chatty port.
func TestStatusPumpNeverBlocks(t *testing.T) {
	p := newStatusPump()

	pushed := make(chan struct{})
	go func() {
		for i := 0; i < 1000; i++ {
			s := sampleSnap()
			s.CtfBytes = uint64(i)
			p.push(s)
		}
		close(pushed)
	}()

	select {
	case <-pushed:
	case <-time.After(3 * time.Second):
		t.Fatal("statusPump.push blocked with no reader draining it")
	}

	// Bursts coalesce: the reader gets the newest snapshot, not a backlog.
	got, ok := p.take()
	if !ok {
		t.Fatal("no snapshot queued")
	}
	if got.CtfBytes != 999 {
		t.Fatalf("CtfBytes=%d, want the newest (999)", got.CtfBytes)
	}
	if _, ok := p.take(); ok {
		t.Fatal("stale snapshot left queued behind the newest")
	}
}
