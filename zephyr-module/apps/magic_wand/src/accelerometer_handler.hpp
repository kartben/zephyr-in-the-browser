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
 */

#ifndef TENSORFLOW_LITE_MICRO_EXAMPLES_MAGIC_WAND_ACCELEROMETER_HANDLER_H_
#define TENSORFLOW_LITE_MICRO_EXAMPLES_MAGIC_WAND_ACCELEROMETER_HANDLER_H_

#define kChannelNumber 3

#include <tensorflow/lite/c/c_api_types.h>
#include <tensorflow/lite/micro/micro_log.h>

#include <stdint.h>

extern TfLiteStatus SetupAccelerometer();
/* Read one sample into the window. Called on every sample tick. */
extern bool SampleAccelerometer();
/* How many samples have been read since boot. */
extern uint32_t SamplesRead();
/* Copy the newest full window into input, oldest first, and set *sample to the
 * count it ends at. False until a whole window has been read.
 */
extern bool CopyLatestWindow(float *input, int length, uint32_t *sample);

#endif /* TENSORFLOW_LITE_MICRO_EXAMPLES_MAGIC_WAND_ACCELEROMETER_HANDLER_H_ */
