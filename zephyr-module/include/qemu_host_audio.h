/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guest-side API of the qemu,host-audio bridge: a one-way PCM stream from the
 * guest into a ring the QEMU host drains (under qemu-wasm, a browser playing
 * it through the Web Audio API).
 *
 * The format is fixed by the device — signed 16-bit mono at the rate
 * qemu_host_audio_sample_rate() reports — so there is nothing to configure.
 * Writes never block: qemu_host_audio_write() accepts at most the ring's free
 * space and reports what it took, which keeps callers viable on boards where
 * sleeping is off the table (see the qemu-wasm TCI note in tools/samples.manifest).
 */

#ifndef ZEPHYR_MODULE_INCLUDE_QEMU_HOST_AUDIO_H_
#define ZEPHYR_MODULE_INCLUDE_QEMU_HOST_AUDIO_H_

#include <stddef.h>
#include <stdint.h>

#include <zephyr/device.h>

#ifdef __cplusplus
extern "C" {
#endif

/** Sample rate of the stream, in Hz. */
uint32_t qemu_host_audio_sample_rate(const struct device *dev);

/** Total capacity of the device ring, in frames (one int16_t each). */
uint32_t qemu_host_audio_buffer_frames(const struct device *dev);

/** Frames the ring can currently accept without dropping. */
uint32_t qemu_host_audio_free_frames(const struct device *dev);

/**
 * Push PCM frames into the ring.
 *
 * Writes min(count, free space) frames and returns how many were taken.
 * Never blocks; a short return means the ring is full and the caller can
 * retry later or drop the rest.
 */
size_t qemu_host_audio_write(const struct device *dev, const int16_t *frames,
			     size_t count);

#ifdef __cplusplus
}
#endif

#endif /* ZEPHYR_MODULE_INCLUDE_QEMU_HOST_AUDIO_H_ */
