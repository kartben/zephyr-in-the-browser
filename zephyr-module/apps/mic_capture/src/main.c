/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Live microphone level meter over Zephyr's DMIC API.
 *
 * Captures 100 ms blocks from the dmic0 device (in this repo, the
 * qemu,host-mic bridge fed by the browser's getUserMedia capture) and renders
 * an in-place VU bar on the console. Speak, and the bar moves.
 *
 * This exists in place of the stock samples/drivers/audio/dmic for one
 * reason: that sample declares `uint32_t size` but passes its address to
 * dmic_read(), whose parameter is `size_t *` — harmless on the 32-bit boards
 * it was written for, stack corruption (and a crash) on 64-bit targets like
 * qemu_cortex_a53. Verified by booting it here; a one-character `size_t` fix
 * makes it run cleanly, so it is a candidate upstream patch. This app is also
 * a nicer demo: it runs forever instead of exiting after sixteen blocks.
 */

#include <zephyr/audio/dmic.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#include <zephyr/logging/log.h>
LOG_MODULE_REGISTER(mic_capture);

#define SAMPLE_RATE 16000
#define READ_TIMEOUT_MS 1000

/* 100 ms of 16-bit mono per block, a few blocks in flight. */
#define BLOCK_SIZE ((SAMPLE_RATE / 10) * sizeof(int16_t))
#define BLOCK_COUNT 4
K_MEM_SLAB_DEFINE_STATIC(mem_slab, BLOCK_SIZE, BLOCK_COUNT, 4);

#define BAR_WIDTH 32

static void render(int peak)
{
	/* Perceptual-ish: show amplitude relative to full scale. */
	int fill = (peak * BAR_WIDTH) / 32767;
	char bar[BAR_WIDTH + 1];

	for (int i = 0; i < BAR_WIDTH; i++) {
		bar[i] = i < fill ? '#' : '.';
	}
	bar[BAR_WIDTH] = '\0';

	printk("\r[%s] %3d%%  ", bar, (peak * 100) / 32767);
}

int main(void)
{
	const struct device *const dmic_dev = DEVICE_DT_GET(DT_ALIAS(dmic0));
	int ret;

	if (!device_is_ready(dmic_dev)) {
		LOG_ERR("%s is not ready", dmic_dev->name);
		return 0;
	}

	struct pcm_stream_cfg stream = {
		.pcm_rate = SAMPLE_RATE,
		.pcm_width = 16,
		.block_size = BLOCK_SIZE,
		.mem_slab = &mem_slab,
	};
	struct dmic_cfg cfg = {
		.streams = &stream,
		.channel = {
			.req_num_streams = 1,
			.req_num_chan = 1,
			.req_chan_map_lo =
				dmic_build_channel_map(0, 0, PDM_CHAN_LEFT),
		},
	};

	ret = dmic_configure(dmic_dev, &cfg);
	if (ret < 0) {
		LOG_ERR("configure failed: %d", ret);
		return 0;
	}

	ret = dmic_trigger(dmic_dev, DMIC_TRIGGER_START);
	if (ret < 0) {
		LOG_ERR("START failed: %d", ret);
		return 0;
	}

	printk("Capturing %u Hz mono through the DMIC API.\n", SAMPLE_RATE);
	printk("Enable the microphone in the browser's audio panel and speak.\n");

	while (true) {
		void *buffer;
		size_t size;
		int peak = 0;

		ret = dmic_read(dmic_dev, 0, &buffer, &size, READ_TIMEOUT_MS);
		if (ret < 0) {
			LOG_ERR("read failed: %d", ret);
			k_sleep(K_MSEC(100));
			continue;
		}

		const int16_t *samples = buffer;

		for (size_t i = 0; i < size / sizeof(int16_t); i++) {
			/* Widen before negating: -INT16_MIN overflows int16_t. */
			int mag = samples[i] < 0 ? -(int)samples[i] : samples[i];

			if (mag > peak) {
				peak = mag;
			}
		}
		k_mem_slab_free(&mem_slab, buffer);

		render(peak);
	}

	return 0;
}
