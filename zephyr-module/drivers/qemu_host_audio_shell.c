/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * `hostaudio` shell commands for the qemu,host-audio bridge, so the sound
 * panel is demoable from the stock shell sample the way `gpio get`/`gpio set`
 * demo the GPIO bridge:
 *
 *   hostaudio info               device rate, ring size, free space
 *   hostaudio beep [freq] [ms]   a sine tone (defaults: 440 Hz, 300 ms)
 *   hostaudio melody             a short tune
 *
 * Synthesis is integer-only — a 64-entry sine table swept by a 16.16 phase
 * accumulator — because the Cortex-M3 has no FPU and runs interpreted under
 * qemu-wasm. Everything is written to the ring up front and never blocks: the
 * ring holds ~4 s at 16 kHz, so a command queues its whole sound and returns,
 * truncating (with a warning) if the ring cannot take it. That is what keeps
 * these commands safe on the board where blocking on k_sleep stalls.
 */

#include <zephyr/device.h>
#include <zephyr/shell/shell.h>
#include <zephyr/sys/util.h>

#include <qemu_host_audio.h>

#include <stdlib.h>

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

BUILD_ASSERT(ARRAY_SIZE(sine64) == 64);

/* 4 ms at 16 kHz: long enough to kill the click, too short to soften attack. */
#define RAMP_FRAMES 64

static const struct device *qha_dev(void)
{
	return DEVICE_DT_GET_ONE(qemu_host_audio);
}

/*
 * Queue one tone (or, with freq == 0, a rest) of at most `budget` frames.
 * Returns the frames actually written; short means the ring filled up.
 */
static size_t queue_tone(const struct device *dev, uint32_t freq, uint32_t ms,
			 size_t budget)
{
	uint32_t rate = qemu_host_audio_sample_rate(dev);
	size_t total = MIN((size_t)rate * ms / 1000U, budget);
	/* Table index in 16.16: one cycle is 64 entries, i.e. 64 << 16. */
	uint32_t step = (uint32_t)(((uint64_t)freq << 22) / rate);
	uint32_t phase = 0;
	int16_t chunk[128];
	size_t done = 0;

	while (done < total) {
		size_t n = MIN(total - done, ARRAY_SIZE(chunk));

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
			chunk[i] = (int16_t)s;
			phase += step;
		}

		size_t w = qemu_host_audio_write(dev, chunk, n);

		done += w;
		if (w < n) {
			break;
		}
	}

	return done;
}

static int check_ready(const struct shell *sh, const struct device *dev)
{
	if (!device_is_ready(dev)) {
		shell_error(sh, "host audio device not ready");
		return -ENODEV;
	}

	return 0;
}

static int cmd_info(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev = qha_dev();
	int err = check_ready(sh, dev);

	if (err) {
		return err;
	}

	shell_print(sh, "%u Hz mono s16, ring %u frames, %u free",
		    qemu_host_audio_sample_rate(dev),
		    qemu_host_audio_buffer_frames(dev),
		    qemu_host_audio_free_frames(dev));

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
	if (freq < 20 || freq > qemu_host_audio_sample_rate(dev) / 2) {
		shell_error(sh, "frequency out of range (20..%u Hz)",
			    qemu_host_audio_sample_rate(dev) / 2);
		return -EINVAL;
	}
	ms = MIN(ms, 5000);

	size_t want = (size_t)qemu_host_audio_sample_rate(dev) * ms / 1000U;
	size_t done = queue_tone(dev, freq, ms, qemu_host_audio_free_frames(dev));

	if (done < want) {
		shell_warn(sh, "ring full: queued %u of %u frames",
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

	size_t budget = qemu_host_audio_free_frames(dev);
	bool full = false;

	for (size_t i = 0; i < ARRAY_SIZE(notes) && !full; i++) {
		uint32_t rate = qemu_host_audio_sample_rate(dev);
		size_t want = (size_t)rate * notes[i].ms / 1000U;

		full = queue_tone(dev, notes[i].freq, notes[i].ms, budget) < want;
		budget = qemu_host_audio_free_frames(dev);

		/* A hair of silence articulates repeated notes. */
		if (!full && i + 1 < ARRAY_SIZE(notes)) {
			queue_tone(dev, 0, 20, budget);
			budget = qemu_host_audio_free_frames(dev);
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
	SHELL_CMD_ARG(info, NULL, "Device rate, ring size and free space",
		      cmd_info, 1, 0),
	SHELL_CMD_ARG(beep, NULL, "beep [freq_hz] [duration_ms]", cmd_beep, 1, 2),
	SHELL_CMD_ARG(melody, NULL, "Queue a short tune", cmd_melody, 1, 0),
	SHELL_SUBCMD_SET_END);

SHELL_CMD_REGISTER(hostaudio, &sub_hostaudio,
		   "Browser-drained audio out (qemu,host-audio)", NULL);
