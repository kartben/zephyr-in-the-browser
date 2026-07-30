import { describe, expect, it } from 'vitest'
import { parseDts } from './parser'
import {
  dtRankOf,
  findDtState,
  pmStateFromName,
  pmTupleLabel,
  readPowerStates,
  statesForCpu,
} from './powerStates'

/**
 * The A53 shape: no label on the cpu node in the board dtsi, so the overlay has
 * to reach it by path and declare `cpu0:` itself. Annotated exactly like the
 * flattened trees the page actually loads — the packaged .dts carries a few
 * hundred `/* in ... *​/` trailing comments.
 */
const A53 = `
/dts-v1/;
/ {
	cpus {
		#address-cells = <0x1>;
		cpu0: cpu@0 {
			device_type = "cpu";                 /* in zephyr/dts/arm64/qemu/qemu-virt-a53.dtsi:30 */
			reg = < 0x0 >;
			cpu-power-states = < &runtime_idle &suspend_to_idle &standby >;
		};
		cpu1: cpu@1 {
			device_type = "cpu";
			reg = < 0x1 >;
			cpu-power-states = < &runtime_idle &suspend_to_idle &standby >;
		};
	};

	power-states {
		runtime_idle: runtime-idle {
			compatible = "zephyr,power-state";
			power-state-name = "runtime-idle";
			min-residency-us = < 0xf4240 >;      /* 1000000 */
			exit-latency-us = < 0x2710 >;        /* 10000 */
			phandle = < 0x7 >;
		};
		suspend_to_idle: suspend-to-idle {
			compatible = "zephyr,power-state";
			power-state-name = "suspend-to-idle";
			min-residency-us = < 1100000 >;
			exit-latency-us = < 20000 >;
			phandle = < 0x8 >;
		};
		standby: standby {
			compatible = "zephyr,power-state";
			power-state-name = "standby";
			min-residency-us = < 1200000 >;
			exit-latency-us = < 30000 >;
			zephyr,pm-device-disabled;
			phandle = < 0x9 >;
		};
	};
};
`

/**
 * The STM32 idiom, and the reason rank cannot come from `enum pm_state`: three
 * hardware states, all `suspend-to-idle`, told apart only by substate-id. Plus a
 * `status = "disabled"` state (forceable but not policy-reachable) and an orphan
 * no cpu references.
 */
const SUBSTATES = `
/dts-v1/;
/ {
	cpus {
		cpu@0 {
			device_type = "cpu";
			reg = < 0x0 >;
			cpu-power-states = < &stop0 &stop1 &stop2 >;
		};
	};
	soc {
		power-states {
			stop0: state0 {
				compatible = "zephyr,power-state";
				power-state-name = "suspend-to-idle";
				substate-id = < 1 >;
				min-residency-us = < 100 >;
			};
			stop1: state1 {
				compatible = "zephyr,power-state";
				power-state-name = "suspend-to-idle";
				substate-id = < 2 >;
				min-residency-us = < 500 >;
			};
			stop2: state2 {
				compatible = "zephyr,power-state";
				power-state-name = "suspend-to-idle";
				substate-id = < 3 >;
				min-residency-us = < 900 >;
			};
			stop3: state3 {
				compatible = "zephyr,power-state";
				power-state-name = "suspend-to-ram";
				substate-id = < 4 >;
				status = "disabled";
			};
		};
	};
};
`

describe('readPowerStates', () => {
  it('reads the A53 ladder through a path-addressed cpu node', () => {
    const info = readPowerStates(parseDts(A53))
    expect(info.absent).toBe(false)
    expect(info.orphans).toEqual([])
    expect(info.cpus.map((c) => c.cpuPath)).toEqual(['/cpus/cpu@0', '/cpus/cpu@1'])
    expect(info.cpus.map((c) => c.cpuIndex)).toEqual([0, 1])

    const states = statesForCpu(info, 0)
    expect(states.map((s) => s.label)).toEqual(['runtime_idle', 'suspend_to_idle', 'standby'])
    expect(states.map((s) => s.state)).toEqual([1, 2, 3])
    expect(states[0]).toMatchObject({
      stateName: 'runtime-idle',
      substateId: 0,
      minResidencyUs: 1_000_000,
      exitLatencyUs: 10_000,
      deviceDisabled: false,
      enabled: true,
    })
    // Hex and decimal both decode — the flattened tree writes hex.
    expect(states[1]?.minResidencyUs).toBe(1_100_000)
    expect(states[2]?.deviceDisabled).toBe(true)
  })

  it('shares state nodes between CPUs without duplicating them', () => {
    const info = readPowerStates(parseDts(A53))
    // Same node, so the same path — this is why `cpu` in the CTF event matters.
    expect(statesForCpu(info, 1).map((s) => s.path)).toEqual(
      statesForCpu(info, 0).map((s) => s.path),
    )
  })

  it('ranks same-enum substates by list position, which the enum cannot do', () => {
    const info = readPowerStates(parseDts(SUBSTATES))
    // All three are suspend-to-idle (2), so ranking on `state` would tie them.
    expect(statesForCpu(info, 0).map((s) => s.state)).toEqual([2, 2, 2])
    expect(dtRankOf(info, 0, 2, 1)).toBe(1)
    expect(dtRankOf(info, 0, 2, 2)).toBe(2)
    expect(dtRankOf(info, 0, 2, 3)).toBe(3)
  })

  it('lists a disabled state as an orphan rather than in the ladder', () => {
    const info = readPowerStates(parseDts(SUBSTATES))
    expect(statesForCpu(info, 0)).toHaveLength(3)
    expect(info.orphans.map((s) => s.label)).toEqual(['stop3'])
    expect(info.orphans[0]?.enabled).toBe(false)
    // Still findable: pm_state_force resolves against disabled states too.
    expect(findDtState(info, 0, 4, 4)?.label).toBe('stop3')
  })

  it('finds a state under /soc/power-states as readily as at the root', () => {
    const info = readPowerStates(parseDts(SUBSTATES))
    expect(info.cpus[0]?.states[0]?.path).toBe('/soc/power-states/state0')
  })

  it('matches on the (state, substate) pair, not on state alone', () => {
    const info = readPowerStates(parseDts(SUBSTATES))
    expect(findDtState(info, 0, 2, 2)?.label).toBe('stop1')
    // An unlisted substate degrades to the same-enum state rather than nothing,
    // so a tuple the tree never declared still gets a name.
    expect(findDtState(info, 0, 2, 9)?.label).toBe('stop0')
  })

  it('reports absence instead of throwing on a tree with no power states', () => {
    const info = readPowerStates(parseDts('/dts-v1/;\n/ { cpus { cpu@0 { reg = <0>; }; }; };'))
    expect(info.absent).toBe(true)
    expect(info.cpus).toHaveLength(1)
    expect(statesForCpu(info, 0)).toEqual([])
    expect(dtRankOf(info, 0, 3, 0)).toBeNull()
    expect(findDtState(info, 0, 3, 0)).toBeNull()
  })

  it('resolves numeric phandles, not only &label references', () => {
    // A tree that wrote resolved phandles would otherwise read as "no power
    // states" — indistinguishable from a board that has none.
    const numeric = A53.replace(
      'cpu-power-states = < &runtime_idle &suspend_to_idle &standby >;\n\t\t};\n\t\tcpu1',
      'cpu-power-states = < 0x7 0x8 0x9 >;\n\t\t};\n\t\tcpu1',
    )
    const info = readPowerStates(parseDts(numeric))
    expect(statesForCpu(info, 0).map((s) => s.label)).toEqual([
      'runtime_idle',
      'suspend_to_idle',
      'standby',
    ])
  })
})

describe('labels', () => {
  it('prefers the devicetree label, then the state name, then the numbers', () => {
    const info = readPowerStates(parseDts(A53))
    expect(pmTupleLabel(findDtState(info, 0, 3, 0), 3, 0)).toBe('standby')
    expect(pmTupleLabel(null, 3, 0)).toBe('standby')
    expect(pmTupleLabel(null, 2, 1)).toBe('suspend-to-idle{1}')
    expect(pmTupleLabel(null, 42, 7)).toBe('s42.7')
  })

  it('maps every binding enum value to its pm_state index', () => {
    expect(pmStateFromName('active')).toBe(0)
    expect(pmStateFromName('runtime-idle')).toBe(1)
    expect(pmStateFromName('suspend-to-idle')).toBe(2)
    expect(pmStateFromName('standby')).toBe(3)
    expect(pmStateFromName('suspend-to-ram')).toBe(4)
    expect(pmStateFromName('suspend-to-disk')).toBe(5)
    expect(pmStateFromName('soft-off')).toBe(6)
    expect(pmStateFromName('nonsense')).toBeNull()
    expect(pmStateFromName(null)).toBeNull()
  })
})
