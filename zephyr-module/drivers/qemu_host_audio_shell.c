/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * `hostaudio` shell commands for the qemu,host-audio bridge, so the sound
 * panel is demoable from the stock shell sample the way `gpio get`/`gpio set`
 * demo the GPIO bridge:
 *
 *   hostaudio info               device state, rate and free space
 *   hostaudio beep [freq] [ms]   a sine tone (defaults: 440 Hz, 300 ms)
 *   hostaudio melody             a short tune
 *
 * Everything goes through Zephyr's I2S API — configure, trigger, write — so
 * these commands double as a live exercise of the driver an application would
 * use. Synthesis is integer-only (a 64-entry sine table swept by a 16.16
 * phase accumulator) because the Cortex-M3 has no FPU and runs interpreted
 * under qemu-wasm.
 *
 * Writes are bounded by qemu_host_audio_free_samples() before they start, so
 * i2s_write() never has to block: the ring holds ~4 s at 16 kHz, a command
 * queues its whole sound and returns, truncating (with a warning) if the ring
 * cannot take it. That is what keeps these commands safe on the board where
 * blocking on k_sleep stalls.
 */

#include <zephyr/device.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/util.h>

#include <qemu_host_audio.h>

#include <stdlib.h>

#define TONE_RATE 16000
#define BLOCK_SAMPLES 256
#define BLOCK_COUNT 4

K_MEM_SLAB_DEFINE_STATIC(qha_shell_slab, BLOCK_SAMPLES * sizeof(int16_t),
			 BLOCK_COUNT, 4);

/* One full sine cycle, amplitude 12000 of 32767 — loud but nowhere near clip. */
static const int16_t sine64[64] = {
	0,      1176,   2341,   3483,   4592,   5657,   6667,   7613,
	8485,   9276,   9978,   10583,  11087,  11483,  11769,  11942,
	12000,  11942,  11769,  11483,  11087,  10583,  9978,   9276,
	8485,   7613,   6667,   5657,   4592,   3483,   2341,   1176,
	0,      -1176,  -2341,  -3483,  -4592,  -5657,  -6667,  -7613,
	-8485,  -9276,  -9978,  -10583, -11087, -11483, -11769, -11942,
	-12000, -11942, -11769, -11483, -11087, -10583, -9978,  -9276,
	-8485,  -7613,  -6667,  -5657,  -4592,  -3483,  -2341,  -1176,
};

/* 4 ms at 16 kHz: long enough to kill the click, too short to soften attack. */
#define RAMP_FRAMES 64

static bool qha_shell_started;

static const struct device *qha_dev(void)
{
	return DEVICE_DT_GET_ONE(qemu_host_audio);
}

/* Configure 16 kHz mono s16 over the I2S API and start the stream once. */
static int ensure_started(const struct shell *sh, const struct device *dev)
{
	struct i2s_config cfg = {
		.word_size = 16,
		.channels = 1,
		.format = I2S_FMT_DATA_FORMAT_I2S,
		.options = I2S_OPT_FRAME_CLK_MASTER | I2S_OPT_BIT_CLK_MASTER,
		.frame_clk_freq = TONE_RATE,
		.mem_slab = &qha_shell_slab,
		.block_size = BLOCK_SAMPLES * sizeof(int16_t),
		/* Writes are pre-bounded by free space; never wait inside. */
		.timeout = 0,
	};
	int err;

	if (qha_shell_started) {
		return 0;
	}

	err = i2s_configure(dev, I2S_DIR_TX, &cfg);
	if (err == 0) {
		err = i2s_trigger(dev, I2S_DIR_TX, I2S_TRIGGER_START);
	}
	if (err) {
		shell_error(sh, "i2s setup failed: %d", err);
		return err;
	}

	qha_shell_started = true;

	return 0;
}

/*
 * Queue one tone (or, with freq == 0, a rest) of at most `budget` samples.
 * Returns the samples actually queued; short means the ring filled up.
 */
static size_t queue_tone(const struct device *dev, uint32_t freq, uint32_t ms,
			 size_t budget)
{
	size_t total = MIN((size_t)TONE_RATE * ms / 1000U, budget);
	/* Table index in 16.16: one cycle is 64 entries, i.e. 64 << 16. */
	uint32_t step = (uint32_t)(((uint64_t)freq << 22) / TONE_RATE);
	uint32_t phase = 0;
	size_t done = 0;

	while (done < total) {
		size_t n = MIN(total - done, (size_t)BLOCK_SAMPLES);
		int16_t *block;

		if (k_mem_slab_alloc(&qha_shell_slab, (void **)&block,
				     K_NO_WAIT) != 0) {
			/* Impossible: i2s_write frees before returning. */
			break;
		}

		for (size_t i = 0; i < n; i++) {
			int32_t s = freq ? sine64[(phase >> 16) & 63] : 0;
			size_t pos = done + i;
			size_t left = total - pos;

			if (pos < RAMP_FRAMES) {
				s = s * (int32_t)pos / RAMP_FRAMES;
			}
			if (left < RAMP_FRAMES) {
				s = s * (int32_t)left / RAMP_FRAMES;
			}
			block[i] = (int16_t)s;
			phase += step;
		}

		if (i2s_write(dev, block, n * sizeof(int16_t)) != 0) {
			k_mem_slab_free(&qha_shell_slab, block);
			break;
		}
		done += n;
	}

	return done;
}

static int check_ready(const struct shell *sh, const struct device *dev)
{
	if (!device_is_ready(dev)) {
		shell_error(sh, "host audio device not ready");
		return -ENODEV;
	}

	return ensure_started(sh, dev);
}

static int cmd_info(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev = qha_dev();
	int err = check_ready(sh, dev);

	if (err) {
		return err;
	}

	const struct i2s_config *cfg = i2s_config_get(dev, I2S_DIR_TX);

	shell_print(sh, "%u Hz, %u ch, s16 over i2s; %u samples free",
		    cfg->frame_clk_freq, cfg->channels,
		    qemu_host_audio_free_samples(dev));

	return 0;
}

static int cmd_beep(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev = qha_dev();
	uint32_t freq = 440;
	uint32_t ms = 300;
	int err = check_ready(sh, dev);

	if (err) {
		return err;
	}

	if (argc > 1) {
		freq = strtoul(argv[1], NULL, 10);
	}
	if (argc > 2) {
		ms = strtoul(argv[2], NULL, 10);
	}
	if (freq < 20 || freq > TONE_RATE / 2) {
		shell_error(sh, "frequency out of range (20..%u Hz)",
			    TONE_RATE / 2);
		return -EINVAL;
	}
	ms = MIN(ms, 5000);

	size_t want = (size_t)TONE_RATE * ms / 1000U;
	size_t done = queue_tone(dev, freq, ms,
				 qemu_host_audio_free_samples(dev));

	if (done < want) {
		shell_warn(sh, "ring full: queued %u of %u samples",
			   (unsigned int)done, (unsigned int)want);
	} else {
		shell_print(sh, "queued %u Hz for %u ms", freq, ms);
	}

	return 0;
}

static int cmd_melody(const struct shell *sh, size_t argc, char **argv)
{
	static const struct {
		uint16_t freq;
		uint16_t ms;
	} notes[] = {
		/* Ode to Joy, first phrase. C4 262, D4 294, E4 330, F4 349, G4 392. */
		{ 330, 180 }, { 330, 180 }, { 349, 180 }, { 392, 180 },
		{ 392, 180 }, { 349, 180 }, { 330, 180 }, { 294, 180 },
		{ 262, 180 }, { 262, 180 }, { 294, 180 }, { 330, 180 },
		{ 330, 270 }, { 294, 90 },  { 294, 360 },
	};
	const struct device *dev = qha_dev();
	int err = check_ready(sh, dev);

	if (err) {
		return err;
	}

	size_t budget = qemu_host_audio_free_samples(dev);
	bool full = false;

	for (size_t i = 0; i < ARRAY_SIZE(notes) && !full; i++) {
		size_t want = (size_t)TONE_RATE * notes[i].ms / 1000U;

		full = queue_tone(dev, notes[i].freq, notes[i].ms, budget) < want;
		budget = qemu_host_audio_free_samples(dev);

		/* A hair of silence articulates repeated notes. */
		if (!full && i + 1 < ARRAY_SIZE(notes)) {
			queue_tone(dev, 0, 20, budget);
			budget = qemu_host_audio_free_samples(dev);
		}
	}

	if (full) {
		shell_warn(sh, "ring full: melody truncated");
	} else {
		shell_print(sh, "melody queued");
	}

	return 0;
}

SHELL_STATIC_SUBCMD_SET_CREATE(
	sub_hostaudio,
	SHELL_CMD_ARG(info, NULL, "Device state, rate and free space",
		      cmd_info, 1, 0),
	SHELL_CMD_ARG(beep, NULL, "beep [freq_hz] [duration_ms]", cmd_beep, 1, 2),
	SHELL_CMD_ARG(melody, NULL, "Queue a short tune", cmd_melody, 1, 0),
	SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(hostaudio, &sub_hostaudio,
		   "Browser-drained audio out (qemu,host-audio over i2s)", NULL);
