# USB in the browser: WebUSB feasibility study

The question: can this tab talk to **real USB peripherals** via
[WebUSB](https://developer.mozilla.org/en-US/docs/Web/API/WebUSB_API), and what
would that mean for Zephyr running in qemu-wasm?

**Verdict: not as a USB bus into the guest — yes as another live source for the
chips we already simulate.** Three independent blockers sink a WebUSB → Zephyr
USB-host passthrough; **virtio-usb (device ID 49) does not unblock them** — the
ID is reserved with no protocol chapter, no QEMU model, and no Zephyr driver.
None of those blockers apply to the cheaper shape that already powers device
tilt and the mic.

## What "USB peripheral support" could mean here

Three different products hide under that phrase. Only one of them is WebUSB,
and only one of them fits this project's bridge model today.

| Goal | Browser API | Guest sees | Fits today? |
| --- | --- | --- | --- |
| **A. USB host passthrough** — plug a real dongle into the laptop; Zephyr's USB host stack enumerates it | WebUSB | A USB device on a virtual HC | No — see blockers below |
| **B. Live source** — plug a real sensor / HID / vendor dongle; its readings drive the simulated TMP112 / ADXL345 / … the guest already talks to over virtio-i2c | WebUSB / WebHID / Web Serial | The same stock I²C (or SPI) chip as today | Yes — extends `liveSource.ts` |
| **C. USB *device* demos** — Zephyr CDC-ACM / HID gadget samples | none (QEMU usb-device models) | Guest *is* the USB device | Orthogonal to WebUSB |

The project rule from [`next-drivers.md`](next-drivers.md) still applies: every
device is a **bridge between a browser API and a Zephyr driver**, and new work
should reuse a proven shape. Goal B is exactly the host-sensor / live-source
shape. Goal A invents a fourth bus (USB) that neither qemu-wasm nor the guest
board currently carries. Goal C is a QEMU device-model question, not a WebUSB
one — WebUSB makes the *page* a USB host, which is the wrong side of a gadget
demo.

## Blocker 1: there is no USB host controller on either browser machine

Zephyr's USB host stack needs a Host Controller Driver (UHC) against something
QEMU actually instantiates. Today:

- **`qemu_cortex_a53` (`virt`)** — no XHCI/EHCI/OHCI in the packaged command
  line or the `browser_bridge` shield. Upstream docs list PL011, virtio-mmio,
  ramfb, e1000 — not USB. QEMU *can* attach `-device qemu-xhci`, but that is
  PCI, and this project deliberately stays virtio-mmio end-to-end
  (`CONFIG_PCI_DEVICES` is even floated as a trim target in
  `tools/qemu-jit-patches/0012-…`). Zephyr has no in-tree XHCI UHC driver for
  `virt` either; the virtual UHC (`uhc_virtual`) talks to Zephyr's own UVB, not
  to QEMU USB, and a generic OHCI driver is only just landing upstream.
- **`qemu_cortex_m3` (Stellaris)** — no virtio transport and no USB host path
  we use. The interactive shell board would be stranded the same way
  virtio-snd would have stranded it
  ([`audio-feasibility.md`](audio-feasibility.md) blocker 3).

So before WebUSB enters the picture at all, goal A needs: a HC in the wasm
machine, a Zephyr UHC driver for it, DT/shield wiring, and a rebuild. That is
already more work than every I²C chip shipped so far combined.

## Blocker 2: qemu-wasm has no USB host backend for WebUSB to plug into

Even with an XHCI in the guest, QEMU still has to attach a *backend* that
represents the physical device. Native QEMU uses `usb-host` / libusb. Our
emulator is built `--without-default-features`: no libusb, no host USB, nothing
analogous to the browser netdev or the virtio bridge.

A WebUSB passthrough would therefore need a new QEMU C backend — something like
`hw/usb/host-browser.c` that:

1. Exports URB enqueue/completion to the page (shared memory + kick, the way
   the virtio bridge does), and
2. Has JS complete those URBs with `device.transferIn` / `transferOut` /
   `controlTransferIn` / `controlTransferOut`.

That is a full USB host proxy, not a small frontend. It is closer in size and
risk to inventing `net/browser.c` than to the ~200-line input bridge. And unlike
virtio-gpio, there is no ready "move the device model to TypeScript" escape
hatch either — see [virtio-usb below](#what-about-virtio-usb).

## Blocker 3: WebUSB itself cannot claim the peripherals people actually want

WebUSB is Chromium-only (Chrome / Edge / Opera / Samsung Internet). Firefox and
Safari have standards positions against it; there is no flag. Secure context
required. A user gesture opens the device picker; permission is per-origin.

Worse for a "plug in a sensor" demo: Chromium **refuses to claim protected
interface classes** — HID, mass storage, audio, video, smart card, wireless
controller. So:

| Device you might plug in | WebUSB? | Better API |
| --- | --- | --- |
| Vendor-class I²C/SPI bridge (FT232H, CP2112, …) | Often yes | WebUSB |
| USB-HID accelerometer / gamepad / "sensor" dongle | No (`claimInterface` → SecurityError) | **WebHID** |
| USB-CDC / UART adapter | Usually no (OS owns it) / fragile | **Web Serial** |
| USB webcam | No (protected + OS) | `getUserMedia` (already the webcam track) |
| USB keyboard / mouse | No | not available to the page |

A passthrough that can only reach the odd vendor-class device, only in Chrome,
and only after a picker click, is a poor fit for a gallery whose whole point is
stock Zephyr samples on stock drivers. The mic and tilt demos already show the
right bar: the browser API is an *optional* live feed; the guest works without
it.

## What is buildable: WebUSB / WebHID as a `liveSource`

[`src/virtio/devices/sensors/liveSource.ts`](../src/virtio/devices/sensors/liveSource.ts)
already maps browser APIs onto simulated chip channels:

- `DeviceMotionEvent` → ADXL345 / LSM6DSO axes ("follow device tilt")
- Battery Status API → fuel-gauge SoC channel

A USB dongle is the same shape with a different subscription:

```
user gesture → navigator.usb.requestDevice({ filters })
            → claimInterface / selectConfiguration
            → poll or transferIn
            → engineering-unit callback
            → existing SensorDecl channel (or Pwm / Dac / …)
```

The guest never hears about USB. It keeps talking to `ti,tmp112` /
`adi,adxl345` / … over virtio-i2c through unmodified in-tree drivers — which is
exactly why sensors moved off the bespoke `qemu,host-sensor` MMIO device in the
first place ([`peripherals.md`](peripherals.md#simulated-ic-sensors)).

Concrete first cuts that pay off without a qemu rebuild:

1. **WebHID gamepad / HID sensor → ADXL345 axes.** HID is the protected class
   WebUSB cannot claim; WebHID is the API that can. Same dock checkbox group as
   "follow device tilt," labelled "follow USB HID." Chrome + Edge; graceful
   absence everywhere else, matching how tilt already degrades.
2. **WebUSB vendor bridge → a single known chip.** Pick one well-documented
   dongle (e.g. an FT232H in MPSSE bit-bang, or a CP2112 HID→I²C — noting CP2112
   is often WebHID, not WebUSB) and teach `liveSource` one `kind` that pushes
   temperature or accel. Ship behind a dock "Connect USB…" affordance that is
   simply hidden when `navigator.usb` is missing.
3. **Web Serial NMEA → GNSS.** Not WebUSB, but the same product idea on the
   UART we already have: a real GPS puck feeds [`hostGnss.ts`](../src/hostGnss.ts)
   instead of the editable fake fix. The GNSS path is already the
   bidirectional char-device shape.

None of these touch QEMU C, the shield, or the guest binary. They are page-side
sources, which is why they belong on the I²C-class backlog rather than as a new
bridge rank item.

## What about virtio-usb?

The natural follow-up, given this project's generic bridge
([`virtio-bridge.md`](virtio-bridge.md)): skip XHCI entirely, put a
`virtio-browser-device,name=usb,device-id=49` on a free mmio slot, and speak
USB over virtqueues the way GPIO/I²C/SPI already do.

**Verdict: same shape as virtio-snd — attractive on paper, not buildable
here.** The ID exists; the device does not.

### What the spec actually has

Virtio 1.4 reserves **device ID 49 — "USB controller"**
([oasis-tcs/virtio-spec#211](https://github.com/oasis-tcs/virtio-spec/issues/211),
committed as an ID-table row only). The reservation describes a dual-role
controller (host, device, or both, with role switching). There is **no
chapter 5.x** for it. The device-types preamble is explicit: some listed IDs
are immature / niche and "we shall speak of them no further." An earlier
host-controller-only ask for ID 48
([#193](https://github.com/oasis-tcs/virtio-spec/issues/193)) was superseded
when 48 went to Media and USB moved to 49.

So today there is:

| Piece | Status |
| --- | --- |
| Virtio device ID 49 | Reserved in v1.4 |
| Protocol (queues, config, URB/transfer ops) | Not in the published spec |
| QEMU `virtio-usb-*` device model | None upstream |
| Linux guest driver | None upstream |
| Zephyr guest driver | None (no virtio UHC/UDC) |

That is a stricter hole than virtio-snd had: sound at least has a finished
§5.14 and a QEMU device model. USB has a number in a table.

### Why the generic bridge does not rescue it

The bridge removes the *host-side C* cost of a new virtio device type. It does
not remove:

1. **Inventing the protocol** — without a chapter, a TypeScript
   `src/virtio/devices/usb.ts` would be a private dialect, not something a
   stock or upstreamable Zephyr driver can target.
2. **The guest driver** — Zephyr's USB host stack wants a UHC; its device
   stack wants a UDC. A virtio-usb driver would be a new UHC (and/or UDC)
   written against a protocol that does not exist yet. That is a research
   project, not a snippet + panel.
3. **The page-side USB world** — even a finished virtio-usb HC still needs
   something to plug into its ports. Simulated gadgets are fine for demos;
   *real* dongles still hit WebUSB/WebHID limits (blocker 3). The bridge would
   carry URBs; it would not make Chromium claim a HID interface.

Put differently: virtio-usb would be the right *transport* if the ecosystem
caught up — ID reserved, virtio-mmio already on A53, bridge already generic.
It is the wrong *next move* while the protocol and both drivers are vapour.
Revisit when a virtio-usb chapter lands and at least one of QEMU or Linux
ships a reference implementation; until then the liveSource path above is the
USB-shaped work that actually ships.

## What about Zephyr USB *device* samples?

Separately useful, and easy to confuse with the above: packaging
`samples/subsys/usb/cdc_acm` (or HID) so the *guest* is the USB device. That
needs QEMU usb-device models (`usb-serial`, `usb-tablet`, …) attached to a HC
the *host* side of QEMU owns — and in a browser there is no host OS to plug
that gadget into. The page cannot usefully be the USB host for an emulated
gadget without the same backend work as blocker 2, run in reverse.

So gadget demos stay parked. If they ever move, the interesting surface is a
**dock card that speaks the gadget protocol over the existing char/virtio
bridges** (e.g. show CDC bytes in a panel), not WebUSB.

## When to revisit full USB (XHCI or virtio-usb)

Two different doors; either one has to open fully:

- **XHCI / OHCI path:** a Zephyr UHC for a HC qemu-wasm can instantiate, plus a
  browser USB backend in QEMU C (the libusb-shaped hole), plus a demo device
  WebUSB may actually claim.
- **virtio-usb path:** a published virtio USB controller chapter (not just ID
  49), a Zephyr virtio UHC/UDC against it, and a page-side port model
  (simulated gadgets first; WebUSB/WebHID only where the browser allows).

Until one of those sets lands, USB effort here should look like the mic and
the tilt sensor: a browser API feeding chips the guest already understands.
Prefer **WebHID** for anything HID-class, **Web Serial** for UART dongles, and
**WebUSB** only for explicit vendor-class bridges — and keep every one of them
behind the existing `liveSource` / dock opt-in pattern so Safari and
permission-denied Chrome still get a working slider.

## Suggested next step

If the goal is "real hardware in the tab," extend `LiveSourceKind` with a
WebHID (not WebUSB-first) group and wire one HID report onto the ADXL345. That
reuses the dock, the guest driver, and the virtio-i2c bus; it proves the
permission + picker UX; and it leaves a clean seam for a later WebUSB vendor
bridge without pretending the guest has a USB host controller.
