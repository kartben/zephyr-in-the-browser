package tui

import (
	"context"
	"errors"
	"fmt"
	"os"
	"strings"
	"sync"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
	"github.com/charmbracelet/x/ansi"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
	"golang.org/x/term"
)

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

// actionErrMsg reports the result of a host command back to the model and
// clears the busy state. An empty text means the action succeeded.
type actionErrMsg struct{ text string }

type model struct {
	host     Host
	baud     int
	snap     server.Snapshot
	selected int
	help     bool
	errMsg   string
	busy     string
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

// statusPump decouples the bridge's status callbacks from the Bubble Tea
// event loop.
//
// server.Bridge runs status listeners synchronously, on whichever goroutine
// produced the change, while tea.Program.Send blocks on an unbuffered channel
// until the event loop picks the message up. A listener that called Send
// directly would therefore:
//
//   - deadlock outright whenever the notifying goroutine *is* the event loop.
//     Update runs inline on the goroutine that drains the message channel, so
//     a host call made from a key handler ends up waiting on a reader that is
//     itself blocked inside that very call. Every action key hit this.
//   - stall the bridge's serial reader behind the TUI's render loop the rest
//     of the time, since SelectSerial notifies once per CTF chunk.
//
// Snapshots are whole-state, so a superseded one carries no information: the
// pump keeps only the latest and drops intermediates under load.
type statusPump struct {
	mu     sync.Mutex
	latest *server.Snapshot
	wake   chan struct{}
}

func newStatusPump() *statusPump {
	// Buffered by one: a wake already in flight will observe whatever push
	// stored most recently, so extra wakes would be redundant.
	return &statusPump{wake: make(chan struct{}, 1)}
}

// push records a snapshot. It never blocks, so it is safe to call from any
// bridge goroutine, including the event loop itself.
func (p *statusPump) push(s server.Snapshot) {
	p.mu.Lock()
	p.latest = &s
	p.mu.Unlock()
	select {
	case p.wake <- struct{}{}:
	default:
	}
}

// take returns the most recent snapshot pushed since the last take.
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

// run forwards snapshots to send until stop is closed. send is expected to
// block (it is tea.Program.Send); that is the point — the blocking happens
// here rather than on a bridge goroutine.
func (p *statusPump) run(send func(tea.Msg), stop <-chan struct{}) {
	for {
		select {
		case <-stop:
			return
		case <-p.wake:
			if s, ok := p.take(); ok {
				send(statusMsg(s))
			}
		}
	}
}

// Run blocks until quit or ctx is cancelled. Falls back to headless if stdin
// is not a TTY. Cancelling ctx (e.g. on SIGINT/SIGTERM) stops the program the
// same way [tea.Program.Kill] does: the terminal is restored before Run
// returns, so an external signal exits as cleanly as pressing q.
func Run(ctx context.Context, bridge Host, baud int) error {
	in := os.Stdin
	out := os.Stdout
	if !term.IsTerminal(int(in.Fd())) || !term.IsTerminal(int(out.Fd())) {
		return runHeadless(ctx, bridge)
	}

	m := model{
		host:  bridge,
		baud:  baud,
		snap:  bridge.Snapshot(),
		width: 80,
	}
	// WithoutSignalHandler: main owns SIGINT/SIGTERM via ctx. Bubble Tea's own
	// built-in handler would otherwise race it — both react to the same OS
	// signal independently, and when its handler wins that race the event
	// loop can exit believing it wasn't killed, which skips straight to a
	// final render that deadlocks with the renderer goroutine mid-teardown.
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithInput(in), tea.WithOutput(out), tea.WithContext(ctx), tea.WithoutSignalHandler())

	// push never blocks, so subscribing inline here is safe even though the
	// bridge delivers an initial snapshot before SubscribeStatus returns.
	pump := newStatusPump()
	unsub := bridge.SubscribeStatus(pump.push)
	pumpDone := make(chan struct{})
	go pump.run(p.Send, pumpDone)

	_, err := p.Run()
	// Once Run returns, the program context is cancelled and a Send in flight
	// unblocks on its own, so this cannot wedge on teardown.
	close(pumpDone)
	unsub()
	_ = bridge.Close()
	// Context cancellation is a normal shutdown path here, not a failure —
	// the terminal is already restored by the time Run() returns it.
	if errors.Is(err, tea.ErrProgramKilled) && ctx.Err() != nil {
		return nil
	}
	return err
}

func (m model) Init() tea.Cmd { return nil }

// hostCmd runs a blocking host call off the event loop.
//
// Bubble Tea calls Update on the same goroutine that drains its message
// channel, so a host call made inline there freezes the whole UI for its
// duration — and deadlocks if it notifies status listeners on the way (see
// statusPump). Commands run on their own goroutine, which is where any call
// that can block on a serial port or a TCP dial belongs.
func hostCmd(fn func() error) tea.Cmd {
	return func() tea.Msg {
		if err := fn(); err != nil {
			return actionErrMsg{text: err.Error()}
		}
		return actionErrMsg{}
	}
}

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
	case actionErrMsg:
		m.busy = ""
		m.errMsg = msg.text
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "?", "h":
			m.help = !m.help
		case "up", "k":
			if m.selected > 0 {
				m.selected--
			}
		case "down", "j":
			if m.selected < len(m.snap.Ports)-1 {
				m.selected++
			}
		}

		// Action keys dispatch work to a command goroutine. Ignore them while
		// one is already in flight: without that, holding g would stack
		// concurrent AttachGdb calls, each of which detaches the previous
		// one's handle mid-dial.
		if m.busy != "" {
			return m, nil
		}
		host := m.host
		switch msg.String() {
		case "r":
			m.busy = "refreshing ports"
			return m, hostCmd(host.RefreshPorts)
		case "s":
			m.busy = "stopping serial"
			return m, hostCmd(func() error { host.StopSerial(); return nil })
		case "g":
			m.busy = "attaching GDB"
			return m, hostCmd(func() error {
				st := host.Snapshot().GDB
				return host.AttachGdb(st.Host, st.Port)
			})
		case "G":
			m.busy = "detaching GDB"
			return m, hostCmd(func() error { host.DetachGdb(); return nil })
		case "enter":
			if m.selected < 0 || m.selected >= len(m.snap.Ports) {
				m.errMsg = "No port selected"
				break
			}
			path, baud := m.snap.Ports[m.selected].Path, m.baud
			m.busy = "opening " + path
			return m, hostCmd(func() error { return host.SelectSerial(path, baud) })
		}
	}
	return m, nil
}

func (m model) View() string {
	return render(m.snap, m.selected, m.help, m.errMsg, m.busy, m.width)
}

func render(s server.Snapshot, selected int, help bool, errMsg, busy string, width int) string {
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
	if busy != "" {
		add(yellowStyle.Render("… " + busy))
	}
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

func runHeadless(ctx context.Context, bridge Host) error {
	unsub := bridge.SubscribeStatus(func(s server.Snapshot) {
		fmt.Fprintf(os.Stderr, "[bridge] status clients=%d/%d serial=%s net=%v ctf=%d B\n",
			s.Clients, s.MaxClients, s.Serial.Phase, s.NetReady, s.CtfBytes)
	})
	defer unsub()
	<-ctx.Done()
	_ = bridge.Close()
	return nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
