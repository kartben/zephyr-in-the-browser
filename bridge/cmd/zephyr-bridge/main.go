package main

import (
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

	sigc := make(chan os.Signal, 1)
	signal.Notify(sigc, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigc
		_ = bridge.Close()
		time.AfterFunc(3*time.Second, func() { os.Exit(0) })
	}()

	if cfg.NoTUI {
		<-make(chan struct{})
		return
	}

	if err := tui.Run(bridge, cfg.BaudRate); err != nil {
		fmt.Fprintf(os.Stderr, "tui: %v\n", err)
	}
	os.Exit(0)
}
