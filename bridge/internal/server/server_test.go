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
