package gdb

import (
	"io"
	"net"
	"strconv"
	"sync"
)

type Handle interface {
	Close() error
	Write([]byte) (int, error)
}

type Opener func(host string, port int, onData func([]byte), onError func(error), onClose func()) (Handle, error)

func DefaultOpener() Opener {
	return func(host string, port int, onData func([]byte), onError func(error), onClose func()) (Handle, error) {
		addr := net.JoinHostPort(host, strconv.Itoa(port))
		conn, err := net.Dial("tcp", addr)
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
	return h.conn.Write(b)
}
