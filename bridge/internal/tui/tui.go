package tui

import (
	"fmt"
	"os"
	"strings"
	"sync"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
	"golang.org/x/term"
)

// refreshEvery keeps the byte counters honest: the bridge throttles the status
// pings it derives from raw traffic, so the last chunk before a port falls
// quiet may never get one of its own.
const refreshEvery = time.Second

// Host is the subset of *server.Bridge the TUI drives.
type Host interface {
	Snapshot() server.Snapshot
	SubscribeStatus(func(server.Snapshot)) (unsubscribe func())
	RefreshPorts() error
	StopSerial()
	SelectSerial(path string, baud int) error
	AttachGdb(host string, port int) error
	DetachGdb()
	Close() error
}

type statusMsg server.Snapshot

// actionMsg carries the result of a host call that ran off the event loop.
type actionMsg struct{ err error }

type tickMsg struct{}

// hostCmd runs a host call in its own goroutine. Host calls block — opening a
// port, dialling a GDB server — and anything run inline from Update stalls the
// event loop for its whole duration.
func hostCmd(fn func() error) tea.Cmd {
	return func() tea.Msg { return actionMsg{err: fn()} }
}

func tickCmd() tea.Cmd {
	return tea.Tick(refreshEvery, func(time.Time) tea.Msg { return tickMsg{} })
}

// statusPump decouples the bridge's status callbacks from the Bubble Tea event
// loop. The bridge invokes listeners inline on whichever goroutine mutated
// state — including the event loop itself, via Update → SelectSerial →
// notifyStatus. Program.Send blocks until the event loop drains p.msgs (an
// unbuffered channel), so sending from there deadlocks the loop against
// itself: the TUI wedges hard, Ctrl-C included, and the process has to be
// killed. push() must therefore never block.
//
// Only the newest snapshot matters, so a full queue coalesces rather than
// growing: a busy port would otherwise back up a run of stale frames.
type statusPump struct {
	mu     sync.Mutex
	latest *server.Snapshot
	wake   chan struct{}
}

func newStatusPump() *statusPump {
	return &statusPump{wake: make(chan struct{}, 1)}
}

func (p *statusPump) push(s server.Snapshot) {
	p.mu.Lock()
	p.latest = &s
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default: // a wake is already pending; it will pick up this snapshot
	}
}

func (p *statusPump) take() (server.Snapshot, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.latest == nil {
		return server.Snapshot{}, false
	}
	s := *p.latest
	p.latest = nil
	return s, true
}

type model struct {
	host     Host
	baud     int
	snap     server.Snapshot
	selected int
	help     bool
	errMsg   string
	width    int
}

var (
	boldStyle   = lipgloss.NewStyle().Bold(true)
	dimStyle    = lipgloss.NewStyle().Faint(true)
	cyanStyle   = lipgloss.NewStyle().Foreground(lipgloss.Color("6"))
	greenStyle  = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	yellowStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	redStyle    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
)

// Run blocks until quit. Falls back to headless if stdin is not a TTY.
func Run(bridge Host, baud int) error {
	in := os.Stdin
	out := os.Stdout
	if !term.IsTerminal(int(in.Fd())) || !term.IsTerminal(int(out.Fd())) {
		return runHeadless(bridge)
	}

	err := runProgram(bridge, baud, tea.WithAltScreen(), tea.WithInput(in), tea.WithOutput(out))
	_ = bridge.Close()
	return err
}

func runProgram(bridge Host, baud int, opts ...tea.ProgramOption) error {
	m := model{
		host:  bridge,
		baud:  baud,
		snap:  bridge.Snapshot(),
		width: 80,
	}
	p := tea.NewProgram(m, opts...)

	pump := newStatusPump()
	unsub := bridge.SubscribeStatus(pump.push)
	defer unsub()

	// Forward coalesced snapshots from a goroutine of our own, so the blocking
	// Send never runs on a goroutine the bridge called us from.
	done := make(chan struct{})
	defer close(done)
	go func() {
		for {
			select {
			case <-done:
				return
			case <-pump.wake:
				if s, ok := pump.take(); ok {
					p.Send(statusMsg(s))
				}
			}
		}
	}()

	_, err := p.Run()
	return err
}

func (m model) Init() tea.Cmd { return tickCmd() }

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		if msg.Width > 0 {
			m.width = msg.Width
		}
	case statusMsg:
		m.snap = server.Snapshot(msg)
		if m.selected >= len(m.snap.Ports) {
			m.selected = max(0, len(m.snap.Ports)-1)
		}
	case tickMsg:
		m.snap = m.host.Snapshot()
		if m.selected >= len(m.snap.Ports) {
			m.selected = max(0, len(m.snap.Ports)-1)
		}
		return m, tickCmd()
	case actionMsg:
		if msg.err != nil {
			m.errMsg = msg.err.Error()
		}
	case tea.KeyMsg:
		host := m.host
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "?", "h":
			m.help = !m.help
		case "r":
			return m, hostCmd(host.RefreshPorts)
		case "s":
			m.errMsg = ""
			return m, hostCmd(func() error { host.StopSerial(); return nil })
		case "g":
			m.errMsg = ""
			return m, hostCmd(func() error {
				st := host.Snapshot().GDB
				return host.AttachGdb(st.Host, st.Port)
			})
		case "G":
			return m, hostCmd(func() error { host.DetachGdb(); return nil })
		case "up", "k":
			if m.selected > 0 {
				m.selected--
			}
		case "down", "j":
			if m.selected < len(m.snap.Ports)-1 {
				m.selected++
			}
		case "enter":
			if m.selected < 0 || m.selected >= len(m.snap.Ports) {
				m.errMsg = "No port selected"
				break
			}
			m.errMsg = ""
			path, baud := m.snap.Ports[m.selected].Path, m.baud
			return m, hostCmd(func() error { return host.SelectSerial(path, baud) })
		}
	}
	return m, nil
}

func (m model) View() string {
	return render(m.snap, m.selected, m.help, m.errMsg, m.width)
}

func render(s server.Snapshot, selected int, help bool, errMsg string, width int) string {
	if width <= 0 {
		width = 80
	}
	var lines []string
	add := func(line string) {
		lines = append(lines, ansi.Truncate(line, width, "…"))
	}

	add(boldStyle.Render("Zephyr bridge") + "  " + dimStyle.Render("v"+s.Version))
	add("")
	add(cyanStyle.Render("WebSocket") + "  " + s.WSURL)
	add(cyanStyle.Render("Open") + "       " + s.DeepLink)
	add("")
	add(boldStyle.Render("Serial ports") + "  " + dimStyle.Render("(↑↓ select · enter stream · s stop · r refresh)"))

	if len(s.Ports) == 0 {
		add("  " + dimStyle.Render("No serial ports yet. Plug in a board or probe."))
	} else {
		for i, p := range s.Ports {
			active := s.Serial.Path != nil && *s.Serial.Path == p.Path && s.Serial.Phase == "streaming"
			cursor := " "
			if i == selected {
				cursor = "›"
			}
			mark := dimStyle.Render("○")
			if active {
				mark = greenStyle.Render("●")
			}
			add(fmt.Sprintf("  %s %s %s  %s", cursor, mark, p.Path, dimStyle.Render(p.FriendlyName)))
		}
	}

	add("")
	add(fmt.Sprintf("%s   %s%s  %s",
		boldStyle.Render("CTF"),
		phaseStyle(s.Serial.Phase).Render(s.Serial.Phase),
		serialSuffix(s),
		dimStyle.Render(fmt.Sprintf("%d B", s.CtfBytes)),
	))
	add(fmt.Sprintf("%s   %s  %s:%d%s  %s",
		boldStyle.Render("GDB"),
		phaseStyle(s.GDB.Phase).Render(s.GDB.Phase),
		s.GDB.Host, s.GDB.Port,
		gdbDetail(s),
		dimStyle.Render(fmt.Sprintf("%d B", s.GdbBytes)),
	))

	netLabel := "unavailable"
	netStyle := dimStyle
	if s.NetReady {
		netLabel = "ready (gvisor)"
		netStyle = greenStyle
	}
	add(boldStyle.Render("Net") + "   " + netStyle.Render(netLabel))
	add(fmt.Sprintf("%s  %d/%d", boldStyle.Render("Clients"), s.Clients, s.MaxClients))
	if errMsg != "" {
		add(redStyle.Render(errMsg))
	}
	add("")
	if help {
		add(yellowStyle.Render("Keys"))
		add("  enter  stream CTF from the selected port")
		add("  s      stop serial stream")
		add("  g      attach GDB proxy (OpenOCD / J-Link on host:port)")
		add("  G      detach GDB")
		add("  r      refresh port list")
		add("  ?      toggle this help")
		add("  q      quit (Ctrl-C also works)")
		add("")
	}
	add(dimStyle.Render("[?] help  [g] GDB  [q] quit · daemon stays up if you only unplug the board"))

	return strings.Join(lines, "\n")
}

func phaseStyle(phase string) lipgloss.Style {
	switch phase {
	case "streaming", "connected":
		return greenStyle
	case "error":
		return redStyle
	default:
		return dimStyle
	}
}

func serialSuffix(s server.Snapshot) string {
	out := ""
	if s.Serial.Path != nil {
		out += fmt.Sprintf("  %s @ %d", *s.Serial.Path, s.Serial.BaudRate)
	}
	if s.Serial.Detail != "" {
		out += "  " + dimStyle.Render(s.Serial.Detail)
	}
	return out
}

func gdbDetail(s server.Snapshot) string {
	if s.GDB.Detail == "" {
		return ""
	}
	return "  " + dimStyle.Render(s.GDB.Detail)
}

func runHeadless(bridge Host) error {
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
