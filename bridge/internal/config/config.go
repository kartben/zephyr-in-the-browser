package config

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"strconv"
	"strings"
)

const Version = "0.2.0"

type Config struct {
	Host        string
	Port        int
	Token       *string // nil = auth disabled
	MaxClients  int
	BaudRate    int
	SerialPath  string
	AutoSerial  bool
	GdbHost     string
	GdbPort     int
	PagesURL    string
	NoTUI       bool
	EnableNet   bool
	Forwards    map[string]string // "127.0.0.1:4242" -> "192.168.127.2:4242"
}

func FromEnv() (Config, error) {
	cfg := Config{
		Host:       getenv("HOST", "0.0.0.0"),
		Port:       8740,
		MaxClients: 8,
		BaudRate:   115200,
		AutoSerial: true,
		GdbHost:    getenv("GDB_HOST", "127.0.0.1"),
		GdbPort:    3333,
		PagesURL:   getenv("PAGES_URL", "https://kartben.github.io/zephyr-in-the-browser/"),
		EnableNet:  true,
		Forwards:   map[string]string{},
	}

	if v := os.Getenv("PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 || n > 65535 {
			return cfg, fmt.Errorf("invalid PORT %q", v)
		}
		cfg.Port = n
	}
	if v := os.Getenv("MAX_CLIENTS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return cfg, fmt.Errorf("invalid MAX_CLIENTS %q", v)
		}
		cfg.MaxClients = n
	}
	if v := os.Getenv("BAUD"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			return cfg, fmt.Errorf("invalid BAUD %q", v)
		}
		cfg.BaudRate = n
	}
	if v := os.Getenv("GDB_PORT"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 || n > 65535 {
			return cfg, fmt.Errorf("invalid GDB_PORT %q", v)
		}
		cfg.GdbPort = n
	}

	switch strings.ToLower(os.Getenv("TOKEN")) {
	case "none":
		cfg.Token = nil
	case "":
		b := make([]byte, 16)
		if _, err := rand.Read(b); err != nil {
			return cfg, err
		}
		t := hex.EncodeToString(b)
		cfg.Token = &t
	default:
		t := os.Getenv("TOKEN")
		cfg.Token = &t
	}

	cfg.SerialPath = os.Getenv("SERIAL")
	if os.Getenv("AUTO_SERIAL") == "0" {
		cfg.AutoSerial = false
	}
	if v := os.Getenv("NO_TUI"); v == "1" || strings.EqualFold(v, "true") {
		cfg.NoTUI = true
	}
	if os.Getenv("DISABLE_NET") == "1" {
		cfg.EnableNet = false
	}

	// FORWARDS=4242:4242,8080:80 → host listen :4242 → guest 192.168.127.2:4242
	if raw := os.Getenv("FORWARDS"); raw != "" {
		for _, part := range strings.Split(raw, ",") {
			part = strings.TrimSpace(part)
			if part == "" {
				continue
			}
			hostPort, guestPort, ok := strings.Cut(part, ":")
			if !ok {
				return cfg, fmt.Errorf("invalid FORWARDS entry %q (want hostPort:guestPort)", part)
			}
			local := "127.0.0.1:" + hostPort
			remote := "192.168.127.2:" + guestPort
			cfg.Forwards[local] = remote
		}
	}

	return cfg, nil
}

func getenv(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func (c Config) WSURL(listenPort int) string {
	u := fmt.Sprintf("ws://localhost:%d/", listenPort)
	if c.Token != nil {
		u += "?token=" + *c.Token
	}
	return u
}
