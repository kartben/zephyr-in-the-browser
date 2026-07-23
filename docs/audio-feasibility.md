# Sound in the browser: virtio-snd feasibility study

The question: should browser audio arrive as a **virtio-sound** device — the
standard paravirtual path — or as another bespoke bridge like `qemu,host-gpio`?

**Verdict: virtio-sound is not buildable here today; a sound panel is, cheaply,
as a bespoke host-PCM bridge.** Three independent blockers stand between this
repo and virtio-snd, any one of which would sink it alone.

## Blocker 1: Zephyr has no virtio-snd guest driver

Zephyr's virtio support (2025–2026) is real but narrow: the **transports**
(virtio-mmio, virtio-pci) plus **entropy**, **console/serial**, and
**virtiofs** device drivers. There is no virtio-snd, no virtio-gpu, no
virtio-input — `docs/next-drivers.md` §2 already flags this.

Writing a virtio-snd driver is not a weekend port. The virtio-sound spec
(virtio spec §5.14) requires a control queue with jack/stream/channel-map
enumeration, a PCM stream state machine (SET PARAMS → PREPARE → START → STOP →
RELEASE), and separate TX/RX data queues carrying period-sized buffers with
completion status. It would also need Zephyr-side integration with an audio
API Zephyr itself has not settled for playback (its audio story today is
I2S/DMIC/codec, aimed at hardware pipelines). That is a genuine research
project, and it would land in *this* repo rather than upstream where it
belongs.

## Blocker 2: qemu-wasm has no audio backend for virtio-snd to play into

QEMU has shipped a `virtio-sound` device model since 8.2, so the device side
looks free — until you notice it renders into QEMU's **audiodev** layer
(`-audiodev`). Our emulator is built `--without-default-features`: no SDL, no
ALSA, no PulseAudio, nothing. There is no Emscripten/Web Audio audiodev in
QEMU, upstream or in the ktock fork. So even with a finished Zephyr driver,
the sound would dead-end inside QEMU; we would have to write a browser
audiodev backend in QEMU C anyway. At that point the "no QEMU patch" promise —
the whole strategic appeal of virtio (`next-drivers.md` §2) — is already
forfeit.

## Blocker 3: the interactive board has no virtio transport

virtio-mmio slots exist on the Cortex-A53 `virt` machine only. The Cortex-M3
Stellaris machine — the interactive shell board where a "type `beep`, hear a
beep" demo naturally lives — models no virtio transport at all, and Zephyr's
`qemu_cortex_m3` board config would need virtio enabling work on top. A
virtio-only sound device would strand the board people actually type into.

## What is buildable: the host-PCM bridge, behind Zephyr's standard audio APIs

`next-drivers.md` §3 already prescribes the transport: the
**framebuffer-export shape** with samples instead of pixels. The APIs on top
are the important part — virtio-snd was only ever a means to *standard
interfaces*, and Zephyr already has standard audio interfaces the bridge can
sit behind:

- **Out = I2S.** A `qemu-host-audio` MMIO device (patterned on
  `qemu-host-gpio`) owns a 16-bit interleaved PCM ring, rate and channel
  count guest-programmable (8–48 kHz, mono/stereo). The guest driver
  implements Zephyr's **I2S driver API** — `i2s_configure()`, `i2s_write()`,
  `i2s_trigger()` — so applications written for real I2S hardware drive the
  browser's speakers unmodified. Free-running write/read counters give both
  sides lossless flow control with single-word atomic accesses — no locking,
  no JS on the guest's MMIO path.
- **In = DMIC.** A `qemu-host-mic` device is the mirror image: the browser
  captures `getUserMedia` audio, resamples to 16 kHz mono, and fills the ring;
  the guest driver implements Zephyr's **DMIC API** (`dmic_configure()`,
  `dmic_trigger()`, `dmic_read()`) — with paced silence when no mic
  permission is granted. The stock `samples/drivers/audio/dmic` exercises it,
  though it needs a one-character LP64 fix upstream (see `next-drivers.md`);
  the packaged demo is Zephyr's own `dmic` shell commands (`read`, `vu`,
  `dump` from `CONFIG_AUDIO_DMIC_SHELL`) on the Cortex-A53 shell sample.
- JS polls the exported out-ring and schedules chunks through the **Web Audio
  API**; enable clicks satisfy the autoplay and mic-permission gates.
- A Kconfig-gated `hostaudio` shell command (`beep`, `melody`), itself written
  against the I2S API, makes the speaker a one-line demo from the stock shell
  sample, mirroring how `gpio get`/`gpio set` demo the GPIO bridge.

The 16 kHz mono default is deliberate: ~16 000 MMIO word-writes per second of
tone keeps the TCI-interpreted Cortex-M3 comfortable, and beeps do not need
CD quality. The shell commands bound their writes by the ring's free space so
they never sleep, dodging the known `k_sleep` stall on that board.

## When to revisit virtio-snd

The calculus flips if **both** of these land upstream: a Zephyr virtio-snd
driver, and a QEMU audiodev usable under Emscripten (or virtio-snd growing a
non-audiodev export path). Until then, virtio effort here should stay on the
targets `next-drivers.md` already picked — entropy/console as transport
proofs — not on sound. Because the guest-facing surface is already Zephyr's
standard I2S and DMIC APIs, a future switch of transport (bespoke ring →
virtio-snd) would not disturb any application code.
