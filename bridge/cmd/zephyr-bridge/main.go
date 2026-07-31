package main

import (
	"context"
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/kartben/zephyr-in-the-browser/bridge/internal/config"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/server"
	"github.com/kartben/zephyr-in-the-browser/bridge/internal/tui"
)

func main() {
	cfg, err := config.FromEnv()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n", err)
		os.Exit(2)
	}

	bridge, err := server.Start(cfg, server.Hooks{})
	if err != nil {
		fmt.Fprintf(os.Stderr, "start: %v\n", err)
		os.Exit(1)
	}

	// SIGINT usually arrives as a raw keypress the TUI's own raw terminal
	// mode intercepts (its "q"/"ctrl+c" handler quits cleanly on its own).
	// This ctx exists for the paths that keypress handling can't reach: a
	// real SIGTERM/SIGINT delivered as an OS signal (kill, a supervisor,
	// Ctrl+C before the TUI has grabbed the terminal). Cancelling it tells
	// bubbletea to restore the terminal before the process exits, instead of
	// the old code's unconditional 3s-later os.Exit, which killed the
	// process out from under a still-running, still-raw-mode TUI.
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	// Last-resort backstop: if shutdown itself hangs (a stuck Close(), a
	// wedged terminal), force the process down rather than sit forever.
	// bridge.Close() already bounds itself well under this, so it only fires
	// on a genuine hang, not as the normal exit path.
	watchdog := time.AfterFunc(time.Hour, func() { os.Exit(1) })
	defer watchdog.Stop()
	go func() {
		<-ctx.Done()
		watchdog.Reset(10 * time.Second)
	}()

	if cfg.NoTUI {
		<-ctx.Done()
		_ = bridge.Close()
		return
	}

	if err := tui.Run(ctx, bridge, cfg.BaudRate); err != nil {
		fmt.Fprintf(os.Stderr, "tui: %v\n", err)
		os.Exit(1)
	}
}
