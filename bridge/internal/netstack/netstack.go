// Package netstack embeds gvisor-tap-vsock as a passt replacement.
// Each Session speaks QEMU stream-netdev framing on one side and exposes
// raw Ethernet frames (one at a time) for the WebSocket CH_NET channel.
package netstack

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"sync"

	"github.com/containers/gvisor-tap-vsock/pkg/types"
	"github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
)

const (
	minFrame = 14
	maxFrame = 2048
)

// DefaultConfig matches the in-page simulated LAN and net-uplink.conf:
// guest 192.0.2.1, gateway 192.0.2.2 (CONFIG_NET_CONFIG_MY_IPV4_GW), so
// static and DHCP Zephyr samples work the same as in Simulated LAN mode.
func DefaultConfig(forwards map[string]string) *types.Configuration {
	cfg := &types.Configuration{
		Debug:             false,
		MTU:               1500,
		Subnet:            "192.0.2.0/24",
		GatewayIP:         "192.0.2.2",
		GatewayMacAddress: "5a:94:ef:e4:0c:dd",
		GatewayVirtualIPs: []string{"192.0.2.254"},
		DHCPStaticLeases: map[string]string{
			// qemu_cortex_a53 / qemu_riscv32 virtio-net MAC
			"192.0.2.1": "02:00:00:00:00:01",
		},
		NAT: map[string]string{
			"192.0.2.254": "127.0.0.1",
		},
		DNS: []types.Zone{
			{
				Name: "containers.internal.",
				Records: []types.Record{
					{Name: "gateway", IP: net.ParseIP("192.0.2.2")},
					{Name: "host", IP: net.ParseIP("192.0.2.254")},
				},
			},
			{
				Name: "docker.internal.",
				Records: []types.Record{
					{Name: "gateway", IP: net.ParseIP("192.0.2.2")},
					{Name: "host", IP: net.ParseIP("192.0.2.254")},
				},
			},
		},
		Forwards: forwards,
	}
	if cfg.Forwards == nil {
		cfg.Forwards = map[string]string{}
	}
	return cfg
}

// Session is one guest ↔ one VirtualNetwork.
type Session struct {
	vn     *virtualnetwork.VirtualNetwork
	app    net.Conn
	cancel context.CancelFunc
	wg     sync.WaitGroup

	mu    sync.Mutex
	phase string
	detail string
}

// Start creates a VirtualNetwork and a QEMU-framed pipe. onFrame is called
// with bare Ethernet frames from the stack (to send as CH_NET).
func Start(forwards map[string]string, onFrame func([]byte), onError func(error), onClose func()) (*Session, error) {
	vn, err := virtualnetwork.New(DefaultConfig(forwards))
	if err != nil {
		return nil, fmt.Errorf("virtual network: %w", err)
	}

	qemuSide, appSide := net.Pipe()
	ctx, cancel := context.WithCancel(context.Background())

	s := &Session{
		vn:     vn,
		app:    appSide,
		cancel: cancel,
		phase:  "connecting",
	}

	s.wg.Add(2)
	go func() {
		defer s.wg.Done()
		err := vn.AcceptQemu(ctx, qemuSide)
		_ = qemuSide.Close()
		if err != nil && ctx.Err() == nil {
			s.setPhase("error", err.Error())
			if onError != nil {
				onError(err)
			}
		}
		s.setPhase("idle", "closed")
		if onClose != nil {
			onClose()
		}
	}()

	go func() {
		defer s.wg.Done()
		s.setPhase("connected", "")
		buf := make([]byte, 0, 2048)
		hdr := make([]byte, 4)
		for {
			if _, err := io.ReadFull(appSide, hdr); err != nil {
				return
			}
			n := binary.BigEndian.Uint32(hdr)
			if n < minFrame || n > maxFrame {
				if onError != nil {
					onError(fmt.Errorf("bad frame length %d", n))
				}
				return
			}
			if cap(buf) < int(n) {
				buf = make([]byte, n)
			} else {
				buf = buf[:n]
			}
			if _, err := io.ReadFull(appSide, buf); err != nil {
				return
			}
			frame := make([]byte, n)
			copy(frame, buf)
			if onFrame != nil {
				onFrame(frame)
			}
		}
	}()

	return s, nil
}

func (s *Session) WriteFrame(frame []byte) error {
	if len(frame) < minFrame || len(frame) > maxFrame {
		return fmt.Errorf("frame length %d out of range", len(frame))
	}
	hdr := make([]byte, 4)
	binary.BigEndian.PutUint32(hdr, uint32(len(frame)))
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.app.Write(hdr); err != nil {
		return err
	}
	_, err := s.app.Write(frame)
	return err
}

func (s *Session) Phase() (phase, detail string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.phase, s.detail
}

func (s *Session) setPhase(phase, detail string) {
	s.mu.Lock()
	s.phase = phase
	s.detail = detail
	s.mu.Unlock()
}

func (s *Session) Close() {
	s.cancel()
	_ = s.app.Close()
	s.wg.Wait()
}
