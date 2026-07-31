package serial

import (
	"fmt"
	"sort"
	"strings"
	"sync"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	goserial "go.bug.st/serial"
)

// Lister can be swapped in tests.
type Lister func() ([]protocol.PortInfo, error)

// Opener opens a port; tests inject fakes.
type Opener func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (Handle, error)

type Handle interface {
	Close() error
	Write([]byte) (int, error)
}

type Port struct {
	mu     sync.Mutex
	handle Handle
	Path   string
	Baud   int
	Phase  string
	Detail string
}

func DefaultLister() Lister {
	return func() ([]protocol.PortInfo, error) {
		ports, err := goserial.GetPortsList()
		if err != nil {
			return nil, err
		}
		sort.Strings(ports)
		out := make([]protocol.PortInfo, 0, len(ports))
		for _, p := range ports {
			name := "serial port"
			out = append(out, protocol.PortInfo{
				Path:         p,
				FriendlyName: name,
			})
		}
		return out, nil
	}
}

func DefaultOpener() Opener {
	return func(path string, baud int, onData func([]byte), onError func(error), onClose func()) (Handle, error) {
		mode := &goserial.Mode{BaudRate: baud}
		port, err := goserial.Open(path, mode)
		if err != nil {
			return nil, err
		}
		h := &liveHandle{port: port, done: make(chan struct{})}
		go func() {
			buf := make([]byte, 4096)
			for {
				n, err := port.Read(buf)
				if n > 0 {
					chunk := make([]byte, n)
					copy(chunk, buf[:n])
					onData(chunk)
				}
				if err != nil {
					select {
					case <-h.done:
						onClose()
					default:
						onError(err)
						onClose()
					}
					return
				}
			}
		}()
		// Zephyr UART-CTF host start (best-effort).
		_, _ = port.Write([]byte("enable\r"))
		return h, nil
	}
}

type liveHandle struct {
	port goserial.Port
	done chan struct{}
	once sync.Once
}

func (h *liveHandle) Close() error {
	h.once.Do(func() { close(h.done) })
	return h.port.Close()
}

func (h *liveHandle) Write(b []byte) (int, error) {
	return h.port.Write(b)
}

func FriendlyName(manufacturer, serial, vid, pid string) string {
	parts := []string{}
	if manufacturer != "" {
		parts = append(parts, manufacturer)
	}
	if serial != "" {
		parts = append(parts, serial)
	}
	if len(parts) > 0 {
		return strings.Join(parts, " · ")
	}
	if vid != "" || pid != "" {
		return fmt.Sprintf("%s:%s", vid, pid)
	}
	return "serial port"
}
