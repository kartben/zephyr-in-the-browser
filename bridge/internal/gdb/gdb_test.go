package gdb

import (
	"net"
	"testing"
	"time"
)

// A GDB target that accepts the TCP connection but never reads from it
// reproduces a stalled OpenOCD/J-Link: the OS send buffer fills and Write
// blocks. Before writeTimeout existed this hung forever and, since Write is
// called from the bridge's per-client WebSocket read loop, froze every other
// message for that client along with it.
func TestWriteTimesOutOnStalledPeer(t *testing.T) {
	orig := writeTimeout
	writeTimeout = 100 * time.Millisecond
	defer func() { writeTimeout = orig }()

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	h, err := DefaultOpener()(addr.IP.String(), addr.Port, func([]byte) {}, func(error) {}, func() {})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer h.Close()

	peer := <-accepted
	defer peer.Close()
	// Deliberately never read from peer: the send buffer fills and Write blocks.

	big := make([]byte, 4<<20) // comfortably larger than any default OS socket buffer
	done := make(chan error, 1)
	go func() {
		_, err := h.Write(big)
		done <- err
	}()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("expected a deadline-exceeded error, got nil")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("Write did not return within 2s of a 100ms deadline — it hung")
	}
}

func TestWriteSucceedsOnResponsivePeer(t *testing.T) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	defer ln.Close()

	accepted := make(chan net.Conn, 1)
	go func() {
		c, err := ln.Accept()
		if err == nil {
			accepted <- c
		}
	}()

	addr := ln.Addr().(*net.TCPAddr)
	h, err := DefaultOpener()(addr.IP.String(), addr.Port, func([]byte) {}, func(error) {}, func() {})
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer h.Close()

	peer := <-accepted
	defer peer.Close()
	go drainReads(peer)

	if _, err := h.Write([]byte("$g#67")); err != nil {
		t.Fatalf("Write: %v", err)
	}
}

func drainReads(c net.Conn) {
	buf := make([]byte, 4096)
	for {
		if _, err := c.Read(buf); err != nil {
			return
		}
	}
}
