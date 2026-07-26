/*
 * Copyright (c) 2020 Libre Solar Technologies GmbH
 * Copyright (c) 2026 Benjamin Cabé <benjamin@zephyrproject.org>
 *
 * Adapted from upstream samples/drivers/dac: that sample's k_sleep(K_MSEC(1))
 * assumes dac_write_value() is effectively free, true on real hardware. Over
 * virtio-i2c every write is a round trip to the browser -- measured at
 * ~1.1-1.2 ms even after fixing the guest tick rate (see conf/mcp4725.conf) --
 * so a blind fixed-length sleep after each write stretches the sample's own
 * documented "~4 s sawtooth period" out to roughly double that. This tracks
 * an absolute deadline instead of sleeping a fixed amount after the write:
 * it sleeps only what's left of the budget once the write is accounted for,
 * so the loop periods against wall time rather than against write-plus-sleep.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include <zephyr/drivers/dac.h>

#define ZEPHYR_USER_NODE DT_PATH(zephyr_user)

#if (DT_NODE_HAS_PROP(ZEPHYR_USER_NODE, dac) && \
	DT_NODE_HAS_PROP(ZEPHYR_USER_NODE, dac_channel_id) && \
	DT_NODE_HAS_PROP(ZEPHYR_USER_NODE, dac_resolution))
#define DAC_NODE DT_PHANDLE(ZEPHYR_USER_NODE, dac)
#define DAC_CHANNEL_ID DT_PROP(ZEPHYR_USER_NODE, dac_channel_id)
#define DAC_RESOLUTION DT_PROP(ZEPHYR_USER_NODE, dac_resolution)
#else
#error "Unsupported board: see README and check /zephyr,user node"
#define DAC_NODE DT_INVALID_NODE
#define DAC_CHANNEL_ID 0
#define DAC_RESOLUTION 0
#endif

static const struct device *const dac_dev = DEVICE_DT_GET(DAC_NODE);

static const struct dac_channel_cfg dac_ch_cfg = {
	.channel_id  = DAC_CHANNEL_ID,
	.resolution  = DAC_RESOLUTION,
#if defined(CONFIG_DAC_BUFFER_NOT_SUPPORT)
	.buffered = false,
#else
	.buffered = true,
#endif /* CONFIG_DAC_BUFFER_NOT_SUPPORT */
};

int main(void)
{
	if (!device_is_ready(dac_dev)) {
		printk("DAC device %s is not ready\n", dac_dev->name);
		return 0;
	}

	int ret = dac_channel_setup(dac_dev, &dac_ch_cfg);

	if (ret != 0) {
		printk("Setting up of DAC channel failed with code %d\n", ret);
		return 0;
	}

	printk("Generating sawtooth signal at DAC channel %d.\n",
		DAC_CHANNEL_ID);

	/* Number of valid DAC values, e.g. 4096 for 12-bit DACs. */
	const int dac_values = 1U << DAC_RESOLUTION;

	/*
	 * 1 msec/step leads to about 4 sec signal period for 12-bit DACs,
	 * same target as upstream. Make sure it's at least 1 msec even for
	 * future 16-bit DACs (lowering signal frequency).
	 */
	const int step_ms = 4096 / dac_values > 0 ? 4096 / dac_values : 1;

	int64_t deadline = k_uptime_get() + step_ms;

	while (1) {
		for (int i = 0; i < dac_values; i++) {
			ret = dac_write_value(dac_dev, DAC_CHANNEL_ID, i);
			if (ret != 0) {
				printk("dac_write_value() failed with code %d\n", ret);
				return 0;
			}

			int64_t remaining = deadline - k_uptime_get();

			if (remaining > 0) {
				k_sleep(K_MSEC(remaining));
			}
			deadline += step_ms;
		}
	}
	return 0;
}
