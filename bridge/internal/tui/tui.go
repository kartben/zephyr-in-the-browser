package tui

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
	"golang.org/x/term"
)

const (
	esc    = "\x1b"
	hide   = esc + "[?25l"
	show   = esc + "[?25h"
	altOn  = esc + "[?1049h"
	altOff = esc + "[?1049l"
	clear  = esc + "[2J" + esc + "[H"
	dim    = esc + "[2m"
	reset  = esc + "[0m"
	bold   = esc + "[1m"
	green  = esc + "[32m"
	yellow = esc + "[33m"
	red    = esc + "[31m"
	cyan   = esc + "[36m"
)

// Run blocks until quit. Falls back to headless if stdin is not a TTY.
func Run(bridge *server.Bridge, baud int) error {
	in := os.Stdin
	out := os.Stdout
	if !term.IsTerminal(int(in.Fd())) || !term.IsTerminal(int(out.Fd())) {
		return runHeadless(bridge)
	}

	oldState, err := term.MakeRaw(int(in.Fd()))
	if err != nil {
		return runHeadless(bridge)
	}
	defer func() { _ = term.Restore(int(in.Fd()), oldState) }()

	_, _ = out.WriteString(altOn + hide)
	defer func() { _, _ = out.WriteString(show + altOff) }()

	var mu sync.Mutex
	selected := 0
	help := false
	lastErr := ""
	snap := bridge.Snapshot()

	draw := func() {
		mu.Lock()
		s := snap
		sel := selected
		h := help
		errMsg := lastErr
		mu.Unlock()

		cols, _, _ := term.GetSize(int(out.Fd()))
		if cols <= 0 {
			cols = 80
		}
		_, _ = out.WriteString(clear + hide + renderFrame(s, sel, h, errMsg, cols))
	}

	unsub := bridge.SubscribeStatus(func(s server.Snapshot) {
		mu.Lock()
		snap = s
		if selected >= len(s.Ports) {
			selected = max(0, len(s.Ports)-1)
		}
		mu.Unlock()
		draw()
	})
	defer unsub()

	buf := make([]byte, 32)
	for {
		n, err := in.Read(buf)
		if err != nil || n == 0 {
			return err
		}
		key := string(buf[:n])
		switch {
		case key == "\x03" || key == "q" || key == "Q":
			return bridge.Close()
		case key == "?" || key == "h":
			mu.Lock()
			help = !help
			mu.Unlock()
			draw()
		case key == "r" || key == "R":
			_ = bridge.RefreshPorts()
		case key == "s" || key == "S":
			bridge.StopSerial()
			mu.Lock()
			lastErr = ""
			mu.Unlock()
		case key == "g":
			st := bridge.Snapshot().GDB
			if err := bridge.AttachGdb(st.Host, st.Port); err != nil {
				mu.Lock()
				lastErr = err.Error()
				mu.Unlock()
				draw()
			} else {
				mu.Lock()
				lastErr = ""
				mu.Unlock()
			}
		case key == "G":
			bridge.DetachGdb()
		case key == "\x1b[A" || key == "k":
			mu.Lock()
			if selected > 0 {
				selected--
			}
			mu.Unlock()
			draw()
		case key == "\x1b[B" || key == "j":
			mu.Lock()
			if selected < len(snap.Ports)-1 {
				selected++
			}
			mu.Unlock()
			draw()
		case key == "\r" || key == "\n":
			mu.Lock()
			ports := snap.Ports
			sel := selected
			mu.Unlock()
			if sel < 0 || sel >= len(ports) {
				mu.Lock()
				lastErr = "No port selected"
				mu.Unlock()
				draw()
				continue
			}
			mu.Lock()
			lastErr = ""
			mu.Unlock()
			_ = bridge.SelectSerial(ports[sel].Path, baud)
		}
	}
}

// renderFrame builds one full-screen frame. MakeRaw clears OPOST/ONLCR, so
// every line must end with \r\n or the cursor stair-steps across the screen.
func renderFrame(s server.Snapshot, selected int, help bool, errMsg string, cols int) string {
	var lines []string
	lines = append(lines, fmt.Sprintf("%sZephyr bridge%s  %sv%s%s", bold, reset, dim, s.Version, reset))
	lines = append(lines, "")
	lines = append(lines, fmt.Sprintf("%sWebSocket%s  %s", cyan, reset, s.WSURL))
	lines = append(lines, fmt.Sprintf("%sOpen%s       %s", cyan, reset, s.DeepLink))
	lines = append(lines, "")
	lines = append(lines, fmt.Sprintf("%sSerial ports%s  %s(↑↓ select · enter stream · s stop · r refresh)%s", bold, reset, dim, reset))

	if len(s.Ports) == 0 {
		lines = append(lines, fmt.Sprintf("  %sNo serial ports yet. Plug in a board or probe.%s", dim, reset))
	} else {
		for i, p := range s.Ports {
			active := s.Serial.Path != nil && *s.Serial.Path == p.Path && s.Serial.Phase == "streaming"
			cursor := " "
			if i == selected {
				cursor = "›"
			}
			mark := fmt.Sprintf("%s○%s", dim, reset)
			if active {
				mark = fmt.Sprintf("%s●%s", green, reset)
			}
			lines = append(lines, fmt.Sprintf("  %s %s %s  %s%s%s", cursor, mark, p.Path, dim, p.FriendlyName, reset))
		}
	}

	lines = append(lines, "")
	phaseColor := dim
	switch s.Serial.Phase {
	case "streaming":
		phaseColor = green
	case "error":
		phaseColor = red
	}
	path := ""
	if s.Serial.Path != nil {
		path = fmt.Sprintf("  %s @ %d", *s.Serial.Path, s.Serial.BaudRate)
	}
	detail := ""
	if s.Serial.Detail != "" {
		detail = fmt.Sprintf("  %s%s%s", dim, s.Serial.Detail, reset)
	}
	lines = append(lines, fmt.Sprintf("%sCTF%s   %s%s%s%s%s  %s%d B%s",
		bold, reset, phaseColor, s.Serial.Phase, reset, path, detail, dim, s.CtfBytes, reset))

	gdbColor := dim
	switch s.GDB.Phase {
	case "connected":
		gdbColor = green
	case "error":
		gdbColor = red
	}
	gdbDetail := ""
	if s.GDB.Detail != "" {
		gdbDetail = fmt.Sprintf("  %s%s%s", dim, s.GDB.Detail, reset)
	}
	lines = append(lines, fmt.Sprintf("%sGDB%s   %s%s%s  %s:%d%s  %s%d B%s",
		bold, reset, gdbColor, s.GDB.Phase, reset, s.GDB.Host, s.GDB.Port, gdbDetail, dim, s.GdbBytes, reset))

	netColor := dim
	netLabel := "unavailable"
	if s.NetReady {
		netColor = green
		netLabel = "ready (gvisor)"
	}
	lines = append(lines, fmt.Sprintf("%sNet%s   %s%s%s", bold, reset, netColor, netLabel, reset))
	lines = append(lines, fmt.Sprintf("%sClients%s  %d/%d", bold, reset, s.Clients, s.MaxClients))
	if errMsg != "" {
		lines = append(lines, fmt.Sprintf("%s%s%s", red, errMsg, reset))
	}
	lines = append(lines, "")
	if help {
		lines = append(lines, yellow+"Keys"+reset)
		lines = append(lines, "  enter  stream CTF from the selected port")
		lines = append(lines, "  s      stop serial stream")
		lines = append(lines, "  g      attach GDB proxy (OpenOCD / J-Link on host:port)")
		lines = append(lines, "  G      detach GDB")
		lines = append(lines, "  r      refresh port list")
		lines = append(lines, "  ?      toggle this help")
		lines = append(lines, "  q      quit (Ctrl-C also works)")
		lines = append(lines, "")
	}
	lines = append(lines, fmt.Sprintf("%s[?] help  [g] GDB  [q] quit · daemon stays up if you only unplug the board%s", dim, reset))

	for i, line := range lines {
		lines[i] = clip(line, cols)
	}
	// MakeRaw disables ONLCR, so LF alone moves the cursor down without
	// returning it to column zero. Emit CRLF explicitly for each row.
	return strings.Join(lines, "\r\n") + "\r\n"
}

// clip truncates a possibly ANSI-colored string to fit cols display columns.
func clip(s string, cols int) string {
	if cols <= 3 {
		return s
	}
	visible := 0
	for i := 0; i < len(s); {
		if s[i] == '\x1b' {
			// Skip CSI / SGR sequences so colors don't count toward width.
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
		if visible+1 >= cols {
			return s[:i] + "…" + reset
		}
		visible++
		i += size
	}
	return s
}

func runHeadless(bridge *server.Bridge) error {
	unsub := bridge.SubscribeStatus(func(s server.Snapshot) {
		fmt.Fprintf(os.Stderr, "[bridge] status clients=%d/%d serial=%s net=%v ctf=%d B\n",
			s.Clients, s.MaxClients, s.Serial.Phase, s.NetReady, s.CtfBytes)
	})
	defer unsub()
	select {}
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
