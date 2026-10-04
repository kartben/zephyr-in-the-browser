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
 *   it never ran inference. The caller paces the calls at kTargetHz.
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

int begin_index = 0;
const struct device *const sensor = DEVICE_DT_GET_ONE(adi_adxl345);

float bufx[BUFLEN] = { 0.0f };
float bufy[BUFLEN] = { 0.0f };
float bufz[BUFLEN] = { 0.0f };

static int samples_seen;

TfLiteStatus SetupAccelerometer()
{
	if (!device_is_ready(sensor)) {
		printk("%s: device not ready.\n", sensor->name);
		return kTfLiteApplicationError;
	}

	MicroPrintf("Got accelerometer, name: %s\n", sensor->name);

	return kTfLiteOk;
}

bool ReadAccelerometer(float *input, int length)
{
	struct sensor_value accel[3];
	const int window = length / kChannelNumber;
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

	bufx[begin_index] = (float)(sensor_value_to_double(&accel[0]) * kMilliGPerMs2);
	bufy[begin_index] = (float)(sensor_value_to_double(&accel[1]) * kMilliGPerMs2);
	bufz[begin_index] = (float)(sensor_value_to_double(&accel[2]) * kMilliGPerMs2);
	begin_index++;
	if (begin_index >= BUFLEN) {
		begin_index = 0;
	}

	if (samples_seen < window) {
		samples_seen++;
	}
	if (samples_seen < window) {
		return false;
	}

	for (int sample = 0; sample < window; sample++) {
		int ring_index = begin_index - window + sample;

		if (ring_index < 0) {
			ring_index += BUFLEN;
		}
		input[3 * sample] = bufx[ring_index];
		input[3 * sample + 1] = bufy[ring_index];
		input[3 * sample + 2] = bufz[ring_index];
	}
	return true;
}
