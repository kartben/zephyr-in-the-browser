/*
 * A device whose only feature is having power management.
 *
 * Written for this repo rather than vendored: it is a demo prop, not a driver
 * anyone would upstream. It exists because system-managed device PM is
 * undemonstrable on these boards otherwise — no driver in a browser_bridge
 * build implements a PM action callback, so the suspend walk returns -ENOSYS for
 * every device and legitimately reports that it suspended none of them.
 *
 * The busy-wait in the action callback is the whole point. It gives the walk
 * width in the trace, so `pm_suspend_devices_enter`..`_exit` is a visible cost
 * in front of every deep sleep rather than two adjacent timestamps. k_busy_wait
 * and not k_sleep, deliberately: these run from the idle thread with the
 * scheduler locked and interrupts masked, where sleeping is not allowed and
 * would deadlock the suspend path.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT zephyr_pm_demo_device

#include <zephyr/device.h>
#include <zephyr/kernel.h>
#include <zephyr/pm/device.h>

struct pm_demo_device_config {
	uint32_t suspend_time_us;
	uint32_t resume_time_us;
};

static int pm_demo_device_action(const struct device *dev, enum pm_device_action action)
{
	const struct pm_demo_device_config *config = dev->config;

	switch (action) {
	case PM_DEVICE_ACTION_SUSPEND:
		k_busy_wait(config->suspend_time_us);
		return 0;
	case PM_DEVICE_ACTION_RESUME:
		k_busy_wait(config->resume_time_us);
		return 0;
	default:
		/*
		 * TURN_ON / TURN_OFF are power-domain actions and there is no
		 * domain here. -ENOTSUP is the answer the PM core expects, and
		 * it is one of the three returns the suspend walk ignores.
		 */
		return -ENOTSUP;
	}
}

static int pm_demo_device_init(const struct device *dev)
{
	/*
	 * pm_device_driver_init runs the resume action itself when the device
	 * should boot active, so the initial state matches reality instead of
	 * being assumed.
	 */
	return pm_device_driver_init(dev, pm_demo_device_action);
}

#define PM_DEMO_DEVICE_DEFINE(inst)                                                                \
	static const struct pm_demo_device_config pm_demo_device_config_##inst = {                  \
		.suspend_time_us = DT_INST_PROP(inst, suspend_time_us),                             \
		.resume_time_us = DT_INST_PROP(inst, resume_time_us),                               \
	};                                                                                         \
                                                                                                   \
	PM_DEVICE_DT_INST_DEFINE(inst, pm_demo_device_action);                                      \
                                                                                                   \
	/*                                                                                         \
	 * One priority for every instance: pm_suspend_devices() walks the static                   \
	 * device list backwards, and within a priority that list follows                           \
	 * devicetree order, so the visit order is already fixed and reproducible                   \
	 * without hand-assigning priorities per node.                                              \
	 */                                                                                        \
	DEVICE_DT_INST_DEFINE(inst, pm_demo_device_init, PM_DEVICE_DT_INST_GET(inst), NULL,         \
			      &pm_demo_device_config_##inst, POST_KERNEL,                          \
			      CONFIG_KERNEL_INIT_PRIORITY_DEVICE, NULL);

DT_INST_FOREACH_STATUS_OKAY(PM_DEMO_DEVICE_DEFINE)
