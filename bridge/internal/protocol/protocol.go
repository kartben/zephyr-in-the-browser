// Package protocol defines the zitb-bridge WebSocket wire format.
package protocol

import (
	"encoding/json"
	"fmt"
)

const (
	CH_CTF  = 0x01
	CH_GDB  = 0x02
	CH_NET  = 0x03
	CH_CTRL = 0x10
)

const (
	CloseUnauthorized   = 4001
	CloseFull           = 4002
	CloseBackendFailed  = 4003
	CloseBackendDied    = 1011
	CloseGoingAway      = 1001
)

const ProtocolName = "zitb-bridge"

type Features struct {
	CTF bool `json:"ctf"`
	GDB bool `json:"gdb"`
	Net bool `json:"net"`
}

type PortInfo struct {
	Path         string  `json:"path"`
	Manufacturer *string `json:"manufacturer"`
	SerialNumber *string `json:"serialNumber"`
	VendorID     *string `json:"vendorId"`
	ProductID    *string `json:"productId"`
	FriendlyName string  `json:"friendlyName"`
}

type SerialStatus struct {
	Path     *string `json:"path"`
	BaudRate int     `json:"baudRate"`
	Phase    string  `json:"phase"`
	Detail   string  `json:"detail"`
}

type GdbStatus struct {
	Host   string `json:"host"`
	Port   int    `json:"port"`
	Phase  string `json:"phase"`
	Detail string `json:"detail"`
}

type Hello struct {
	Type     string       `json:"type"`
	Version  int          `json:"version"`
	Bridge   string       `json:"bridge"`
	Protocol string       `json:"protocol"`
	Features Features     `json:"features"`
	Ports    []PortInfo   `json:"ports"`
	Serial   SerialStatus `json:"serial"`
	GDB      GdbStatus    `json:"gdb"`
}

func EncodeFrame(channel byte, payload []byte) []byte {
	out := make([]byte, 1+len(payload))
	out[0] = channel
	copy(out[1:], payload)
	return out
}

func DecodeFrame(raw []byte) (channel byte, payload []byte, ok bool) {
	if len(raw) < 1 {
		return 0, nil, false
	}
	return raw[0], raw[1:], true
}

func EncodeCtrl(v any) ([]byte, error) {
	body, err := json.Marshal(v)
	if err != nil {
		return nil, err
	}
	return EncodeFrame(CH_CTRL, body), nil
}

func DecodeCtrl(payload []byte, dest any) error {
	if err := json.Unmarshal(payload, dest); err != nil {
		return fmt.Errorf("ctrl json: %w", err)
	}
	return nil
}
