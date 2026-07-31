package server

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/config"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/gdb"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/netstack"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/protocol"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/serial"
)

const (
	maxPayload     = 1 << 20
	pingInterval   = 30 * time.Second
	pongWait       = 60 * time.Second
	writeWait      = 10 * time.Second
	portPollEvery  = 2 * time.Second
	shutdownGrace  = 3 * time.Second
)

type Hooks struct {
	Log        func(string)
	ListPorts  serial.Lister
	OpenSerial serial.Opener
	OpenGdb    gdb.Opener
	// StartNet nil → use netstack.Start when EnableNet.
	StartNet func(forwards map[string]string, onFrame func([]byte), onError func(error), onClose func()) (NetSession, error)
}

type NetSession interface {
	WriteFrame([]byte) error
	Phase() (string, string)
	Close()
}

type Bridge struct {
	cfg   config.Config
	hooks Hooks

	mu       sync.Mutex
	clients  map[int]*client
	nextID   int
	ports    []protocol.PortInfo
	serial   protocol.SerialStatus
	gdbSt    protocol.GdbStatus
	serHandle serial.Handle
	gdbHandle gdb.Handle
	ctfBytes  atomic.Uint64
	gdbBytes  atomic.Uint64

	// gdbGen identifies the current GDB connection attempt. The opener starts
	// its read goroutine before AttachGdb can publish "connected", so a server
	// that hangs up immediately delivers onClose against a not-yet-published
	// connection. Stamping each attempt lets late callbacks tell "my
	// connection" from "a newer one" instead of guessing from Phase.
	gdbGen int
	// gdbClosedGen is the generation whose socket already died. AttachGdb
	// checks it before announcing success, so a rejected connection is never
	// reported as connected.
	gdbClosedGen int

	httpServer *http.Server
	listener   net.Listener
	upgrader   websocket.Upgrader

	statusListeners map[int]func(Snapshot)
	nextListener    int

	closed chan struct{}
	closeOnce sync.Once
}

type client struct {
	id   int
	conn *websocket.Conn
	send chan []byte
	net  NetSession

	mu        sync.Mutex
	netPhase  string
	netDetail string
	closed    sync.Once
}

type Snapshot struct {
	Version    string            `json:"version"`
	Protocol   string            `json:"protocol"`
	Features   protocol.Features `json:"features"`
	NetReady   bool              `json:"netReady"`
	Ports      []protocol.PortInfo `json:"ports"`
	Serial     protocol.SerialStatus `json:"serial"`
	GDB        protocol.GdbStatus    `json:"gdb"`
	Clients    int               `json:"clients"`
	MaxClients int               `json:"maxClients"`
	CtfBytes   uint64            `json:"ctfBytes"`
	GdbBytes   uint64            `json:"gdbBytes"`
	ListenPort int               `json:"listenPort"`
	WSURL      string            `json:"wsUrl"`
	DeepLink   string            `json:"deepLink"`
}

func Start(cfg config.Config, hooks Hooks) (*Bridge, error) {
	if hooks.Log == nil {
		hooks.Log = func(s string) { log.Print(s) }
	}
	if hooks.ListPorts == nil {
		hooks.ListPorts = serial.DefaultLister()
	}
	if hooks.OpenSerial == nil {
		hooks.OpenSerial = serial.DefaultOpener()
	}
	if hooks.OpenGdb == nil {
		hooks.OpenGdb = gdb.DefaultOpener()
	}
	if hooks.StartNet == nil {
		hooks.StartNet = func(forwards map[string]string, onFrame func([]byte), onError func(error), onClose func()) (NetSession, error) {
			return netstack.Start(forwards, onFrame, onError, onClose)
		}
	}

	b := &Bridge{
		cfg:             cfg,
		hooks:           hooks,
		clients:         map[int]*client{},
		statusListeners: map[int]func(Snapshot){},
		closed:          make(chan struct{}),
		serial: protocol.SerialStatus{
			BaudRate: cfg.BaudRate,
			Phase:    "idle",
		},
		gdbSt: protocol.GdbStatus{
			Host:  cfg.GdbHost,
			Port:  cfg.GdbPort,
			Phase: "idle",
		},
		upgrader: websocket.Upgrader{
			CheckOrigin:     func(r *http.Request) bool { return true },
			ReadBufferSize:  4096,
			WriteBufferSize: 4096,
		},
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", b.handleHealthz)
	mux.HandleFunc("/", b.handleRoot)

	ln, err := net.Listen("tcp", net.JoinHostPort(cfg.Host, fmt.Sprintf("%d", cfg.Port)))
	if err != nil {
		return nil, err
	}
	b.listener = ln
	b.httpServer = &http.Server{Handler: mux}

	go func() {
		_ = b.httpServer.Serve(ln)
	}()

	_ = b.refreshPorts()
	if cfg.SerialPath != "" {
		_ = b.SelectSerial(cfg.SerialPath, cfg.BaudRate)
	}
	go b.portPollLoop()

	port := b.ListenPort()
	b.hooks.Log(fmt.Sprintf("[bridge] listening on %s:%d (auth: %s)", cfg.Host, port, authLabel(cfg)))
	b.hooks.Log(fmt.Sprintf("[bridge]   WebSocket : %s", cfg.WSURL(port)))
	b.hooks.Log(fmt.Sprintf("[bridge]   Health    : http://localhost:%d/healthz", port))
	b.hooks.Log(fmt.Sprintf("[bridge]   Open the app with it: %s", b.DeepLink()))
	if cfg.EnableNet {
		b.hooks.Log("[bridge] net enabled (gvisor-tap-vsock)")
	} else {
		b.hooks.Log("[bridge] net disabled")
	}

	return b, nil
}

func authLabel(cfg config.Config) string {
	if cfg.Token == nil {
		return "off"
	}
	return "token"
}

func (b *Bridge) ListenPort() int {
	return b.listener.Addr().(*net.TCPAddr).Port
}

func (b *Bridge) DeepLink() string {
	u := b.cfg.WSURL(b.ListenPort())
	return b.cfg.PagesURL + "?bridge=" + url.QueryEscape(u)
}

func (b *Bridge) Snapshot() Snapshot {
	b.mu.Lock()
	defer b.mu.Unlock()
	port := 0
	if b.listener != nil {
		port = b.listener.Addr().(*net.TCPAddr).Port
	}
	ports := append([]protocol.PortInfo(nil), b.ports...)
	return Snapshot{
		Version:    config.Version,
		Protocol:   protocol.ProtocolName,
		Features:   protocol.Features{CTF: true, GDB: true, Net: b.cfg.EnableNet},
		NetReady:   b.cfg.EnableNet,
		Ports:      ports,
		Serial:     b.serial,
		GDB:        b.gdbSt,
		Clients:    len(b.clients),
		MaxClients: b.cfg.MaxClients,
		CtfBytes:   b.ctfBytes.Load(),
		GdbBytes:   b.gdbBytes.Load(),
		ListenPort: port,
		WSURL:      b.cfg.WSURL(port),
		DeepLink:   b.cfg.PagesURL + "?bridge=" + url.QueryEscape(b.cfg.WSURL(port)),
	}
}

func (b *Bridge) SubscribeStatus(fn func(Snapshot)) (unsubscribe func()) {
	b.mu.Lock()
	id := b.nextListener
	b.nextListener++
	b.statusListeners[id] = fn
	b.mu.Unlock()
	fn(b.Snapshot())
	return func() {
		b.mu.Lock()
		delete(b.statusListeners, id)
		b.mu.Unlock()
	}
}

func (b *Bridge) notifyStatus() {
	snap := b.Snapshot()
	b.mu.Lock()
	listeners := make([]func(Snapshot), 0, len(b.statusListeners))
	for _, fn := range b.statusListeners {
		listeners = append(listeners, fn)
	}
	b.mu.Unlock()
	for _, fn := range listeners {
		fn(snap)
	}
}

func (b *Bridge) handleHealthz(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	snap := b.Snapshot()
	out := map[string]any{
		"ok":       true,
		"version":  snap.Version,
		"protocol": snap.Protocol,
		"features": snap.Features,
		"net":      map[string]any{"ready": snap.NetReady},
		"ports":    snap.Ports,
		"serial":   snap.Serial,
		"gdb":      snap.GDB,
		"clients":  snap.Clients,
	}
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(out)
}

func (b *Bridge) handleRoot(w http.ResponseWriter, r *http.Request) {
	if websocket.IsWebSocketUpgrade(r) {
		b.handleWS(w, r)
		return
	}
	if r.URL.Path != "/" {
		http.NotFound(w, r)
		return
	}
	snap := b.Snapshot()
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	_, _ = fmt.Fprintf(w, "zephyr-in-the-browser bridge %s\nclients %d/%d\n", snap.Version, snap.Clients, snap.MaxClients)
}

func (b *Bridge) handleWS(w http.ResponseWriter, r *http.Request) {
	conn, err := b.upgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	conn.SetReadLimit(maxPayload)
	_ = conn.SetReadDeadline(time.Now().Add(pongWait))
	conn.SetPongHandler(func(string) error {
		_ = conn.SetReadDeadline(time.Now().Add(pongWait))
		return nil
	})

	if b.cfg.Token != nil {
		tok := r.URL.Query().Get("token")
		if subtle.ConstantTimeCompare([]byte(tok), []byte(*b.cfg.Token)) != 1 {
			_ = conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(protocol.CloseUnauthorized, "unauthorized"),
				time.Now().Add(writeWait))
			_ = conn.Close()
			return
		}
	}

	b.mu.Lock()
	full := len(b.clients) >= b.cfg.MaxClients
	b.mu.Unlock()
	if full {
		_ = conn.WriteControl(websocket.CloseMessage,
			websocket.FormatCloseMessage(protocol.CloseFull, "full"),
			time.Now().Add(writeWait))
		_ = conn.Close()
		return
	}

	b.mu.Lock()
	id := b.nextID
	b.nextID++
	c := &client{
		id:       id,
		conn:     conn,
		send:     make(chan []byte, 64),
		netPhase: "idle",
	}
	b.clients[id] = c
	b.mu.Unlock()
	b.notifyStatus()

	go c.writePump()
	b.sendHello(c)

	if b.cfg.EnableNet {
		b.startClientNet(c)
	}

	b.readPump(c)
}

func (b *Bridge) sendHello(c *client) {
	snap := b.Snapshot()
	msg := protocol.Hello{
		Type:     "hello",
		Version:  1,
		Bridge:   snap.Version,
		Protocol: protocol.ProtocolName,
		Features: snap.Features,
		Ports:    snap.Ports,
		Serial:   snap.Serial,
		GDB:      snap.GDB,
	}
	raw, err := protocol.EncodeCtrl(msg)
	if err != nil {
		return
	}
	c.enqueue(raw)
}

func (b *Bridge) startClientNet(c *client) {
	c.mu.Lock()
	c.netPhase = "connecting"
	c.mu.Unlock()
	b.sendNetStatus(c)

	sess, err := b.hooks.StartNet(b.cfg.Forwards, func(frame []byte) {
		c.enqueue(protocol.EncodeFrame(protocol.CH_NET, frame))
	}, func(err error) {
		c.mu.Lock()
		c.netPhase = "error"
		c.netDetail = err.Error()
		c.mu.Unlock()
		b.sendNetStatus(c)
	}, func() {
		c.mu.Lock()
		c.netPhase = "idle"
		c.netDetail = "closed"
		c.mu.Unlock()
		b.sendNetStatus(c)
	})
	if err != nil {
		c.mu.Lock()
		c.netPhase = "error"
		c.netDetail = err.Error()
		c.mu.Unlock()
		b.sendNetStatus(c)
		return
	}
	c.mu.Lock()
	c.net = sess
	c.netPhase = "connected"
	c.netDetail = ""
	c.mu.Unlock()
	b.sendNetStatus(c)
}

func (b *Bridge) sendNetStatus(c *client) {
	c.mu.Lock()
	phase, detail := c.netPhase, c.netDetail
	c.mu.Unlock()
	raw, err := protocol.EncodeCtrl(map[string]any{
		"type":   "net-status",
		"phase":  phase,
		"detail": detail,
	})
	if err != nil {
		return
	}
	c.enqueue(raw)
}

func (c *client) enqueue(msg []byte) {
	defer func() { _ = recover() }()
	select {
	case c.send <- msg:
	default:
		// drop if slow
	}
}

func (c *client) writePump() {
	ticker := time.NewTicker(pingInterval)
	defer func() {
		ticker.Stop()
		_ = c.conn.Close()
	}()
	for {
		select {
		case msg, ok := <-c.send:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if !ok {
				_ = c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}
			if err := c.conn.WriteMessage(websocket.BinaryMessage, msg); err != nil {
				return
			}
		case <-ticker.C:
			_ = c.conn.SetWriteDeadline(time.Now().Add(writeWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

func (b *Bridge) readPump(c *client) {
	defer b.removeClient(c)
	for {
		_, data, err := c.conn.ReadMessage()
		if err != nil {
			return
		}
		// Text frames: treat as raw CTRL JSON (devtools convenience).
		if len(data) > 0 && data[0] == '{' {
			b.handleCtrl(c, data)
			continue
		}
		ch, payload, ok := protocol.DecodeFrame(data)
		if !ok {
			continue
		}
		switch ch {
		case protocol.CH_CTRL:
			b.handleCtrl(c, payload)
		case protocol.CH_GDB:
			b.mu.Lock()
			h := b.gdbHandle
			phase := b.gdbSt.Phase
			b.mu.Unlock()
			if h != nil && phase == "connected" {
				// Write is deadline-bounded (see internal/gdb), so a stalled
				// target times out instead of freezing this client's whole
				// read loop. Surface that as a real error rather than
				// silently sitting on "connected" with a dead socket.
				if _, err := h.Write(payload); err != nil {
					b.mu.Lock()
					b.gdbSt.Phase = "error"
					b.gdbSt.Detail = err.Error()
					b.mu.Unlock()
					b.broadcastGdb()
					_ = h.Close()
				}
			}
		case protocol.CH_NET:
			c.mu.Lock()
			ns := c.net
			phase := c.netPhase
			c.mu.Unlock()
			if ns != nil && phase == "connected" {
				_ = ns.WriteFrame(payload)
			}
		}
	}
}

func (b *Bridge) handleCtrl(c *client, payload []byte) {
	var msg map[string]any
	if err := json.Unmarshal(payload, &msg); err != nil {
		return
	}
	typ, _ := msg["type"].(string)
	switch typ {
	case "ping":
		t := msg["t"]
		if t == nil {
			t = time.Now().UnixMilli()
		}
		raw, _ := protocol.EncodeCtrl(map[string]any{"type": "pong", "t": t})
		c.enqueue(raw)
	case "list-ports":
		_ = b.refreshPorts()
		b.broadcastPorts()
	case "select-serial":
		path, _ := msg["path"].(string)
		baud := b.cfg.BaudRate
		if v, ok := msg["baudRate"].(float64); ok && v > 0 {
			baud = int(v)
		}
		if path == "" {
			b.StopSerial()
		} else {
			_ = b.SelectSerial(path, baud)
		}
	case "stop-serial":
		b.StopSerial()
	case "gdb-attach":
		host := b.cfg.GdbHost
		port := b.cfg.GdbPort
		if v, ok := msg["host"].(string); ok && v != "" {
			host = v
		}
		if v, ok := msg["port"].(float64); ok && v > 0 {
			port = int(v)
		}
		_ = b.AttachGdb(host, port)
	case "gdb-detach":
		b.DetachGdb()
	}
}

func (b *Bridge) removeClient(c *client) {
	c.closed.Do(func() {
		c.mu.Lock()
		if c.net != nil {
			c.net.Close()
			c.net = nil
		}
		c.mu.Unlock()
		close(c.send)
		_ = c.conn.Close()
		b.mu.Lock()
		delete(b.clients, c.id)
		b.mu.Unlock()
		b.notifyStatus()
	})
}

func (b *Bridge) broadcast(raw []byte) {
	b.mu.Lock()
	clients := make([]*client, 0, len(b.clients))
	for _, c := range b.clients {
		clients = append(clients, c)
	}
	b.mu.Unlock()
	for _, c := range clients {
		c.enqueue(raw)
	}
}

func (b *Bridge) broadcastPorts() {
	snap := b.Snapshot()
	raw, err := protocol.EncodeCtrl(map[string]any{"type": "ports", "ports": snap.Ports})
	if err != nil {
		return
	}
	b.broadcast(raw)
	b.notifyStatus()
}

func (b *Bridge) broadcastSerial() {
	b.mu.Lock()
	st := b.serial
	b.mu.Unlock()
	raw, err := protocol.EncodeCtrl(map[string]any{
		"type":     "serial-status",
		"path":     st.Path,
		"baudRate": st.BaudRate,
		"phase":    st.Phase,
		"detail":   st.Detail,
	})
	if err != nil {
		return
	}
	b.broadcast(raw)
	b.notifyStatus()
}

func (b *Bridge) broadcastGdb() {
	b.mu.Lock()
	st := b.gdbSt
	b.mu.Unlock()
	raw, err := protocol.EncodeCtrl(map[string]any{
		"type":   "gdb-status",
		"host":   st.Host,
		"port":   st.Port,
		"phase":  st.Phase,
		"detail": st.Detail,
	})
	if err != nil {
		return
	}
	b.broadcast(raw)
	b.notifyStatus()
}

func (b *Bridge) refreshPorts() error {
	ports, err := b.hooks.ListPorts()
	if err != nil {
		b.hooks.Log(fmt.Sprintf("[bridge] list ports failed: %v", err))
		return err
	}
	b.mu.Lock()
	b.ports = ports
	auto := b.cfg.AutoSerial && b.serHandle == nil && len(ports) == 1
	path := ""
	if auto {
		path = ports[0].Path
	}
	baud := b.cfg.BaudRate
	b.mu.Unlock()
	if path != "" {
		_ = b.SelectSerial(path, baud)
	}
	return nil
}

func (b *Bridge) portPollLoop() {
	t := time.NewTicker(portPollEvery)
	defer t.Stop()
	for {
		select {
		case <-b.closed:
			return
		case <-t.C:
			before := b.Snapshot().Ports
			_ = b.refreshPorts()
			after := b.Snapshot().Ports
			if !portsEqual(before, after) {
				b.broadcastPorts()
			}
		}
	}
}

func portsEqual(a, b []protocol.PortInfo) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].Path != b[i].Path {
			return false
		}
	}
	return true
}

func (b *Bridge) SelectSerial(path string, baud int) error {
	b.StopSerial()
	h, err := b.hooks.OpenSerial(path, baud, func(data []byte) {
		b.ctfBytes.Add(uint64(len(data)))
		b.broadcast(protocol.EncodeFrame(protocol.CH_CTF, data))
		b.notifyStatus()
	}, func(err error) {
		b.mu.Lock()
		b.serial.Phase = "error"
		b.serial.Detail = err.Error()
		b.mu.Unlock()
		b.broadcastSerial()
	}, func() {
		b.mu.Lock()
		if b.serial.Phase == "streaming" {
			b.serial.Phase = "idle"
			b.serial.Detail = "port closed"
			b.serial.Path = nil
		}
		b.serHandle = nil
		b.mu.Unlock()
		b.broadcastSerial()
	})
	if err != nil {
		b.mu.Lock()
		b.serial.Phase = "error"
		b.serial.Detail = err.Error()
		p := path
		b.serial.Path = &p
		b.serial.BaudRate = baud
		b.mu.Unlock()
		b.broadcastSerial()
		return err
	}
	b.mu.Lock()
	b.serHandle = h
	p := path
	b.serial = protocol.SerialStatus{Path: &p, BaudRate: baud, Phase: "streaming", Detail: ""}
	b.mu.Unlock()
	b.broadcastSerial()
	return nil
}

func (b *Bridge) StopSerial() {
	b.mu.Lock()
	h := b.serHandle
	b.serHandle = nil
	b.serial.Phase = "idle"
	b.serial.Detail = ""
	b.serial.Path = nil
	b.mu.Unlock()
	if h != nil {
		_ = h.Close()
	}
	b.broadcastSerial()
}

// errGdbRejected reports a GDB server that accepted the TCP connection and
// then hung up without speaking the protocol. OpenOCD does exactly this when
// target examination has failed ("attempted 'gdb' connection rejected" in its
// log), which usually means the debug link to the target is down rather than
// anything being wrong with the bridge.
// Kept short deliberately: the TUI truncates status lines to the terminal
// width, so a long message loses its tail exactly when it is needed.
var errGdbRejected = errors.New("gdb server rejected the session — target not examined (check SWD link/power)")

func (b *Bridge) AttachGdb(host string, port int) error {
	b.DetachGdb()

	b.mu.Lock()
	b.gdbGen++
	gen := b.gdbGen
	b.mu.Unlock()

	// current reports whether gen is still the live attempt. Callbacks from a
	// superseded connection must not touch shared state.
	current := func() bool {
		return b.gdbGen == gen
	}

	h, err := b.hooks.OpenGdb(host, port, func(data []byte) {
		b.gdbBytes.Add(uint64(len(data)))
		b.broadcast(protocol.EncodeFrame(protocol.CH_GDB, data))
		b.notifyStatus()
	}, func(err error) {
		b.mu.Lock()
		if !current() {
			b.mu.Unlock()
			return
		}
		b.gdbSt.Phase = "error"
		b.gdbSt.Detail = err.Error()
		b.mu.Unlock()
		b.broadcastGdb()
	}, func() {
		b.mu.Lock()
		if !current() {
			b.mu.Unlock()
			return
		}
		// Record the death unconditionally. This callback races AttachGdb's
		// own "connected" publish below, and when it wins that race the old
		// Phase=="connected" guard silently dropped the close — leaving the UI
		// showing a live GDB session on a socket the server had already hung
		// up on.
		b.gdbClosedGen = gen
		if b.gdbSt.Phase == "connected" {
			b.gdbSt.Phase = "idle"
			b.gdbSt.Detail = "gdb server closed"
		}
		b.gdbHandle = nil
		b.mu.Unlock()
		b.broadcastGdb()
	})
	if err != nil {
		b.mu.Lock()
		b.gdbSt = protocol.GdbStatus{Host: host, Port: port, Phase: "error", Detail: err.Error()}
		b.mu.Unlock()
		b.broadcastGdb()
		return err
	}

	b.mu.Lock()
	if !current() || b.gdbClosedGen == gen {
		// Superseded, or the server hung up before we got here. Either way,
		// publishing "connected" now would overwrite the truth with a lie.
		rejected := b.gdbClosedGen == gen && current()
		if rejected {
			b.gdbSt = protocol.GdbStatus{Host: host, Port: port, Phase: "error", Detail: "connection rejected by gdb server"}
		}
		b.mu.Unlock()
		_ = h.Close()
		if rejected {
			b.broadcastGdb()
			return errGdbRejected
		}
		return nil
	}
	b.gdbHandle = h
	b.cfg.GdbHost = host
	b.cfg.GdbPort = port
	b.gdbSt = protocol.GdbStatus{Host: host, Port: port, Phase: "connected", Detail: ""}
	b.mu.Unlock()
	b.broadcastGdb()
	return nil
}

func (b *Bridge) DetachGdb() {
	b.mu.Lock()
	h := b.gdbHandle
	b.gdbHandle = nil
	// Bump the generation so an in-flight attempt's callbacks go quiet.
	b.gdbGen++
	b.gdbSt.Phase = "idle"
	b.gdbSt.Detail = ""
	b.mu.Unlock()
	if h != nil {
		_ = h.Close()
	}
	b.broadcastGdb()
}

func (b *Bridge) RefreshPorts() error {
	if err := b.refreshPorts(); err != nil {
		return err
	}
	b.broadcastPorts()
	return nil
}

func (b *Bridge) Close() error {
	var err error
	b.closeOnce.Do(func() {
		close(b.closed)
		b.StopSerial()
		b.DetachGdb()
		b.mu.Lock()
		clients := make([]*client, 0, len(b.clients))
		for _, c := range b.clients {
			clients = append(clients, c)
		}
		b.mu.Unlock()
		for _, c := range clients {
			_ = c.conn.WriteControl(websocket.CloseMessage,
				websocket.FormatCloseMessage(protocol.CloseGoingAway, "shutting down"),
				time.Now().Add(writeWait))
			b.removeClient(c)
		}
		ctx, cancel := context.WithTimeout(context.Background(), shutdownGrace)
		defer cancel()
		err = b.httpServer.Shutdown(ctx)
	})
	return err
}
