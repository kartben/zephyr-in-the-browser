/*
 * Copyright (c) 2017 Linaro Limited
 * Copyright (c) 2018 Intel Corporation
 * Copyright (c) 2024 TOKITA Hiroshi
 * Copyright (c) 2026
 *
 * Adapted from upstream samples/drivers/led/led_strip: that sample's
 * k_sleep(K_MSEC(CONFIG_SAMPLE_LED_UPDATE_DELAY)) assumes
 * led_strip_update_rgb() is effectively free. Over virtio-spi every update is
 * a ~384-byte round trip to the browser, plus the driver's reset-delay
 * k_usleep (which used to ceil to a 10 ms QEMU tick). A blind fixed sleep
 * after each update therefore runs far slower than the configured 50 ms.
 *
 * Same approach as zephyr-module/apps/dac_sawtooth: sleep only what's left of
 * the period once the update returns, so the chase periods against wall time.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <string.h>

#define LOG_LEVEL 4
#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(main);

#include <zephyr/kernel.h>
#include <zephyr/drivers/led_strip.h>
#include <zephyr/device.h>
#include <zephyr/sys/util.h>
#include <zephyr/sys/printk.h>

#define STRIP_NODE DT_ALIAS(led_strip)

#if DT_NODE_HAS_PROP(DT_ALIAS(led_strip), chain_length)
#define STRIP_NUM_PIXELS DT_PROP(DT_ALIAS(led_strip), chain_length)
#else
#error Unable to determine length of LED strip
#endif

#define DELAY_TIME_MS CONFIG_SAMPLE_LED_UPDATE_DELAY

#define RGB(_r, _g, _b) { .r = (_r), .g = (_g), .b = (_b) }

static const struct led_rgb colors[] = {
	RGB(CONFIG_SAMPLE_LED_BRIGHTNESS, 0x00, 0x00), /* red */
	RGB(0x00, CONFIG_SAMPLE_LED_BRIGHTNESS, 0x00), /* green */
	RGB(0x00, 0x00, CONFIG_SAMPLE_LED_BRIGHTNESS), /* blue */
};

static struct led_rgb pixels[STRIP_NUM_PIXELS];

static const struct device *const strip = DEVICE_DT_GET(STRIP_NODE);

int main(void)
{
	size_t color = 0;
	int rc;
	int64_t deadline;

	if (device_is_ready(strip)) {
		LOG_INF("Found LED strip device %s", strip->name);
	} else {
		LOG_ERR("LED strip device %s is not ready", strip->name);
		return 0;
	}

	LOG_INF("Displaying pattern on strip (%d ms/step wall target)", DELAY_TIME_MS);

	deadline = k_uptime_get() + DELAY_TIME_MS;

	while (1) {
		for (size_t cursor = 0; cursor < ARRAY_SIZE(pixels); cursor++) {
			memset(&pixels, 0x00, sizeof(pixels));
			memcpy(&pixels[cursor], &colors[color], sizeof(struct led_rgb));

			rc = led_strip_update_rgb(strip, pixels, STRIP_NUM_PIXELS);
			if (rc) {
				LOG_ERR("couldn't update strip: %d", rc);
			}

			int64_t remaining = deadline - k_uptime_get();

			if (remaining > 0) {
				k_sleep(K_MSEC(remaining));
			}
			deadline += DELAY_TIME_MS;
		}

		color = (color + 1) % ARRAY_SIZE(colors);
	}

	return 0;
}
