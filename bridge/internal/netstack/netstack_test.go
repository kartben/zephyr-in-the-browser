package netstack_test

import (
	"bytes"
	"testing"
	"time"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/netstack"
)

func TestSessionRoundTripSmoke(t *testing.T) {
	got := make(chan []byte, 1)
	sess, err := netstack.Start(nil, func(frame []byte) {
		select {
		case got <- append([]byte(nil), frame...):
		default:
		}
	}, func(error) {}, func() {})
	if err != nil {
		t.Fatal(err)
	}
	defer sess.Close()

	// Minimal Ethernet broadcast ARP-ish frame (60 bytes padded).
	frame := make([]byte, 60)
	for i := range frame {
		frame[i] = 0xff
	}
	frame[12], frame[13] = 0x08, 0x06

	if err := sess.WriteFrame(frame); err != nil {
		t.Fatal(err)
	}

	// Stack may or may not emit a reply quickly; at least phase should be connected.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		phase, _ := sess.Phase()
		if phase == "connected" {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	phase, detail := sess.Phase()
	t.Fatalf("phase=%s detail=%s (got reply %v)", phase, detail, len(got) > 0 && bytes.Equal(<-got, frame))
}
