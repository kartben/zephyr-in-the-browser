/*
 * Copyright 2019 The TensorFlow Authors. All Rights Reserved.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified for zephyr-in-the-browser from Zephyr's
 * samples/modules/tflite-micro/magic_wand (commit 8f62a4ab82b5):
 * - One sample per call. The adi,adxl345 driver reads one sample per
 *   sensor_sample_fetch() and returns 0, which upstream took for "no data", so
 *   it never ran inference. A sampler thread paces the calls at kTargetHz.
 * - Sampling and inference are apart: the sampler writes the ring, inference
 *   copies the newest window out of it, under a spinlock.
 * - Samples reach the model in milli-g, the unit it was trained on. Fed the
 *   driver's m/s², it never reports a gesture.
 * - Inference waits for a full window, and the window carries all 128
 *   samples, newest last. Upstream left the last slot unwritten.
 * tools/extract-magic-wand-gestures.py replays recorded gestures through a
 * Python copy of this loop; keep the two in step.
 */

#include "accelerometer_handler.hpp"

#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/kernel.h>

#define BUFLEN 300

/* m/s² to milli-g. SENSOR_G is standard gravity in micro-m/s². */
static constexpr double kMilliGPerMs2 = 1000.0 * 1000000.0 / SENSOR_G;

static const struct device *const sensor = DEVICE_DT_GET_ONE(adi_adxl345);

static float bufx[BUFLEN];
static float bufy[BUFLEN];
static float bufz[BUFLEN];
static int begin_index;
static uint32_t samples_read;
static struct k_spinlock ring_lock;

TfLiteStatus SetupAccelerometer()
{
	if (!device_is_ready(sensor)) {
		printk("%s: device not ready.\n", sensor->name);
		return kTfLiteApplicationError;
	}

	MicroPrintf("Got accelerometer, name: %s\n", sensor->name);

	return kTfLiteOk;
}

bool SampleAccelerometer()
{
	struct sensor_value accel[3];
	int rc;

	rc = sensor_sample_fetch(sensor);
	if (rc < 0) {
		MicroPrintf("Fetch failed: %d\n", rc);
		return false;
	}

	rc = sensor_channel_get(sensor, SENSOR_CHAN_ACCEL_XYZ, accel);
	if (rc < 0) {
		MicroPrintf("ERROR: Update failed: %d\n", rc);
		return false;
	}

	const float x = (float)(sensor_value_to_double(&accel[0]) * kMilliGPerMs2);
	const float y = (float)(sensor_value_to_double(&accel[1]) * kMilliGPerMs2);
	const float z = (float)(sensor_value_to_double(&accel[2]) * kMilliGPerMs2);

	k_spinlock_key_t key = k_spin_lock(&ring_lock);
	bufx[begin_index] = x;
	bufy[begin_index] = y;
	bufz[begin_index] = z;
	begin_index++;
	if (begin_index >= BUFLEN) {
		begin_index = 0;
	}
	samples_read++;
	k_spin_unlock(&ring_lock, key);
	return true;
}

uint32_t SamplesRead()
{
	k_spinlock_key_t key = k_spin_lock(&ring_lock);
	const uint32_t count = samples_read;

	k_spin_unlock(&ring_lock, key);
	return count;
}

bool CopyLatestWindow(float *input, int length, uint32_t *sample)
{
	const int window = length / kChannelNumber;
	k_spinlock_key_t key = k_spin_lock(&ring_lock);

	if (samples_read < (uint32_t)window) {
		k_spin_unlock(&ring_lock, key);
		return false;
	}
	for (int i = 0; i < window; i++) {
		int ring_index = begin_index - window + i;

		if (ring_index < 0) {
			ring_index += BUFLEN;
		}
		input[3 * i] = bufx[ring_index];
		input[3 * i + 1] = bufy[ring_index];
		input[3 * i + 2] = bufz[ring_index];
	}
	*sample = samples_read;
	k_spin_unlock(&ring_lock, key);
	return true;
}
