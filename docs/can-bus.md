# CAN — bus class spec

Build contract for the next peripheral class. Source mockup:
[`can-bus-mockup.html`](can-bus-mockup.html). Ranking rationale belongs in
[next-drivers.md](next-drivers.md); this note is the shape.

CAN is the one bus class the tree does not model. I²C, SPI, UART and Ethernet
all have a page-side counterpart; CAN is the one that most rewards it, because
the page does not model *a chip on a bus* — it models **the rest of the
network**, the way [`src/net/stack.ts`](../src/net/stack.ts) is the LAN as a
TypeScript object.

---

## 1. Goal

With an okay `microchip,mcp2515` node on virtio-spi cs0 and a
`chosen { zephyr,canbus }` pointing at it:

1. A dock row under a new **CAN** class shows the bus: who is on it, what
   crossed it, who won arbitration, and the controller's error state.
2. Nodes can be added and unplugged while the board runs. Unplugging the last
   other node drives the controller **bus-off**, which is the class's teaching
   payoff and has no equivalent anywhere else in the tree.
3. Frames can be composed and sent from any page-side node.
4. Stock `samples/drivers/can/counter` and `samples/drivers/can/babbling` run
   unmodified, plus `CONFIG_CAN_SHELL` from the shell image.

No new QEMU device, no new bridge shape, no wasm rebuild. virtio-spi already
carries register-file parts (SCT2024, TMC50xx, PT6314) and virtio-gpio already
carries sideband lines (LA/OE, step/dir).

## 2. Shape (reuse, don't invent)

Mirror **TMC50xx** for the chip and **I2cPanel** for the surface:

| Piece | TMC50xx / I²C bus | CAN |
| --- | --- | --- |
| Transport | virtio-spi cs0 | same, DT-selected `chipId` |
| Chip model | `chips/tmc50xx.ts` | `chips/mcp2515.ts` |
| Register map | `maps/tmc50xx.json` | `maps/mcp2515.json` |
| Sideband | LA/OE on virtio-gpio | `int-gpios` on virtio-gpio |
| Panel | `I2cBody` roster + trace | `CanBody`, same three sections |
| Medium | the I²C bus object | `src/can/bus.ts` |

Two layers, kept apart:

- **`chips/mcp2515.ts`** translates SPI byte traffic to and from frames. It
  owns registers, TX/RX buffers, acceptance filters and the INT line. It knows
  nothing about other nodes.
- **`src/can/bus.ts`** owns the medium: the node list, delivery, arbitration,
  ACK, and the error counters that follow from them. It knows nothing about
  SPI.

The seam is a frame in and a frame out. That split is what keeps a second
controller (an in-SoC `zephyr,can-*`, should one ever be bridged) from
requiring the network to be rewritten.

## 3. Devicetree contract

```dts
&virtio_spi0 {
	can0: can@0 {
		compatible = "microchip,mcp2515";
		reg = <0>;
		spi-max-frequency = <10000000>;
		int-gpios = <&virtio_gpio0 8 GPIO_ACTIVE_LOW>;
		osc-freq = <16000000>;
		bus-speed = <500000>;
		status = "okay";
	};
};

/ {
	chosen { zephyr,canbus = &can0; };
};
```

Pin 8 for `int-gpios`: 4 is LED0, 5 the buzzer, 6/7 are step/dir or LA/OE.

Insights resolve the row from the `zephyr,canbus` chosen node, so the roster's
local entry is named from **its DT label** (`can0`). Without a live MCP2515 on
the bus there is no interactive row, same progressive fill as the other
bridges.

## 4. The network model — `src/can/bus.ts`

```ts
interface CanNode {
  id: string
  name: string          // the local node uses its DT label
  local: boolean        // the MCP2515 this board drives
  acks: boolean         // false = listen-only: sends no dominant bit, ACK included
  transmit?: { id: number; periodMs: number; data: () => Uint8Array }
  respondTo?: { id: number; reply: (f: CanFrame) => CanFrame | null }
  tec: number
  rec: number
  state: 'error-active' | 'error-passive' | 'bus-off'
}
```

### The node catalog

Page-side nodes are **not scenarios and not personas**. Each is a preset over
the three behaviour fields above, and each earns its place by being the
counterpart a packaged sample needs — the same reason `src/net/stack.ts` plays
gateway and DNS rather than for flavour. A node named for a device it is not
("Engine ECU") implies simulation depth that does not exist, and invites the
signal-decoding scope this spec rules out in §10.

| Node | Behaviour | Exists for |
| --- | --- | --- |
| Counter | Replies to the counter frame with an incrementing one | `samples/drivers/can/counter`, which otherwise has nobody to count with |
| Periodic | Transmits an ID at a period | `can recv`; gives the lane view something to draw |
| Responder | Replies to an RTR for an ID | `can send`; RTR is otherwise unexercised |
| Listener | ACKs every frame, transmits none | keeps the bus alive under `babbling`; unplug it for bus-off |
| Silent | Listen-only: no transmit, **no ACK** | present but useless, the subtler bus-off |

Counter is a `respondTo` preset with a counter in its reply, not a sixth
primitive. Its IDs come from the sample and are not user-set.

### Adding a node

The Add row is `AttachRow`'s shape: a type select, a button, and **fields the
selected type needs** — the same progressive disclosure `AttachRow` already
does when it shows a second address field only for chips that have one.

| Type | Fields |
| --- | --- |
| Periodic | ID, period in ms |
| Responder | ID |
| Counter, Listener, Silent | none |

Fields are set at add time and not editable afterwards. Removing and re-adding
is the way to change one, exactly as it is for an I²C chip at a different
address. Two arguments were weighed for making a Periodic node's period live-
editable, and both lost: it is the only field anyone would want to change, and
the composer already covers one-off traffic. Revisit if the arbitration demo
turns out to need a load knob.

**Listener and Silent are not the same node.** In CAN, listen-only (Bosch
"silent") mode sends no dominant bits at all, so a listen-only node does not
acknowledge either; Zephyr's `CAN_MODE_LISTENONLY` is that mode. Collapsing
the two breaks the class's headline demo: a Silent node on the roster looks
like company while `can0` counts its way to bus-off with nothing ACKing.
Listener is an ordinary node that happens never to transmit.

Rules, all of them page-side and none of them timed to the bit:

- **Delivery** is broadcast. A transmitted frame is offered to every other
  attached node; each decides whether it matches its filters.
- **Arbitration.** A node that becomes ready while the medium is occupied
  queues. When the medium frees, everything queued contends and the lowest ID
  wins. This is the layer the lane view draws, and §4.1 is what makes it
  happen at all.
- **ACK** is "at least one other attached node has `acks`". This is the whole
  mechanism behind bus-off, and it is why the roster's `×` is the interesting
  control. A Silent node deliberately does not satisfy it.
- **Error counters** follow ISO 11898-1 closely enough to teach: a transmit
  that nobody ACKs adds 8 to TEC, a successful one subtracts 1;
  `error-passive` above 127, `bus-off` above 255.

Wall-clock, not guest time — the DAC scope already learned that icount freezes
while the board waits on a virtqueue.

### 4.1 Bit timing, and what actually triggers a retry

An earlier draft said bit timing was accepted and ignored. That cannot stand,
because it leaves nothing to arbitrate: if the bus dispatches one frame at a
time and every transmission completes instantly, two nodes are never ready at
once and a lost-arbitration event could only ever be staged.

So the medium has **occupancy**, and that is the one thing bit timing is used
for. The driver programs CNF1–3; the model derives the bitrate and computes
how long each frame holds the bus — frame bits ÷ bitrate, about 216 µs for an
8-byte standard frame at 500 kbit/s. Nothing is paced to the bit, no stuffing,
no error frames. That single derived number is the whole difference between
real contention and theatre.

Two causes of a retry follow, and the trace distinguishes them because they
mean different things:

1. **Lost arbitration.** The node was ready while the bus was busy, queued,
   and then lost the contest when it freed. No error counter moves; the frame
   goes out on a later attempt. Rendered `0x200 lost arbitration to 0x100`.
2. **No ACK.** The frame went out and nobody acknowledged it. TEC += 8 and the
   controller retransmits — the MCP2515 does this automatically unless
   one-shot mode is set in `CANCTRL`. Rendered `no ACK · TEC n`.

The useful consequence: **arbitration frequency follows bus load, and at idle
it is near zero.** That is not a shortcoming, it is what real hardware does —
a quiet bus does not arbitrate. It does mean the lane view is dull until
something loads the bus, which is the concrete reason `babbling` is worth
packaging (§8) rather than a nice-to-have: it holds the medium almost
continuously, so every other node queues and contends on nearly every frame.

## 5. The chip model — `chips/mcp2515.ts`

A register file with a JSON map, per the rule in next-drivers.md §4. SPI
command bytes: `RESET 0xC0`, `READ 0x03`, `WRITE 0x02`, `READ_STATUS 0xA0`,
`RX_STATUS 0xB0`, `BIT_MODIFY 0x05`, `LOAD_TX 0x40|n`, `RTS 0x80|n`,
`READ_RX 0x90|n`.

Map covers at least `CANCTRL` / `CANSTAT` (mode bits, and the readback the
driver spins on), `CANINTE` / `CANINTF`, `EFLG`, `TEC` / `REC`, `CNF1`–`CNF3`,
`TXB0–2` and `RXB0–1` control + payload, `RXF0–5`, `RXM0–1`.

Two things carry real risk and should be checked against the tree before
anyone commits to an estimate:

- **Mode transitions.** The driver puts the part in configuration mode, writes
  bit timing, returns to normal, and waits on `CANSTAT.OPMOD` to read back.
  Getting that handshake wrong hangs probe.
- **The INT line.** Zephyr's driver runs a dedicated interrupt thread. How
  promptly the page must deassert INT after `CANINTF` is cleared, and whether
  a level-triggered line on virtio-gpio satisfies it, is unverified.

## 6. Dock inventory

| Field | Value |
| --- | --- |
| `DeviceClass` | `'can-bus'` (new), `CLASS_LABELS` → `CAN` |
| `BodyKind` | `'can'` (new) |
| `PanelKind` | `'can'` (new), for expand-on-boot |
| `compatible` | `microchip,mcp2515` |
| Path | the chip node, so ⌗ nests it under `virtio_spi0` |

Class order: after `uart-bus`, with the other buses. In ⌗ it sits where the
chip sits — under the SPI controller, like TMC50xx — because that is where the
wires are; only the ▤ grouping calls it a bus.

Collapsed badge: `<frames/s> · <bitrate>` normally, the state name in
`--destructive` when `error-passive` or `bus-off`.

## 7. UI

Body sections, top to bottom, mirroring `I2cBody`'s rhythm:

| Section | Contents |
| --- | --- |
| On the bus | Roster. Local node first, accent border, no `×`. |
| Add node | Catalog select + Add, exactly `AttachRow`'s shape. |
| Send | ID / DLC / RTR / ext, eight byte fields, Send. |
| Arbitration | Lane strip, one lane per node. |
| Traffic | Frame trace, newest first, `clear`. |

The composer sends **as the roster's selected node**, so TEC/REC and
arbitration attribute to something real rather than to an anonymous injector.

Trace rows reuse `TransactionRow`'s conventions: direction glyph in the same
amber/sky as I²C write/read, ID in `--primary`, a right-aligned note column
where the NAK tag lives. Three row states beyond plain traffic:

- **filtered** — reached the controller, matched no acceptance filter. Greyed,
  still listed. Nothing else in the tree can show this; a filtered frame
  leaves no evidence on the board at all.
- **no ACK** — nobody acknowledged, with the resulting TEC.
- **arbitration** — `0x200 lost arbitration to 0x100`, in `--warning`.

### Copy rules

The panel is dense with real data already; prose is what makes it unreadable.

- **No explanatory paragraphs in the body.** Identity belongs to
  `PartIdentityStrip`, the register map to Registers. Block A of the mockup
  carries no `.hint` at all.
- **Never name the emulated side.** The local node is `can0`, its DT label.
  Not "guest", not "the board", not "Zephyr".
- **No em dashes in UI strings.** `·` separates facts; a period ends a
  sentence. Sub-lines are data, not sentences: `0x0A0 every 100 ms · TEC 0
  REC 0`.
- **Labels are one or two words.** `Send`, not "Send a frame". `Recover`, not
  "Plug a node back in".
- **Tooltips carry the teaching.** Everything cut from the body goes into a
  `title`, which is where a reader who wants the mechanism can find it without
  the reader who wants the data paying for it.

| Element | Tooltip |
| --- | --- |
| Local roster row | This board's controller |
| `error-active` pill | Transmit errors below 128. Normal operation. |
| `error-passive` pill | Transmit errors above 127. Still on the bus, defers longer after transmitting. |
| `bus-off` pill | Transmit errors reached 256. Off the bus until recovery. |
| `×` on the last other node | Unplug. Nothing left to ACK `can0`'s frames. |
| Filtered trace row | Reached `can0`. No acceptance filter matches `0x2FF`. |
| No-ACK trace row | No node acknowledged the frame. Each failure adds 8 to TEC. |
| Arbitration trace row | Both started in the same slot. Lower ID wins the bus. |
| Recover button | Transmission stays stopped until `can_recover()`. |
| Listener sub-line | Acknowledges every frame, never transmits one. |
| Silent sub-line | Listen-only. Sends nothing, not even an ACK. |

## 8. Packaging

Snippet `can-mcp2515-only` (declares `can@0`, disables the NOR on cs0, sets
`zephyr,canbus`), fragment `conf/mcp2515.conf` (`CONFIG_CAN=y`,
`CONFIG_CAN_MCP2515=y`, `CONFIG_SPI=y`, `CONFIG_GPIO=y`):

```
qemu_cortex_a53:can_counter:samples/drivers/can/counter:conf/mcp2515.conf:can-mcp2515-only
qemu_cortex_a53:can_babbling:samples/drivers/can/babbling:conf/mcp2515.conf:can-mcp2515-only
```

Plus the same two on `qemu_riscv32`, and `CONFIG_CAN_SHELL=y` folded into the
A53/riscv shell image's fragment list so `can send` / `can show` bind there.
Cortex-M3 is out: it has no virtio bus to put the part on.

`babbling` is worth packaging precisely because it is antisocial. It floods
the bus, which is what makes the arbitration lanes show something other than
an idle timeline.

## 9. Risks

- **`can_recover()` may not be callable.** Recent Zephyr gates manual bus-off
  recovery behind `CONFIG_CAN_MANUAL_RECOVERY_MODE`; without it, recovery is
  automatic and the Recover button is either wrong or has to set the Kconfig.
  Check before drawing that button. Adding a node back is the fallback that
  always works.
- **MCP2515 mode handshake and INT timing** — §5.
- **Contention involving `can0` specifically may stay rare.** §4.1 makes
  arbitration real by giving the medium occupancy, and under `babbling` the
  bus is loaded enough that page-side nodes contend constantly. But `can0`
  transmits when the emulated board gets round to an RTS, and that board runs
  well below wall clock, so collisions *with the local node* — the ones a
  reader cares about — are the least likely of all. Mitigation is load, not
  fakery: package `babbling`, and if that is still not enough, add a Periodic
  preset fast enough to saturate. Manufacturing a collision `can0` did not
  lose is off the table.

## 10. Out of scope

- **DBC / signal decoding, J1939, CANopen.** Application layer. The panel's
  subject is frames, arbitration, filters and error states.
- **CAN FD.** The MCP2515 is not an FD part; picking an MCP2518FD instead
  would be a different chip model, not an extension of this one.
- **Bit-level timing, error frames on the wire, bit stuffing.** Not modelled,
  and the UI must not imply they are.
- **A second CAN controller / gateway topologies.** The `bus.ts` seam allows
  it; nothing needs it yet.

## 11. Acceptance

- `bus.ts` unit tests: broadcast delivery, filter match, lowest-ID
  arbitration, TEC +8 on unACKed transmit and −1 on success, thresholds at
  128 and 256.
- `mcp2515.ts` tests: reset defaults, `BIT_MODIFY` semantics, mode readback
  through `CANSTAT`, a `LOAD_TX` + `RTS` round trip landing a frame on the
  bus, a delivered frame appearing in `RXB0` with INT asserted.
- Unplugging the last ACKing node drives the roster to `bus-off` within 32
  transmit attempts.
- `samples/drivers/can/counter` exchanges counter frames with a page-side
  node on both A53 and riscv32.
- `npm test` and `npm run typecheck` clean.
