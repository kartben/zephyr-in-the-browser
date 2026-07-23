/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Auxiliary query for the qemu,host-audio I2S device.
 *
 * Everything normal goes through Zephyr's I2S API (drivers/i2s.h) — this
 * header exists only because that API has no way to ask how much room the
 * transmit path has left. The device is a ring the browser drains, and a
 * caller that bounds its writes by the free space never blocks inside
 * i2s_write(); the hostaudio shell commands rely on that to stay safe on the
 * TCI-interpreted Cortex-M3, where blocking on k_sleep stalls (see
 * tools/samples.manifest).
 */

#ifndef ZEPHYR_MODULE_INCLUDE_QEMU_HOST_AUDIO_H_
#define ZEPHYR_MODULE_INCLUDE_QEMU_HOST_AUDIO_H_

#include <stdint.h>

#include <zephyr/device.h>

#ifdef __cplusplus
extern "C" {
#endif

/** int16 samples the device ring can currently accept without blocking. */
uint32_t qemu_host_audio_free_samples(const struct device *dev);

#ifdef __cplusplus
}
#endif

#endif /* ZEPHYR_MODULE_INCLUDE_QEMU_HOST_AUDIO_H_ */
