package tui

import (
	"strings"
	"testing"
	"unicode/utf8"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
)

func TestRenderFrameUsesCRLF(t *testing.T) {
	path := "/dev/cu.usbmodem1234"
	frame := renderFrame(server.Snapshot{
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
	}, 0, false, "", 80)

	if !strings.Contains(frame, "\r\n") {
		t.Fatal("frame missing \\r\\n; raw-mode terminals stair-step on bare \\n")
	}
	stripped := strings.ReplaceAll(frame, "\r\n", "")
	if strings.Contains(stripped, "\n") || strings.Contains(stripped, "\r") {
		t.Fatalf("frame has bare CR/LF outside \\r\\n pairs: %q", frame)
	}
	if !strings.Contains(frame, "Zephyr bridge") {
		t.Fatal("missing title")
	}
	if !strings.Contains(frame, "ready (gvisor)") {
		t.Fatal("missing net status")
	}
	if !strings.Contains(frame, path) {
		t.Fatal("missing selected port")
	}
}

func TestRenderFrameClipsLongDeepLink(t *testing.T) {
	long := "https://example.com/?" + strings.Repeat("x", 200)
	frame := renderFrame(server.Snapshot{
		Version:  "0.2.0",
		WSURL:    "ws://localhost:8740",
		DeepLink: long,
		GDB:      protocol.GdbStatus{Host: "127.0.0.1", Port: 3333, Phase: "idle"},
	}, 0, false, "", 40)

	for _, line := range strings.Split(strings.TrimSuffix(frame, "\r\n"), "\r\n") {
		if visibleWidth(line) > 40 {
			t.Fatalf("line wider than cols: %q (width %d)", line, visibleWidth(line))
		}
	}
}

func visibleWidth(s string) int {
	n := 0
	for i := 0; i < len(s); {
		if s[i] == '\x1b' {
			j := i + 1
			if j < len(s) && s[j] == '[' {
				j++
				for j < len(s) {
					c := s[j]
					j++
					if c >= '@' && c <= '~' {
						break
					}
				}
				i = j
				continue
			}
		}
		_, size := utf8.DecodeRuneInString(s[i:])
		n++
		i += size
	}
	return n
}

func TestClipPreservesShort(t *testing.T) {
	in := bold + "hi" + reset
	if got := clip(in, 80); got != in {
		t.Fatalf("got %q", got)
	}
}
