package gdb

import (
	"io"
	"net"
	"strconv"
	"sync"
	"time"
)

// writeTimeout bounds a single Write to the GDB server (OpenOCD, J-Link,
// etc). Without it, a stalled or unresponsive target blocks forever inside
// net.Conn.Write — and since Write is called synchronously from the bridge's
// per-client WebSocket read loop, that one stuck GDB write freezes every
// other message (CTF control, net) for that client too.
//
// A var, not a const, so tests can shrink it instead of waiting out the real
// deadline.
var writeTimeout = 10 * time.Second

// dialTimeout bounds the initial connect to the GDB server. Go's net.Dial
// inherits the OS connect timeout, which on a filtered or unreachable host is
// well over a minute of silence. Attach now runs off the TUI's event loop so
// this no longer freezes the UI, but an unbounded dial still leaves "g"
// looking dead for a minute with no way to back out.
//
// A var, not a const, for the same reason as writeTimeout.
var dialTimeout = 10 * time.Second

type Handle interface {
	Close() error
	Write([]byte) (int, error)
}

type Opener func(host string, port int, onData func([]byte), onError func(error), onClose func()) (Handle, error)

func DefaultOpener() Opener {
	return func(host string, port int, onData func([]byte), onError func(error), onClose func()) (Handle, error) {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		conn, err := net.DialTimeout("tcp", addr, dialTimeout)
		if err != nil {
			return nil, err
		}
		h := &live{conn: conn, done: make(chan struct{})}
		go func() {
			buf := make([]byte, 4096)
			for {
				n, err := conn.Read(buf)
				if n > 0 {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					onData(chunk)
				}
				if err != nil {
					if err != io.EOF {
						select {
						case <-h.done:
						default:
							onError(err)
						}
					}
					onClose()
					return
				}
			}
		}()
		return h, nil
	}
}

type live struct {
	conn net.Conn
	done chan struct{}
	once sync.Once
	mu   sync.Mutex
}

func (h *live) Close() error {
	h.once.Do(func() { close(h.done) })
	return h.conn.Close()
}

func (h *live) Write(b []byte) (int, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	_ = h.conn.SetWriteDeadline(time.Now().Add(writeTimeout))
	return h.conn.Write(b)
}
