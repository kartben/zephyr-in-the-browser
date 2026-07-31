package server_test

import (
	"encoding/json"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/config"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/gdb"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/serial"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
)

type fakeSerial struct {
	path string
	baud int
	mu   sync.Mutex
	onData func([]byte)
	onClose func()
	closed bool
}

func (f *fakeSerial) Close() error {
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.closed {
		f.closed = true
		if f.onClose != nil {
			f.onClose()
		}
	}
	return nil
}
func (f *fakeSerial) Write(b []byte) (int, error) { return len(b), nil }
func (f *fakeSerial) Push(b []byte) {
	f.mu.Lock()
	fn := f.onData
	f.mu.Unlock()
	if fn != nil {
		fn(b)
	}
}

func startTestBridge(t *testing.T, enableNet bool) (*server.Bridge, **fakeSerial) {
	t.Helper()
	tok := "test-token"
	var current **fakeSerial
	var holder *fakeSerial
	current = &holder

	b, err := server.Start(config.Config{
		Host:       "127.0.0.1",
		Port:       0,
		Token:      &tok,
		MaxClients: 2,
		BaudRate:   115200,
		GdbHost:    "127.0.0.1",
		GdbPort:    3333,
		PagesURL:   "https://example.test/",
		NoTUI:      true,
		EnableNet:  enableNet,
		AutoSerial: false,
		Forwards:   map[string]string{},
	}, server.Hooks{
		Log: func(string) {},
		ListPorts: func() ([]protocol.PortInfo, error) {
			return []protocol.PortInfo{
				{Path: "/dev/ttyTEST0", FriendlyName: "Test"},
				{Path: "/dev/ttyTEST1", FriendlyName: "Test"},
			}, nil
		},
		OpenSerial: func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (serial.Handle, error) {
			f := &fakeSerial{path: path, baud: baud, onData: onData, onClose: onClose}
			*current = f
			return f, nil
		},
		OpenGdb: func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
			return &nopHandle{}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return b, current
}

type nopHandle struct{}

func (n *nopHandle) Close() error                { return nil }
func (n *nopHandle) Write(b []byte) (int, error) { return len(b), nil }

func dial(t *testing.T, port int, token string) *websocket.Conn {
	t.Helper()
	u := "ws://127.0.0.1:" + itoa(port) + "/?token=" + token
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = c.Close() })
	return c
}

func itoa(n int) string {
	return jsonNumber(n)
}
func jsonNumber(n int) string {
	b, _ := json.Marshal(n)
	return string(b)
}

func readHello(t *testing.T, c *websocket.Conn) map[string]any {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, data, err := c.ReadMessage()
	if err != nil {
		t.Fatal(err)
	}
	ch, payload, ok := protocol.DecodeFrame(data)
	if !ok || ch != protocol.CH_CTRL {
		t.Fatalf("expected CTRL, got ch=%d ok=%v", ch, ok)
	}
	var msg map[string]any
	if err := json.Unmarshal(payload, &msg); err != nil {
		t.Fatal(err)
	}
	if msg["type"] != "hello" {
		t.Fatalf("type %v", msg["type"])
	}
	return msg
}

func TestRejectBadToken(t *testing.T) {
	b, _ := startTestBridge(t, false)
	u := "ws://127.0.0.1:" + itoa(b.ListenPort()) + "/?token=wrong"
	c, _, err := websocket.DefaultDialer.Dial(u, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
	_, _, err = c.ReadMessage()
	if err == nil {
		t.Fatal("expected close")
	}
	if !websocket.IsCloseError(err, protocol.CloseUnauthorized) {
		// gorilla may wrap
		ce, ok := err.(*websocket.CloseError)
		if !ok || ce.Code != protocol.CloseUnauthorized {
			t.Fatalf("want 4001, got %v", err)
		}
	}
}

func TestHelloAndSelectSerial(t *testing.T) {
	b, ser := startTestBridge(t, false)
	c := dial(t, b.ListenPort(), "test-token")
	hello := readHello(t, c)
	if hello["protocol"] != protocol.ProtocolName {
		t.Fatalf("%v", hello["protocol"])
	}
	features := hello["features"].(map[string]any)
	if features["net"] != false {
		t.Fatalf("net should be false: %v", features)
	}
	ports := hello["ports"].([]any)
	if len(ports) != 2 {
		t.Fatalf("ports %d", len(ports))
	}

	raw, _ := protocol.EncodeCtrl(map[string]any{
		"type": "select-serial", "path": "/dev/ttyTEST0", "baudRate": 115200,
	})
	if err := c.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		_ = c.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
		_, data, err := c.ReadMessage()
		if err != nil {
			continue
		}
		ch, payload, ok := protocol.DecodeFrame(data)
		if !ok || ch != protocol.CH_CTRL {
			continue
		}
		var msg map[string]any
		_ = json.Unmarshal(payload, &msg)
		if msg["type"] == "serial-status" && msg["phase"] == "streaming" {
			(*ser).Push([]byte{0xCA, 0xFE})
			_ = c.SetReadDeadline(time.Now().Add(2 * time.Second))
			_, data, err = c.ReadMessage()
			if err != nil {
				t.Fatal(err)
			}
			ch, payload, ok = protocol.DecodeFrame(data)
			if !ok || ch != protocol.CH_CTF {
				t.Fatalf("want CTF got %d", ch)
			}
			if string(payload) != string([]byte{0xCA, 0xFE}) {
				t.Fatalf("%x", payload)
			}
			return
		}
	}
	t.Fatal("no serial-status streaming")
}

func TestHealthz(t *testing.T) {
	b, _ := startTestBridge(t, false)
	resp, err := http.Get("http://127.0.0.1:" + itoa(b.ListenPort()) + "/healthz")
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		t.Fatal(resp.Status)
	}
	body, _ := io.ReadAll(resp.Body)
	var msg map[string]any
	if err := json.Unmarshal(body, &msg); err != nil {
		t.Fatal(err)
	}
	if msg["ok"] != true {
		t.Fatalf("%v", msg)
	}
}

// startGdbTestBridge is startTestBridge with a caller-supplied GDB opener.
func startGdbTestBridge(t *testing.T, opener gdb.Opener) *server.Bridge {
	t.Helper()
	tok := "test-token"
	b, err := server.Start(config.Config{
		Host: "127.0.0.1", Port: 0, Token: &tok, MaxClients: 2, BaudRate: 115200,
		PagesURL: "https://example.test/", NoTUI: true, EnableNet: false, AutoSerial: false,
		GdbHost: "127.0.0.1", GdbPort: 3333, Forwards: map[string]string{},
	}, server.Hooks{
		Log:       func(string) {},
		ListPorts: func() ([]protocol.PortInfo, error) { return nil, nil },
		OpenSerial: func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (serial.Handle, error) {
			return &fakeSerial{path: path, baud: baud, onData: onData, onClose: onClose}, nil
		},
		OpenGdb: opener,
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })
	return b
}

// OpenOCD accepts the TCP connection and then hangs up when target
// examination has failed ("attempted 'gdb' connection rejected"). The dial
// succeeds, so the bridge used to publish Phase="connected" over the top of
// the close callback and show a live debug session on a dead socket.
func TestAttachGdbReportsImmediateRejection(t *testing.T) {
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		// Synchronous close: the worst-case ordering, where the server is gone
		// before AttachGdb can announce success.
		onClose()
		return &nopHandle{}, nil
	})

	err := b.AttachGdb("127.0.0.1", 3333)
	if err == nil {
		t.Fatal("attach reported success against a server that hung up")
	}
	if got := b.Snapshot().GDB.Phase; got != "error" {
		t.Fatalf("phase=%q want %q — the UI would claim GDB is live", got, "error")
	}
}

type recordingHandle struct {
	mu      sync.Mutex
	written []byte
}

func (r *recordingHandle) Close() error { return nil }
func (r *recordingHandle) Write(b []byte) (int, error) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.written = append(r.written, b...)
	return len(b), nil
}
func (r *recordingHandle) String() string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return string(r.written)
}

// A GDB server does not consider the session open until the client sends its
// opening ack; OpenOCD blocks on it in gdb_new_connection() and logs
// "attempted 'gdb' connection rejected" if it never arrives. The bridge
// attaches on the client's behalf, so it has to speak that byte itself.
func TestAttachGdbSendsInitialAck(t *testing.T) {
	rec := &recordingHandle{}
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		return rec, nil
	})

	if err := b.AttachGdb("127.0.0.1", 3333); err != nil {
		t.Fatalf("attach: %v", err)
	}
	if got := rec.String(); got != "+" {
		t.Fatalf("bridge sent %q on attach, want %q — the server will never open the session", got, "+")
	}
}

// A callback arriving late from a superseded attempt must not overwrite the
// state of the connection that replaced it.
func TestStaleGdbCallbackDoesNotClobberNewAttach(t *testing.T) {
	var stale func()
	first := true
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		if first {
			first = false
			stale = onClose // hold it; fire after the next attach succeeds
		}
		return &nopHandle{}, nil
	})

	if err := b.AttachGdb("127.0.0.1", 3333); err != nil {
		t.Fatalf("first attach: %v", err)
	}
	if err := b.AttachGdb("127.0.0.1", 4444); err != nil {
		t.Fatalf("second attach: %v", err)
	}
	stale()

	snap := b.Snapshot().GDB
	if snap.Phase != "connected" || snap.Port != 4444 {
		t.Fatalf("stale close tore down the live session: phase=%q port=%d", snap.Phase, snap.Port)
	}
}

// readUntil pumps frames off c until match returns true or the window ends.
// A timeout poisons a gorilla conn for further reads, so callers must place
// any expected-false (silence) check last on a given connection.
func readUntil(t *testing.T, c *websocket.Conn, d time.Duration, match func(ch byte, payload []byte) bool) bool {
	t.Helper()
	_ = c.SetReadDeadline(time.Now().Add(d))
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			return false
		}
		ch, payload, ok := protocol.DecodeFrame(data)
		if !ok {
			continue
		}
		if match(ch, payload) {
			return true
		}
	}
}

func sendCtrl(t *testing.T, c *websocket.Conn, msg map[string]any) {
	t.Helper()
	raw, _ := protocol.EncodeCtrl(msg)
	if err := c.WriteMessage(websocket.BinaryMessage, raw); err != nil {
		t.Fatal(err)
	}
}

// Two pages on one stub interleave packets and corrupt each other's ack
// state; the ctrl attach claims the session and server bytes go to the owner
// alone, while the second tab is told the session is busy.
func TestGdbFramesRouteToOwnerOnly(t *testing.T) {
	emitCh := make(chan func([]byte), 1)
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		emitCh <- onData
		return &nopHandle{}, nil
	})

	owner := dial(t, b.ListenPort(), "test-token")
	readHello(t, owner)
	other := dial(t, b.ListenPort(), "test-token")
	readHello(t, other)

	sendCtrl(t, owner, map[string]any{"type": "gdb-attach"})
	var emit func([]byte)
	select {
	case emit = <-emitCh:
	case <-time.After(2 * time.Second):
		t.Fatal("gdb opener never ran")
	}
	if !readUntil(t, owner, 2*time.Second, func(ch byte, payload []byte) bool {
		if ch != protocol.CH_CTRL {
			return false
		}
		var msg map[string]any
		_ = json.Unmarshal(payload, &msg)
		return msg["type"] == "gdb-status" && msg["phase"] == "connected"
	}) {
		t.Fatal("owner never saw gdb-status connected")
	}

	emit([]byte("$T05#b9"))
	if !readUntil(t, owner, 2*time.Second, func(ch byte, payload []byte) bool {
		return ch == protocol.CH_GDB && string(payload) == "$T05#b9"
	}) {
		t.Fatal("owner did not receive the GDB frame")
	}

	// The second tab's own attach attempt is answered with busy.
	sendCtrl(t, other, map[string]any{"type": "gdb-attach"})
	if !readUntil(t, other, 2*time.Second, func(ch byte, payload []byte) bool {
		if ch != protocol.CH_CTRL {
			return false
		}
		var msg map[string]any
		_ = json.Unmarshal(payload, &msg)
		return msg["type"] == "gdb-status" && msg["phase"] == "busy"
	}) {
		t.Fatal("non-owner was not told the session is busy")
	}

	// Silence check last: a read timeout poisons the conn (see readUntil).
	emit([]byte("$S05#b8"))
	if readUntil(t, other, 500*time.Millisecond, func(ch byte, payload []byte) bool {
		return ch == protocol.CH_GDB
	}) {
		t.Fatal("non-owner received a GDB frame")
	}
}

func TestNonOwnerGdbWriteDropped(t *testing.T) {
	rec := &recordingHandle{}
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		return rec, nil
	})

	owner := dial(t, b.ListenPort(), "test-token")
	readHello(t, owner)
	other := dial(t, b.ListenPort(), "test-token")
	readHello(t, other)

	sendCtrl(t, owner, map[string]any{"type": "gdb-attach"})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && b.Snapshot().GDB.Phase != "connected" {
		time.Sleep(10 * time.Millisecond)
	}

	if err := other.WriteMessage(websocket.BinaryMessage, protocol.EncodeFrame(protocol.CH_GDB, []byte("$?#3f"))); err != nil {
		t.Fatal(err)
	}
	if err := owner.WriteMessage(websocket.BinaryMessage, protocol.EncodeFrame(protocol.CH_GDB, []byte("$g#67"))); err != nil {
		t.Fatal(err)
	}

	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if rec.String() == "+$g#67" {
			break // eager ack + the owner's packet; keep watching for intruders
		}
		time.Sleep(10 * time.Millisecond)
	}
	// A late intruder write must not trickle in after the owner's.
	time.Sleep(150 * time.Millisecond)
	if got := rec.String(); got != "+$g#67" {
		t.Fatalf("gdb server saw %q, want only the eager ack and the owner's packet", got)
	}
}

// A tab that dialed the proxy and died must not leave the GDB server's single
// gdb slot held; a tab that merely adopted a TUI attach must leave it alone.
func TestOwnerDisconnectDetachesCtrlInitiatedGdb(t *testing.T) {
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		return &nopHandle{}, nil
	})

	owner := dial(t, b.ListenPort(), "test-token")
	readHello(t, owner)
	sendCtrl(t, owner, map[string]any{"type": "gdb-attach"})
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && b.Snapshot().GDB.Phase != "connected" {
		time.Sleep(10 * time.Millisecond)
	}

	_ = owner.Close()
	deadline = time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if b.Snapshot().GDB.Phase == "idle" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("ctrl-initiated proxy still %q after owner disconnect", b.Snapshot().GDB.Phase)
}

func TestAdoptingOwnerDisconnectLeavesTuiGdbUp(t *testing.T) {
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		return &nopHandle{}, nil
	})

	// The TUI attaches; a page then adopts the session by writing to it.
	if err := b.AttachGdb("127.0.0.1", 3333); err != nil {
		t.Fatal(err)
	}
	page := dial(t, b.ListenPort(), "test-token")
	readHello(t, page)
	if err := page.WriteMessage(websocket.BinaryMessage, protocol.EncodeFrame(protocol.CH_GDB, []byte("+"))); err != nil {
		t.Fatal(err)
	}
	time.Sleep(100 * time.Millisecond)
	_ = page.Close()

	deadline := time.Now().Add(500 * time.Millisecond)
	for time.Now().Before(deadline) {
		if b.Snapshot().GDB.Phase != "connected" {
			t.Fatalf("adopting owner's death tore down the TUI's proxy: %q", b.Snapshot().GDB.Phase)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// The dial can take the whole 10 s timeout against a dead GDB host; run it
// off the readPump so the client's other channels keep flowing meanwhile.
func TestCtrlGdbAttachDoesNotBlockReadPump(t *testing.T) {
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	b := startGdbTestBridge(t, func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
		<-release // a dead host: the dial hangs until "the timeout"
		return &nopHandle{}, nil
	})

	c := dial(t, b.ListenPort(), "test-token")
	readHello(t, c)
	sendCtrl(t, c, map[string]any{"type": "gdb-attach"})
	sendCtrl(t, c, map[string]any{"type": "ping", "t": 42})
	if !readUntil(t, c, 2*time.Second, func(ch byte, payload []byte) bool {
		if ch != protocol.CH_CTRL {
			return false
		}
		var msg map[string]any
		_ = json.Unmarshal(payload, &msg)
		return msg["type"] == "pong"
	}) {
		t.Fatal("read pump stalled behind the gdb dial")
	}
}

func TestAutoSerial(t *testing.T) {
	tok := "test-token"
	var holder *fakeSerial
	b, err := server.Start(config.Config{
		Host: "127.0.0.1", Port: 0, Token: &tok, MaxClients: 2, BaudRate: 115200,
		PagesURL: "https://example.test/", NoTUI: true, EnableNet: false, AutoSerial: true,
		GdbHost: "127.0.0.1", GdbPort: 3333, Forwards: map[string]string{},
	}, server.Hooks{
		Log: func(string) {},
		ListPorts: func() ([]protocol.PortInfo, error) {
			return []protocol.PortInfo{{Path: "/dev/ttyONLY", FriendlyName: "Only"}}, nil
		},
		OpenSerial: func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (serial.Handle, error) {
			holder = &fakeSerial{path: path, baud: baud, onData: onData, onClose: onClose}
			return holder, nil
		},
		OpenGdb: func(host string, port int, onData func([]byte), onError func(error), onClose func()) (gdb.Handle, error) {
			return &nopHandle{}, nil
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = b.Close() })

	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if b.Snapshot().Serial.Phase == "streaming" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("auto-serial did not start: %+v", b.Snapshot().Serial)
}
