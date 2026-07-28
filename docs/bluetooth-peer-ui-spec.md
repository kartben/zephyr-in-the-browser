# Spec: per-peer Bluetooth control UI

**Status:** draft for review — **UI shell rendered in the mock dock** for
screenshots; Bumble `setPeerParam` apply is still stubbed.
**Related:** [`bluetooth.md`](bluetooth.md), current dock in `BluetoothPanel.tsx`,
sensor bodies in `SensorCard.tsx`, CAN roster in `CanPanel.tsx`.

**Mockup renders** (Chromium, mock backend): see PR artifacts /
`/opt/cursor/artifacts/screenshots/bt-inspector-*.png` from
`tools/screenshot-bt.mjs`.

## Problem

In-page Bluetooth peers (HRM, advertiser, scanner) are on the air the way CAN
nodes are on the bus, but they are not inert fixtures. A scanner should show
what it heard; an HRM should let you change BPM; advertising should start and
stop. Sensors already have that kind of live control surface. CAN nodes mostly
do not — params are set at Add time, then the roster is name + unplug.

We want sensor-like **configure / control** for each peer **without** turning
the Bluetooth dock body into a stack of always-open control panels.

## Non-goals (this draft)

- Promoting each peer to its own dock topology row (one `DeviceNode` per peer).
- Embedding full Hive apps / WebSocket peers.
- A packet sniffer or HCI log as the primary surface (may come later as a fold).
- Redesigning CAN to match (CAN can stay add-time-only).

## Constraints from existing UI

| Pattern | What it optimizes for | Fit for BT peers |
| --- | --- | --- |
| **Sensor dock row** | One chip = one expandable row; controls are the body | Wrong identity: peers are not board inventory; they are page-side actors on the HCI controller’s LocalLink |
| **CAN roster** | Many nodes, little chrome; Add carries the only knobs | Too weak once peers need *live* knobs (BPM, scan on/off) |
| **HCI floating window** | Same body, more vertical room | Useful density escape hatch; does not solve “which peer am I editing?” |
| **In-body `Disclosure`** | Secondary sections without leaving the body | Good for traffic / air log; awkward as the *only* peer editor if every peer is a Disclosure |
| **Master–detail in one body** | Roster stays scannable; one selected peer owns the controls | Best match for “sensor controls” without “sensor rows” |

## Recommendation: select-one peer inspector

Keep a single **Bluetooth HCI** dock row (and its pop-out window). Inside the
body:

1. **Controller strip** (unchanged) — phase, name, HCI rx/tx counts.
2. **On the air** — compact roster (unchanged job: who is here).
3. **Peer inspector** — appears only when a non-local peer is selected; hosts
   the sensor-like controls for *that* peer.
4. **Add peer** — stays at the bottom; optional light add-time fields later.

```
┌ Bluetooth HCI ─────────────────────────┐
│ Controller ready · zephyr-browser      │
│ Host→ctl 12 · ctl→host 9               │
│                                        │
│ On the air                             │
│ ┌ zephyr-browser              local  ┐ │
│ ├ Heart rate 1            ● selected │ │
│ ├ Scanner 2                          │ │
│ └ Advertiser 3                    ×  │ │
│                                        │
│ Heart rate 1                     [×]   │  ← inspector header
│  Heart rate          ====72=== BPM     │
│  Body location       [ Chest     ▾ ]   │
│  Advertising         [ on ]            │
│                                        │
│ Add peer  [ Heart rate monitor ▾ ] Add │
└────────────────────────────────────────┘
```

### Why this avoids clutter

- **At most one** control surface is open at a time (the selected peer).
- Roster rows stay two-line (name + one status subtitle), like today.
- Selecting the local controller row either clears the inspector or shows a
  thin controller-only strip (no fake sensor knobs on the HCI pipe).
- Pop-out window reuses the same body: more height for inspector + roster,
  still one selection.

### Interaction rules

| Action | Result |
| --- | --- |
| Click peer row | Select it; show inspector; do not remove |
| Click selected peer again | Deselect; hide inspector (optional; see open questions) |
| Click local controller | Deselect peer inspector (controller strip already visible) |
| Remove (`×`) | If removed peer was selected, clear selection |
| Add peer | Select the new peer so its controls are immediately reachable |
| Dock collapsed / windowed | Selection persisted in `hostBt` (or dockStore) for the session |

Roster row chrome while selected: subtle selected state (background / ring),
not an in-row accordion of sliders.

## Control language (reuse sensors, don’t clone SensorCard)

Use the same primitives as sensors (`SliderControl`, `SelectControl`,
`CheckControl` from `components/controls/ControlRow.tsx`) so peer UIs feel
like chip bodies. Do **not** route peers through `SensorChip` / declarations
unless a peer later grows a register map worth sharing.

Each peer type declares a small **control schema** next to the catalog
(extend `src/bt/peers.ts` or `src/bt/peerControls.ts`):

```ts
// Illustrative — not landed
type PeerControl =
  | { kind: 'slider'; key: 'bpm'; label: string; min: number; max: number; step?: number; unit?: string }
  | { kind: 'select'; key: 'bodyLocation'; label: string; options: { value: string; label: string }[] }
  | { kind: 'toggle'; key: 'advertising'; label: string }
  | { kind: 'toggle'; key: 'scanning'; label: string }
  | { kind: 'readonly'; key: 'advCount'; label: string } // or live meta in header
```

`BluetoothPanel` renders schema → controls; `hostBt` / `bumbleController`
apply `setPeerParam(id, key, value)`.

## Per-type control surfaces (v1)

Keep v1 to knobs that already map cleanly onto Bumble Device APIs we use.

### Heart rate monitor (`hrm`)

| Control | Type | Notes |
| --- | --- | --- |
| Heart rate | slider 40–200 BPM | Drives measurement + notifications if connected |
| Body sensor location | select | Maps to `HeartRateService.BodySensorLocation` |
| Advertising | toggle | `start_advertising` / `stop_advertising` |

Roster subtitle: `72 BPM · advertising` (live), not the static catalog blurb.

### Advertiser (`advertiser`)

| Control | Type | Notes |
| --- | --- | --- |
| Local name | text (short) | Updates adv payload; may require brief restart of advertising |
| Advertising | toggle | Same as HRM |
| Connectable | toggle | v1 optional; default on |

Defer custom AD / manufacturer data to v2.

### Scanner (`scanner`)

| Control | Type | Notes |
| --- | --- | --- |
| Scanning | toggle | `start_scanning` / `stop_scanning` |
| Active scan | toggle | Passive default (today); active = scan requests |
| Reports | readonly / meta | Count in inspector header + roster subtitle |

v1 list: optional compact “last N advertisements” inside the inspector only
(name / addr / RSSI if LocalLink provides it) — **not** in the roster.
Cap height (e.g. 5 rows) so the inspector does not dominate the dock.

### Local controller (not a peer type)

No sensor-like inspector in v1. Optional later: “Reset controller”, link to
HCI counters, power. Keep out of the peer schema.

## Density rules (hard)

1. **One inspector.** Never expand controls inline for every peer.
2. **Roster ≤ 2 lines per peer.** Status belongs in the subtitle or inspector
   meta, not extra chips/badges on the row.
3. **≤ ~4 controls per peer in v1.** If a type needs more, put the rest behind
   a single `Disclosure` titled “More” inside the inspector.
4. **Add peer stays dumb in v1** (type + Add). Live controls live on the
   inspector after add — avoids duplicating fields on Add and again below.
5. **Air traffic is not the roster.** Adv reports / connections get their own
   fold later (`Disclosure` “Traffic”), shared across peers — same lesson as
   CAN’s bus-wide Traffic section.
6. **Window is allowed to be denser; dock must still work.** If the inspector
   cannot fit without crushing the roster, prefer scroll inside the HCI body
   over nesting a second floating window per peer.

## Alternatives considered

### A. Inline accordion per peer (Disclosure on every row)

Pros: no selection model. Cons: two open peers double the height; easy to
recreate the clutter this spec is avoiding. Rejected for v1.

### B. One dock row per peer (sensor-style)

Pros: familiar expand/pop-out per device. Cons: peers are not board
topology; UART parent / Bluetooth class group become noisy; inventory lies
about hardware. Rejected.

### C. CAN-only (configure at Add, no live UI)

Pros: minimal. Cons: fails the stated goal (HRM BPM, scan control). Rejected
as the end state; Add-time fields may still appear later for defaults.

### D. Secondary dialog (RegisterMap-style) per peer

Pros: zero roster growth. Cons: peers are the primary teaching surface, not
fine-grained regs; dialogs fight the “page is the air” workbench feel.
Keep dialogs for deep dumps (GATT table, raw AD bytes) in v2+.

## Data / API sketch

Extend snapshots so the UI can bind without re-querying Python each keystroke:

```ts
interface BtPeerSnapshot {
  id: string
  typeId: string
  name: string
  detail: string // short roster subtitle, derived from live params
  local?: boolean
  /** Present for remote peers once inspector lands. */
  params?: Record<string, string | number | boolean>
}
```

Store selection in `hostBt` (session): `selectedPeerId: string | null`.

Mutations:

- `selectPeer(id | null)`
- `setPeerParam(id, key, value) → Promise<void>` (mock updates snapshot;
  real path calls into Pyodide)

Mock backend must implement the same param keys so screenshots and tests do
not require Pyodide.

## Phasing

| Phase | Deliverable |
| --- | --- |
| **P0** | Selection model + inspector shell + `hrm` slider/select/adv toggle (mock + real) |
| **P1** | `advertiser` + `scanner` controls; live roster subtitles |
| **P2** | Scanner last-N list; optional Add-time defaults; “Traffic” Disclosure |
| **P3** | Deep views (GATT / raw AD) as dialogs; external Hive still separate |

## Open questions for review

1. **Deselect on second click** vs always keep last peer selected?
2. Should **Add peer** pre-select and auto-scroll the inspector into view in
   the narrow dock?
3. Is a **local-name text field** acceptable in the dock (sensors mostly avoid
   free text), or should advertiser name stay auto-generated until P2?
4. For HRM, is notifying connected centrals in-scope for P0, or is
   advertising + readable measurement enough?
5. Persist selection across reload (`dockStore`), or session-only in `hostBt`?
6. Any peer type that should *not* get an inspector (e.g. future “silent
   listener”) and stay roster-only like CAN Silent?

## Decision asked

Approve **select-one peer inspector** (with density rules above) as the
direction, or prefer an alternate from the list. After approval, implement P0
on the existing Bluetooth PR branch.
