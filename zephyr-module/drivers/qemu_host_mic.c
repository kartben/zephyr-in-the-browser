/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * DMIC driver for the qemu-host-mic MMIO device.
 *
 * The device models no real PDM microphone: it is a PCM ring the QEMU host
 * fills. Under qemu-wasm the host is a browser capturing getUserMedia audio,
 * so reads here record from the user's actual microphone. Exposing it through
 * Zephyr's DMIC API means samples/drivers/audio/dmic runs unmodified — the
 * PDM-specific parts of the config (clock frequencies, duty cycles, channel
 * maps) are accepted and ignored, since there is no PDM hardware to tune.
 *
 * The device stream is fixed 16 kHz mono s16. Mono and stereo PCM output are
 * both supported; stereo duplicates the mono capture into both channels, the
 * moral equivalent of wiring one microphone to both PDM lines.
 *
 * dmic_read() is paced against real time: each call waits until the next
 * block's worth of capture time has elapsed since START, then fills the block
 * from the ring — and with silence for any samples the host has not supplied,
 * so a page whose user never grants microphone permission still yields a
 * steady stream of zeroed blocks rather than errors. Pacing sleeps in
 * k_sleep(), which is fine on the Cortex-A53 where this ships; on the
 * TCI-interpreted Cortex-M3 sleeping stalls (see tools/samples.manifest), so
 * the mic pairs with that board's shell image only for native-QEMU testing.
 */

#define DT_DRV_COMPAT qemu_host_mic

#include <zephyr/audio/dmic.h>
#include <zephyr/device.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/device_mmio.h>

LOG_MODULE_REGISTER(qemu_host_mic, CONFIG_AUDIO_DMIC_LOG_LEVEL);

#define REG_ID    0x00
#define REG_RATE  0x04
#define REG_BUFSZ 0x08
#define REG_WRIDX 0x0c
#define REG_RDIDX 0x10
#define REG_DATA  0x14

/* "HMIC" */
#define HOST_MIC_MAGIC 0x484d4943U

struct qhm_config {
	DEVICE_MMIO_ROM;
};

struct qhm_data {
	DEVICE_MMIO_RAM;
	uint32_t rate;
	uint32_t buf_samples;
	uint8_t channels;
	size_t block_size;
	struct k_mem_slab *mem_slab;
	bool configured;
	bool running;
	/* Capture epoch: when START happened and what has been read since. */
	int64_t start_ms;
	uint32_t frames_read;
};

static int qhm_configure(const struct device *dev, struct dmic_cfg *cfg)
{
	struct qhm_data *data = dev->data;
	struct pcm_stream_cfg *stream = &cfg->streams[0];

	if (data->running) {
		return -EBUSY;
	}

	if (cfg->channel.req_num_streams != 1 ||
	    cfg->channel.req_num_chan < 1 || cfg->channel.req_num_chan > 2 ||
	    stream->pcm_width != 16 ||
	    stream->pcm_rate != data->rate ||
	    stream->mem_slab == NULL || stream->block_size == 0) {
		LOG_ERR("unsupported config: %u ch, %u-bit, %u Hz",
			cfg->channel.req_num_chan, stream->pcm_width,
			stream->pcm_rate);
		return -EINVAL;
	}

	/* One mono capture feeds every requested channel; report that back. */
	cfg->channel.act_num_streams = 1;
	cfg->channel.act_num_chan = cfg->channel.req_num_chan;
	cfg->channel.act_chan_map_lo = cfg->channel.req_chan_map_lo;
	cfg->channel.act_chan_map_hi = cfg->channel.req_chan_map_hi;

	data->channels = cfg->channel.req_num_chan;
	data->block_size = stream->block_size;
	data->mem_slab = stream->mem_slab;
	data->configured = true;

	return 0;
}

static int qhm_trigger(const struct device *dev, enum dmic_trigger cmd)
{
	struct qhm_data *data = dev->data;
	mm_reg_t base = DEVICE_MMIO_GET(dev);

	switch (cmd) {
	case DMIC_TRIGGER_START:
		if (!data->configured) {
			return -EIO;
		}
		/* Discard whatever the host captured before we were listening. */
		sys_write32(sys_read32(base + REG_WRIDX), base + REG_RDIDX);
		data->start_ms = k_uptime_get();
		data->frames_read = 0;
		data->running = true;
		return 0;
	case DMIC_TRIGGER_STOP:
		data->running = false;
		return 0;
	default:
		return -ENOTSUP;
	}
}

static int qhm_read(const struct device *dev, uint8_t stream, void **buffer,
		    size_t *size, int32_t timeout)
{
	struct qhm_data *data = dev->data;
	mm_reg_t base = DEVICE_MMIO_GET(dev);
	int16_t *out;
	int ret;

	if (stream != 0 || !data->running) {
		return -EIO;
	}

	size_t frames = data->block_size / (data->channels * sizeof(int16_t));

	/*
	 * Pace against wall clock: this block is due once its last sample's
	 * capture time has passed. Without this, silence-filled reads would
	 * return instantly and a capture loop would spin.
	 */
	int64_t due_ms = data->start_ms +
			 ((int64_t)(data->frames_read + frames) * 1000) /
				 data->rate;
	int64_t wait_ms = due_ms - k_uptime_get();

	if (timeout != SYS_FOREVER_MS && wait_ms > timeout) {
		k_sleep(K_MSEC(timeout));
		return -EAGAIN;
	}
	if (wait_ms > 0) {
		k_sleep(K_MSEC(wait_ms));
	}

	ret = k_mem_slab_alloc(data->mem_slab, buffer, K_NO_WAIT);
	if (ret < 0) {
		return -ENOMEM;
	}
	out = *buffer;

	/*
	 * The host may briefly race ahead of the pace clock or lag behind it;
	 * take what it has, cap at one ring's worth, and zero-fill the rest.
	 * Popping REG_DATA advances the device's read index.
	 */
	uint32_t avail = sys_read32(base + REG_WRIDX) -
			 sys_read32(base + REG_RDIDX);

	avail = MIN(avail, data->buf_samples);
	for (size_t i = 0; i < frames; i++) {
		int16_t sample = 0;

		if (i < avail) {
			sample = (int16_t)sys_read32(base + REG_DATA);
		}
		for (uint8_t ch = 0; ch < data->channels; ch++) {
			out[i * data->channels + ch] = sample;
		}
	}

	data->frames_read += frames;
	*size = data->block_size;

	return 0;
}

static DEVICE_API(dmic, qhm_api) = {
	.configure = qhm_configure,
	.trigger = qhm_trigger,
	.read = qhm_read,
};

static int qhm_init(const struct device *dev)
{
	struct qhm_data *data = dev->data;
	mm_reg_t base;
	uint32_t id;

	DEVICE_MMIO_MAP(dev, K_MEM_CACHE_NONE);
	base = DEVICE_MMIO_GET(dev);

	id = sys_read32(base + REG_ID);
	if (id != HOST_MIC_MAGIC) {
		LOG_ERR("bad ID 0x%08x at %p (expected 0x%08x)", id,
			(void *)base, HOST_MIC_MAGIC);
		return -ENODEV;
	}

	data->rate = sys_read32(base + REG_RATE);
	data->buf_samples = sys_read32(base + REG_BUFSZ);

	LOG_INF("host mic at %p, %u Hz mono, %u-sample ring", (void *)base,
		data->rate, data->buf_samples);

	return 0;
}

#define QHM_DEFINE(inst)                                                      \
	static struct qhm_data qhm_data_##inst;                               \
	static const struct qhm_config qhm_config_##inst = {                  \
		DEVICE_MMIO_ROM_INIT(DT_DRV_INST(inst)),                      \
	};                                                                    \
	DEVICE_DT_INST_DEFINE(inst, qhm_init, NULL, &qhm_data_##inst,         \
			      &qhm_config_##inst, POST_KERNEL,                \
			      CONFIG_AUDIO_DMIC_INIT_PRIORITY, &qhm_api);

DT_INST_FOREACH_STATUS_OKAY(QHM_DEFINE)
