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
 * samples/modules/tflite-micro/magic_wand (commit 8f62a4ab82b5): the
 * predictor is told which sample the inference ended at, so it can hold off a
 * repeat by samples rather than by inferences.
 */

#ifndef TENSORFLOW_LITE_MICRO_EXAMPLES_MAGIC_WAND_GESTURE_PREDICTOR_H_
#define TENSORFLOW_LITE_MICRO_EXAMPLES_MAGIC_WAND_GESTURE_PREDICTOR_H_

#include <stdint.h>

/* `sample` is the sample count the inference's window ends at. */
extern int PredictGesture(float *output, uint32_t sample);

#endif /* TENSORFLOW_LITE_MICRO_EXAMPLES_MAGIC_WAND_GESTURE_PREDICTOR_H_ */
