# Debug · View as data structure

**Status: implementing.** Mockup at
[`docs/mockups/debug-ds-viz.html`](mockups/debug-ds-viz.html); app code under
`src/debug/ds/` + `src/components/debug/ds/`.

## Why yes

Learners already pause and poke guest RAM as a hex dump. Zephyr’s
`include/zephyr/sys` containers are **intrusive, header-stable, and small**.
Walking them from a paused GDB session is the same RSP `m` traffic Mem already
uses — just interpreted.

## Placement

**Debug → Mem**, next to Address / Read / Find:

```
[ 4002a100________ ] [Read]   [View as ▾]
[ Find · hex or "ascii" ] [↓] [Find]
```

`View as` picks a layout for **the address in the bar** (the container root,
not a random interior byte). Default remains the hex dump.

## Types

| Type | Decode | Viz |
|------|--------|-----|
| `rbtree` | `root`, `lessthan_fn`, `max_depth`; walk `children[]` with color LSB | Layered tree of address boxes; red/black; fold deep limbs to `… +n` |
| `ring_buf` | `buffer`, `put`/`get` `{head,tail,base}`, `size` | Circular belt + linear unwrap; large → get-window · `···` · put-window |
| `sys_slist` | `head`, `tail`; chase `next` | Horizontal chain of node boxes; head/tail pins; fold middle to `…` |
| `sys_dlist` | list node is in the ring (`head`/`tail` ≡ `next`/`prev`); empty = self-pointers | Circular / ring of boxes including the list sentinel |

Later: `sys_sflist` (flagged next), `k_msgq` buffer layout.

## Heuristics — can we guess the type?

**Not reliably enough to auto-switch.** Soft ranking in the menu is fine; silent
auto-detect is not.

| Signal | Helps? | Failure mode |
|--------|--------|--------------|
| `ring_buf.size` in a sane range, indices `< 2×size`, `buffer` looks like RAM | Medium | Any struct with a pointer + small ints can fake it; `CONFIG_RING_BUFFER_LARGE` changes index width |
| `rbtree.lessthan_fn` in text, `max_depth` ∈ 0…64, root NULL or aligned | Medium | Two pointers + an int is a common pattern; color bit only shows up after chasing nodes |
| `sys_dlist` empty = both words equal the list address | Strong for **empty** lists | Non-empty looks like any circular doubly-linked structure (including Linux-style lists) |
| `sys_slist` head/tail both NULL, or short walk ending at `tail` | Weak–medium | Indistinguishable from any `{ptr,ptr}` pair until you walk |

Better sources of truth, in order:

1. **User pick** (this UI).
2. **DWARF** type at the address / symbol (when the ELF has it).
3. **Objects / tours** seeding Mem with a known type via `debugUi`.
4. Optional **soft scores** in the View-as menu (“ring_buf · maybe”) — never
   applied without a click.

v1 ships user pick + optional soft scores; no auto-apply.

## Viz tech

- Hand-drawn SVG / light d3 (same language as Trace Queues) — no Mermaid/Graphviz
  at runtime.
- Pointers are clickable address chips → re-seed Mem / peek hex.
- Collapse: full graph up to ~24 nodes; beyond that fold siblings into `… +n`.

## ABI notes

- **rbtree color:** `((uintptr_t)node->children[0]) & 1` — BLACK=1, RED=0; mask
  `~1` before chase. No parent pointer.
- **ring_buf_idx_t:** `uint16_t` unless `CONFIG_RING_BUFFER_LARGE`. Prefer DWARF
  offsets when present; else try uint16 layout and sanity-check.
- **slist:** `{ head, tail }` + nodes with one `next`.
- **dlist:** `sys_dlist_t` and `sys_dnode_t` are the same `_dnode` shape; the
  list struct sits in the ring. Empty ⟺ `head == tail == &list`.

Pointer width follows `regArch` (8 on AArch64, 4 on arm / riscv32).
