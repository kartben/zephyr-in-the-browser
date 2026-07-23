/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * I2S (transmit-only) driver for the qemu-host-audio MMIO device.
 *
 * The device models no real I2S peripheral: it is a PCM ring the QEMU host
 * drains. Under qemu-wasm the host is a browser, so samples written here come
 * out of the user's speakers via the Web Audio API. Exposing it through
 * Zephyr's I2S API means applications written against i2s_configure() /
 * i2s_write() / i2s_trigger() drive the browser's speakers unmodified.
 *
 * The pretence has limits, all on the timing side. The host consumes the ring
 * continuously, so transmission effectively starts as soon as samples are
 * queued rather than strictly on the START trigger, and DRAIN returns once
 * everything is queued rather than once the last sample has sounded. The
 * state machine is still tracked so API misuse fails the way it would on real
 * hardware.
 *
 * i2s_write() copies the block straight into the device ring and frees it —
 * no interrupt exists to complete queued blocks asynchronously. When the ring
 * lacks space the call polls in k_sleep() ticks up to the configured timeout;
 * with the ring holding seconds of audio, well-behaved callers (like the
 * hostaudio shell commands, which bound their writes by the free space) never
 * block at all. That matters on the TCI-interpreted Cortex-M3, where blocking
 * on k_sleep stalls (see tools/samples.manifest).
 *
 * Flow control uses two free-running sample counters: WRIDX advances as this
 * driver pushes through the DATA register, RDIDX as the host consumes. Each
 * counter has a single writer and a 32-bit MMIO access is atomic, so both
 * sides agree without any handshake.
 */

#define DT_DRV_COMPAT qemu_host_audio

#include <zephyr/device.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/device_mmio.h>

#include <qemu_host_audio.h>

LOG_MODULE_REGISTER(qemu_host_audio, CONFIG_I2S_LOG_LEVEL);

#define REG_ID       0x00
#define REG_RATE     0x04
#define REG_BUFSZ    0x08
#define REG_WRIDX    0x0c
#define REG_RDIDX    0x10
#define REG_DATA     0x14
#define REG_CHANNELS 0x18

/* "HAUD" */
#define HOST_AUDIO_MAGIC 0x48415544U

/* Bounds the device clamps to; configs outside these are rejected here. */
#define HOST_AUDIO_MIN_RATE 8000
#define HOST_AUDIO_MAX_RATE 48000

/* Unlike the GPIO driver, nothing here claims offset 0 of config or data, so
 * the DEVICE_MMIO helpers work — and they must be used: the Cortex-A53 runs
 * with the MMU on, where the register window needs a device mapping.
 */
struct qha_config {
	DEVICE_MMIO_ROM;
};

struct qha_data {
	DEVICE_MMIO_RAM;
	enum i2s_state state;
	struct i2s_config cfg;
	uint32_t buf_samples;
};

static uint32_t qha_free_samples(mm_reg_t base, uint32_t buf_samples)
{
	uint32_t used = sys_read32(base + REG_WRIDX) -
			sys_read32(base + REG_RDIDX);

	/* A host that skipped ahead can make used > capacity momentarily. */
	return used > buf_samples ? 0 : buf_samples - used;
}

uint32_t qemu_host_audio_free_samples(const struct device *dev)
{
	struct qha_data *data = dev->data;

	return qha_free_samples(DEVICE_MMIO_GET(dev), data->buf_samples);
}

static int qha_configure(const struct device *dev, enum i2s_dir dir,
			 const struct i2s_config *i2s_cfg)
{
	struct qha_data *data = dev->data;

	if (dir != I2S_DIR_TX) {
		/* Capture is the qemu,host-mic DMIC device, not this one. */
		return -ENOSYS;
	}

	if (data->state == I2S_STATE_RUNNING) {
		return -EBUSY;
	}

	/* Zero frame_clk_freq means "free all resources": nothing held here. */
	if (i2s_cfg->frame_clk_freq == 0) {
		data->state = I2S_STATE_NOT_READY;
		return 0;
	}

	if (i2s_cfg->word_size != 16 ||
	    i2s_cfg->channels < 1 || i2s_cfg->channels > 2 ||
	    i2s_cfg->frame_clk_freq < HOST_AUDIO_MIN_RATE ||
	    i2s_cfg->frame_clk_freq > HOST_AUDIO_MAX_RATE ||
	    i2s_cfg->mem_slab == NULL || i2s_cfg->block_size == 0) {
		LOG_ERR("unsupported config: %u-bit, %u ch, %u Hz",
			i2s_cfg->word_size, i2s_cfg->channels,
			i2s_cfg->frame_clk_freq);
		return -EINVAL;
	}

	sys_write32(i2s_cfg->frame_clk_freq, DEVICE_MMIO_GET(dev) + REG_RATE);
	sys_write32(i2s_cfg->channels, DEVICE_MMIO_GET(dev) + REG_CHANNELS);

	data->cfg = *i2s_cfg;
	data->state = I2S_STATE_READY;

	return 0;
}

static const struct i2s_config *qha_config_get(const struct device *dev,
					       enum i2s_dir dir)
{
	struct qha_data *data = dev->data;

	if (dir != I2S_DIR_TX || data->state == I2S_STATE_NOT_READY) {
		return NULL;
	}

	return &data->cfg;
}

static int qha_read(const struct device *dev, void **mem_block, size_t *size)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(mem_block);
	ARG_UNUSED(size);

	return -ENOSYS;
}

static int qha_write(const struct device *dev, void *mem_block, size_t size)
{
	struct qha_data *data = dev->data;
	mm_reg_t base = DEVICE_MMIO_GET(dev);
	const int16_t *samples = mem_block;
	size_t count = size / sizeof(int16_t);
	int32_t waited_ms = 0;

	if (data->state != I2S_STATE_READY &&
	    data->state != I2S_STATE_RUNNING) {
		return -EIO;
	}
	if (size > data->cfg.block_size) {
		return -EINVAL;
	}

	while (qha_free_samples(base, data->buf_samples) < count) {
		if (data->cfg.timeout != SYS_FOREVER_MS &&
		    waited_ms >= data->cfg.timeout) {
			return -EAGAIN;
		}
		/*
		 * No completion interrupt to wait on — the consumer is the
		 * browser. One-millisecond polls cost nothing at ring scale.
		 */
		k_sleep(K_MSEC(1));
		waited_ms++;
	}

	for (size_t i = 0; i < count; i++) {
		sys_write32((uint16_t)samples[i], base + REG_DATA);
	}

	k_mem_slab_free(data->cfg.mem_slab, mem_block);

	return 0;
}

static int qha_trigger(const struct device *dev, enum i2s_dir dir,
		       enum i2s_trigger_cmd cmd)
{
	struct qha_data *data = dev->data;

	if (dir != I2S_DIR_TX) {
		return -ENOSYS;
	}

	switch (cmd) {
	case I2S_TRIGGER_START:
		if (data->state != I2S_STATE_READY) {
			return -EIO;
		}
		data->state = I2S_STATE_RUNNING;
		return 0;
	case I2S_TRIGGER_STOP:
	case I2S_TRIGGER_DRAIN:
		/*
		 * Everything written is already queued in the device ring and
		 * the host drains it regardless, so both degenerate to
		 * "stop accepting writes until the next START".
		 */
		if (data->state != I2S_STATE_RUNNING) {
			return -EIO;
		}
		data->state = I2S_STATE_READY;
		return 0;
	case I2S_TRIGGER_DROP:
		/* Queued samples cannot be recalled from the host's ring. */
		if (data->state == I2S_STATE_NOT_READY) {
			return -EIO;
		}
		data->state = I2S_STATE_READY;
		return 0;
	case I2S_TRIGGER_PREPARE:
		if (data->state != I2S_STATE_ERROR) {
			return -EIO;
		}
		data->state = I2S_STATE_READY;
		return 0;
	default:
		return -EINVAL;
	}
}

static DEVICE_API(i2s, qha_api) = {
	.configure = qha_configure,
	.config_get = qha_config_get,
	.read = qha_read,
	.write = qha_write,
	.trigger = qha_trigger,
};

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

	data->buf_samples = sys_read32(base + REG_BUFSZ);
	data->state = I2S_STATE_NOT_READY;

	LOG_INF("host audio at %p, %u-sample ring", (void *)base,
		data->buf_samples);

	return 0;
}

#define QHA_DEFINE(inst)                                                      \
	static struct qha_data qha_data_##inst;                               \
	static const struct qha_config qha_config_##inst = {                  \
		DEVICE_MMIO_ROM_INIT(DT_DRV_INST(inst)),                      \
	};                                                                    \
	DEVICE_DT_INST_DEFINE(inst, qha_init, NULL, &qha_data_##inst,         \
			      &qha_config_##inst, POST_KERNEL,                \
			      CONFIG_I2S_INIT_PRIORITY, &qha_api);

DT_INST_FOREACH_STATUS_OKAY(QHA_DEFINE)
