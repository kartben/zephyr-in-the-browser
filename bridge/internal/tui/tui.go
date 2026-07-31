package tui

import (
	"fmt"
	"os"
	"strings"

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

	m := model{
		host:  bridge,
		baud:  baud,
		snap:  bridge.Snapshot(),
		width: 80,
	}
	p := tea.NewProgram(m, tea.WithAltScreen(), tea.WithInput(in), tea.WithOutput(out))

	// Subscribe off the main goroutine: the initial status callback uses
	// Program.Send, which blocks until Run() is reading the message channel.
	subDone := make(chan struct{})
	go func() {
		unsub := bridge.SubscribeStatus(func(s server.Snapshot) {
			p.Send(statusMsg(s))
		})
		<-subDone
		unsub()
	}()

	_, err := p.Run()
	close(subDone)
	_ = bridge.Close()
	return err
}

func (m model) Init() tea.Cmd { return nil }

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
	case tea.KeyMsg:
		switch msg.String() {
		case "q", "ctrl+c":
			return m, tea.Quit
		case "?", "h":
			m.help = !m.help
		case "r":
			_ = m.host.RefreshPorts()
		case "s":
			m.host.StopSerial()
			m.errMsg = ""
		case "g":
			st := m.host.Snapshot().GDB
			if err := m.host.AttachGdb(st.Host, st.Port); err != nil {
				m.errMsg = err.Error()
			} else {
				m.errMsg = ""
			}
		case "G":
			m.host.DetachGdb()
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
			_ = m.host.SelectSerial(m.snap.Ports[m.selected].Path, m.baud)
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
