package protocol_test

import (
	"testing"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
)

func TestFrameRoundTrip(t *testing.T) {
	for _, ch := range []byte{protocol.CH_CTF, protocol.CH_GDB, protocol.CH_NET, protocol.CH_CTRL} {
		payload := []byte("hello")
		raw := protocol.EncodeFrame(ch, payload)
		gotCh, gotPayload, ok := protocol.DecodeFrame(raw)
		if !ok {
			t.Fatal("decode failed")
		}
		if gotCh != ch {
			t.Fatalf("channel %d != %d", gotCh, ch)
		}
		if string(gotPayload) != "hello" {
			t.Fatalf("payload %q", gotPayload)
		}
	}
}

func TestDecodeEmpty(t *testing.T) {
	if _, _, ok := protocol.DecodeFrame(nil); ok {
		t.Fatal("expected fail")
	}
}

func TestCtrlRoundTrip(t *testing.T) {
	raw, err := protocol.EncodeCtrl(map[string]any{"type": "ping", "t": 1})
	if err != nil {
		t.Fatal(err)
	}
	ch, payload, ok := protocol.DecodeFrame(raw)
	if !ok || ch != protocol.CH_CTRL {
		t.Fatalf("bad frame ch=%d ok=%v", ch, ok)
	}
	var msg map[string]any
	if err := protocol.DecodeCtrl(payload, &msg); err != nil {
		t.Fatal(err)
	}
	if msg["type"] != "ping" {
		t.Fatalf("%v", msg)
	}
}
