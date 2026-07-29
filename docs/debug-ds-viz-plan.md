# Debug · View as data structure

**Status: mockup.** Interactive HTML at
[`docs/mockups/debug-ds-viz.html`](mockups/debug-ds-viz.html). No app code yet.

## Why yes

Learners already pause and poke guest RAM as a hex dump. Zephyr’s
`include/zephyr/sys` containers are **intrusive, header-stable, and small**:
`rbnode` is two pointers (color in the LSB of `children[0]`); `ring_buf` is a
buffer pointer plus put/get indices and a size. Walking them from a paused GDB
session is the same RSP `m` traffic Mem already uses — just interpreted.

That is a good fit for Zephyr in the Browser:

- Hex alone hides topology (who points where, red vs black, wrap of a ring).
- Objects already decodes kernel cores into fields; this is the **pointer-graph**
  sibling for `sys/*` containers the sample author embeds.
- ABIs change rarely; we can hard-code layouts (or later DWARF-check them) without
  inventing a general type system.

## Placement

**Debug → Mem**, next to Address / Read / Find:

```
[ 4002a100________ ] [Read]   [View as ▾]
[ Find · hex or "ascii" ] [↓] [Find]
```

`View as` picks a layout for **the address in the bar** (the `struct rbtree *`
or `struct ring_buf *`, not a random interior byte). Default remains the hex
dump. Choosing a type replaces the dump with a typed pane; **Hex** returns.

Do **not** add a new Debug tab until the Mem chrome feels crowded. Kernel
Objects can later offer “Open as rbtree…” that seeds Mem’s address + type via
`debugUi`.

## First types

| Type | Decode | Viz |
|------|--------|-----|
| `rbtree` / `rbnode` | `root`, `lessthan_fn`, `max_depth`; walk with `children[0]` color bit cleared | Layered tree of address boxes; red/black fill; collapse deep/wide limbs to `…` |
| `ring_buf` | `buffer`, `put`/`get` `{head,tail,base}`, `size` | Circular belt + linear unwrap; used arc; put/get markers; large buffers show head/tail windows with `…` |

Later candidates (same Mem entry point): `sys_slist`, `sys_dlist`, `sys_sflist`,
`k_msgq` buffer layout. Prefer types with a single stable root struct.

## Viz tech

Reuse what we already ship:

- **d3-hierarchy** (`d3.tree` / `cluster`) for rbtree layout — same d3 family as
  Trace Queues charts; no Graphviz/Mermaid dependency in the page.
- Hand-drawn SVG (QueueGraph style) is fine if d3 hierarchy feels heavy; avoid
  ELK unless the graph is multi-root / cyclic.
- Pointers are **address chips** you can click → re-seed Mem / highlight hex.
- Collapse rule of thumb: show full tree up to ~24 nodes; beyond that keep the
  path to the selection expanded and fold sibling subtrees into `… (n)`.

Mermaid/Graphviz are great for static docs; they are the wrong runtime for a
live, clickable, theme-matched dock pane.

## ABI notes (AArch64 / AArch32)

Confirmed from upstream `rb.c` / `ring_buffer.h`:

- Color bit: `((uintptr_t)node->children[0]) & 1` — **BLACK = 1**, **RED = 0**.
  Left child pointer must mask `~1` before chase.
- No parent pointer — host builds the tree by chasing children only (cap depth /
  node count; detect cycles).
- `ring_buf_idx_t` is `uint16_t` unless `CONFIG_RING_BUFFER_LARGE` (`uint32_t`).
  Prefer reading both and sanity-checking against `size`, or DWARF when present.

## Mockup covers

1. Mem toolbar with **View as** menu (Hex / rbtree / ring_buf; future types muted).
2. rbtree pane: header fields, d3 tree, selection, ellipsis folds, expand-on-click.
3. ring_buf pane: field strip, circular used/free, linear unwrap with `…`, put/get.
4. Narrow dock width + wider undocked stage (toggle in the mockup).

## Out of scope for v1

- Editing structure fields in place
- Automatic type guess from DWARF without user pick
- Walking container-of payloads (show node addresses; optional later “container”
  offset once DWARF knows the embedder)
