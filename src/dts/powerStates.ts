/**
 * CPU power states, read out of the devicetree.
 *
 * The PM CTF events carry `{ cpu, state, substate_id }` and nothing else — three
 * bytes of integers. Everything a reader would want to *know* about a state is
 * in the devicetree instead, so this module is what turns `state 3 substate 1`
 * into `standby`, and what tells the timeline which of two states is deeper.
 *
 * That ordering job is the load-bearing one, not the naming. Several nodes may
 * share one `pm_state` enum value and differ only by `substate-id` — STM32's
 * stop0/stop1/stop2 are all `suspend-to-idle` — so the enum alone cannot rank
 * them. `cpu-power-states` is ordered shallow to deep by Zephyr convention (the
 * default policy relies on it: subsys/pm/policy/policy_default.c walks the list
 * and stops at the first state that does not fit), so the index in that list is
 * the depth rank, and it is correct even when the enum is ambiguous.
 *
 * Deliberately its own module rather than part of insights.ts: that file's job
 * is device inventory and panel availability, it runs on every devicetree load
 * for every consumer, and a `power-states` node is not a bus, has no bridge and
 * enables no panel.
 *
 * Total, like the rest of the read layer — a tree that declares no power states
 * is the normal case, not an error.
 */

import type { DtsCell, DtsDocument, DtsNode } from './model'
import { boolProp, byPath, numberProp, pathOf, resolveRef, stringProp } from './query'

/**
 * `power-state-name` values, in `enum pm_state` order — the binding's enum list
 * is ordered to match, which is what makes DT_ENUM_IDX work on the guest side.
 */
const STATE_NAMES = [
  'active',
  'runtime-idle',
  'suspend-to-idle',
  'standby',
  'suspend-to-ram',
  'suspend-to-disk',
  'soft-off',
]

export interface DtPowerState {
  /** Node path — the stable identity, since labels are optional. */
  path: string
  /** First label, else the node name: the short name the UI shows. */
  label: string
  /** `power-state-name` verbatim, or null when absent. */
  stateName: string | null
  /** `enum pm_state` value for that name, or null when unrecognised. */
  state: number | null
  /** `substate-id`, 0 when absent — which is what the guest reports too. */
  substateId: number
  minResidencyUs: number | null
  exitLatencyUs: number | null
  /** `zephyr,pm-device-disabled`: the PM core skips the device walk for it. */
  deviceDisabled: boolean
  /** False for `status = "disabled"` — declared but only reachable by force. */
  enabled: boolean
}

export interface DtCpuPowerStates {
  /** `/cpus/cpu@0`. A path, because the A53 cpu nodes carry no label. */
  cpuPath: string
  /** Keyed against the CTF `cpu` field: the `reg` value, else the child index. */
  cpuIndex: number
  /** `cpu-power-states` order, i.e. shallow to deep. */
  states: DtPowerState[]
}

export interface PowerStatesInfo {
  cpus: DtCpuPowerStates[]
  /** Declared but referenced by no cpu. Listed, never attributed to a cpu. */
  orphans: DtPowerState[]
  /** True when the tree declares no `zephyr,power-state` node at all. */
  absent: boolean
}

/** `enum pm_state` index for a `power-state-name`, or null if unrecognised. */
export function pmStateFromName(name: string | null): number | null {
  if (name === null) return null
  const index = STATE_NAMES.indexOf(name)
  return index === -1 ? null : index
}

/** `power-state-name` for an `enum pm_state` value, or null if out of range. */
export function pmStateName(state: number): string | null {
  return STATE_NAMES[state] ?? null
}

/**
 * Resolve a phandle cell to its node.
 *
 * `resolveRef` handles `&label` and `&{/path}`, which is what the flattened
 * trees this app reads actually contain. A tree that wrote resolved phandle
 * integers instead would otherwise yield an empty state list and look like a
 * board with no power management, so the numeric form is covered too — the
 * index is built once, on first need.
 */
function phandleResolver(doc: DtsDocument): (cell: DtsCell) => DtsNode | undefined {
  let byPhandle: Map<number, DtsNode> | null = null

  return (cell) => {
    const direct = resolveRef(doc, cell)
    if (direct) return direct
    if (cell.kind !== 'number') return undefined

    if (byPhandle === null) {
      byPhandle = new Map()
      const walk = (node: DtsNode) => {
        const value = numberProp(node, 'phandle')
        if (value !== undefined && !byPhandle!.has(value)) byPhandle!.set(value, node)
        for (const child of node.children) walk(child)
      }
      walk(doc.root)
    }
    return byPhandle.get(cell.value)
  }
}

function readState(node: DtsNode): DtPowerState {
  const stateName = stringProp(node, 'power-state-name') ?? null
  const status = stringProp(node, 'status')
  return {
    path: pathOf(node),
    label: node.labels[0] ?? node.name,
    stateName,
    state: pmStateFromName(stateName),
    substateId: numberProp(node, 'substate-id') ?? 0,
    minResidencyUs: numberProp(node, 'min-residency-us') ?? null,
    exitLatencyUs: numberProp(node, 'exit-latency-us') ?? null,
    deviceDisabled: boolProp(node, 'zephyr,pm-device-disabled'),
    enabled: status === undefined || status === 'okay' || status === 'ok',
  }
}

/** Is this a cpu node? `device_type = "cpu"` is the portable answer. */
function isCpuNode(node: DtsNode): boolean {
  return stringProp(node, 'device_type') === 'cpu' || /^cpu@/.test(node.name)
}

export function readPowerStates(doc: DtsDocument): PowerStatesInfo {
  const resolve = phandleResolver(doc)
  const declared = new Map<string, DtPowerState>()

  // Compatible-based, not path-based: the node may sit at /power-states or at
  // /cpus/power-states, and Zephyr accepts either.
  for (const node of doc.compatIndex.get('zephyr,power-state') ?? []) {
    const state = readState(node)
    declared.set(state.path, state)
  }

  const cpus: DtCpuPowerStates[] = []
  const claimed = new Set<string>()
  const cpusNode = byPath(doc, '/cpus')

  for (const [index, child] of (cpusNode?.children ?? []).entries()) {
    if (!isCpuNode(child)) continue

    const states: DtPowerState[] = []
    for (const value of child.properties.find((p) => p.name === 'cpu-power-states')?.values ?? []) {
      if (value.kind !== 'cells') continue
      for (const cell of value.cells) {
        const target = resolve(cell)
        if (!target) continue
        const state = declared.get(pathOf(target)) ?? readState(target)
        claimed.add(state.path)
        states.push(state)
      }
    }

    cpus.push({
      cpuPath: pathOf(child),
      // `reg` is the CPU's own id and what CPU_ID reports; the child position
      // is only a fallback for a tree that omits it.
      cpuIndex: numberProp(child, 'reg') ?? index,
      states,
    })
  }

  return {
    cpus,
    orphans: [...declared.values()].filter((s) => !claimed.has(s.path)),
    absent: declared.size === 0,
  }
}

/** The states of one CPU, by the id the CTF events report. */
export function statesForCpu(info: PowerStatesInfo, cpuIndex: number): DtPowerState[] {
  return info.cpus.find((c) => c.cpuIndex === cpuIndex)?.states ?? []
}

/**
 * The devicetree node a `(cpu, state, substate_id)` tuple came from.
 *
 * Matching on the pair is the point: `state` alone is ambiguous whenever a board
 * maps several hardware states onto one `pm_state`.
 */
export function findDtState(
  info: PowerStatesInfo,
  cpuIndex: number,
  state: number,
  substateId: number,
): DtPowerState | null {
  const states = statesForCpu(info, cpuIndex)
  const exact = states.find((s) => s.state === state && s.substateId === substateId)
  if (exact) return exact
  // A forced state can be one the cpu does not list (pm_state_force resolves
  // against the disabled set too), so fall back to anything declared.
  return (
    info.orphans.find((s) => s.state === state && s.substateId === substateId) ??
    states.find((s) => s.state === state) ??
    null
  )
}

/**
 * Depth rank for a tuple: its index in `cpu-power-states`, which is ordered
 * shallow to deep. Null when the tree cannot answer, and the caller should fall
 * back to the raw `pm_state` value — honest, because without the devicetree the
 * relative depth of two substates genuinely is unknown.
 */
export function dtRankOf(
  info: PowerStatesInfo,
  cpuIndex: number,
  state: number,
  substateId: number,
): number | null {
  const states = statesForCpu(info, cpuIndex)
  const exact = states.findIndex((s) => s.state === state && s.substateId === substateId)
  if (exact !== -1) return exact + 1
  const loose = states.findIndex((s) => s.state === state)
  return loose === -1 ? null : loose + 1
}

/** How many rank steps this cpu's ladder has, for normalising a colour ramp. */
export function dtRankCount(info: PowerStatesInfo, cpuIndex: number): number {
  return statesForCpu(info, cpuIndex).length
}

/**
 * Short label for a tuple. Prefers the devicetree label (`standby`, `stop1`),
 * falls back to the state name, then to the raw numbers — which is what a guest
 * with power states but no `power-states` node in its tree will show.
 */
export function pmTupleLabel(dt: DtPowerState | null, state: number, substateId: number): string {
  if (dt) return dt.label
  const name = pmStateName(state)
  if (name) return substateId > 0 ? `${name}{${substateId}}` : name
  return `s${state}.${substateId}`
}
