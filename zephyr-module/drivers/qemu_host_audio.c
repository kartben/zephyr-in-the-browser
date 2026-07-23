/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Driver for the qemu-host-audio MMIO device.
 *
 * The device models no real hardware: it is a PCM ring the QEMU host drains.
 * Under qemu-wasm the host is a browser, so samples pushed here come out of
 * the user's speakers via the Web Audio API.
 *
 * Flow control uses two free-running frame counters. WRIDX advances as this
 * driver pushes samples through the DATA register; RDIDX advances as the host
 * consumes them. Free space is capacity minus their difference, so both sides
 * agree without any handshake — each counter has a single writer and a 32-bit
 * MMIO access is atomic.
 *
 * Writes never block. qemu_host_audio_write() takes at most the free space and
 * reports what it took, which is what lets the shell commands run on the
 * TCI-interpreted Cortex-M3, where blocking on k_sleep stalls (see
 * tools/samples.manifest).
 */

#define DT_DRV_COMPAT qemu_host_audio

#include <zephyr/device.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/device_mmio.h>

#include <qemu_host_audio.h>

LOG_MODULE_REGISTER(qemu_host_audio, CONFIG_LOG_DEFAULT_LEVEL);

#define REG_ID     0x00
#define REG_RATE   0x04
#define REG_FRAMES 0x08
#define REG_WRIDX  0x0c
#define REG_RDIDX  0x10
#define REG_DATA   0x14

/* "HAUD" */
#define HOST_AUDIO_MAGIC 0x48415544U

struct qha_config {
	DEVICE_MMIO_ROM;
};

struct qha_data {
	DEVICE_MMIO_RAM;
	uint32_t rate;
	uint32_t frames;
};

uint32_t qemu_host_audio_sample_rate(const struct device *dev)
{
	struct qha_data *data = dev->data;

	return data->rate;
}

uint32_t qemu_host_audio_buffer_frames(const struct device *dev)
{
	struct qha_data *data = dev->data;

	return data->frames;
}

uint32_t qemu_host_audio_free_frames(const struct device *dev)
{
	struct qha_data *data = dev->data;
	mm_reg_t base = DEVICE_MMIO_GET(dev);
	uint32_t used = sys_read32(base + REG_WRIDX) -
			sys_read32(base + REG_RDIDX);

	/* A host that skipped ahead can make used > frames momentarily. */
	return used > data->frames ? 0 : data->frames - used;
}

size_t qemu_host_audio_write(const struct device *dev, const int16_t *frames,
			     size_t count)
{
	mm_reg_t base = DEVICE_MMIO_GET(dev);
	size_t n = MIN(count, (size_t)qemu_host_audio_free_frames(dev));

	for (size_t i = 0; i < n; i++) {
		sys_write32((uint16_t)frames[i], base + REG_DATA);
	}

	return n;
}

static int qha_init(const struct device *dev)
{
	struct qha_data *data = dev->data;
	mm_reg_t base;
	uint32_t id;

	DEVICE_MMIO_MAP(dev, K_MEM_CACHE_NONE);
	base = DEVICE_MMIO_GET(dev);

	id = sys_read32(base + REG_ID);
	if (id != HOST_AUDIO_MAGIC) {
		LOG_ERR("bad ID 0x%08x at %p (expected 0x%08x)", id,
			(void *)base, HOST_AUDIO_MAGIC);
		return -ENODEV;
	}

	data->rate = sys_read32(base + REG_RATE);
	data->frames = sys_read32(base + REG_FRAMES);

	LOG_INF("host audio at %p, %u Hz mono, %u-frame ring", (void *)base,
		data->rate, data->frames);

	return 0;
}

#define QHA_DEFINE(inst)                                                      \
	static struct qha_data qha_data_##inst;                               \
	static const struct qha_config qha_config_##inst = {                  \
		DEVICE_MMIO_ROM_INIT(DT_DRV_INST(inst)),                      \
	};                                                                    \
	DEVICE_DT_INST_DEFINE(inst, qha_init, NULL, &qha_data_##inst,         \
			      &qha_config_##inst, POST_KERNEL,                \
			      CONFIG_KERNEL_INIT_PRIORITY_DEVICE, NULL);

DT_INST_FOREACH_STATUS_OKAY(QHA_DEFINE)
