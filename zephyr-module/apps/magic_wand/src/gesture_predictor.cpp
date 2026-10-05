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
 * samples/modules/tflite-micro/magic_wand (commit 8f62a4ab82b5): time is
 * counted in samples, not inferences. Inference keeps pace with the sampler on
 * a fast host and falls behind on a slow one, and counted in inferences both
 * the average and the hold-off stretched with it: averaging five inferences
 * four samples apart smeared a ring across 800 ms and missed it.
 * - The average is of the predictions from the last kPredictionHistoryLength
 *   samples: five inferences at full speed, as upstream, fewer on a slow host.
 * - A detection holds off the next for kPredictionSuppressionSamples samples.
 */

#include "gesture_predictor.hpp"

#include "constants.hpp"

namespace {
	/* State for the averaging algorithm we're using: the latest predictions,
	 * and the sample each one's window ended at.
	 */
	float prediction_history[kGestureCount][kPredictionHistoryLength] = {};
	uint32_t prediction_samples[kPredictionHistoryLength] = {};
	int prediction_count = 0;
	int prediction_history_index = 0;
	/* No detection before this sample count. */
	uint32_t suppressed_until = 0;
} /* namespace */

/* Return the result of the last prediction
 * 0: wing("W"), 1: ring("O"), 2: slope("angle"), 3: unknown
 */
int PredictGesture(float *output, uint32_t sample)
{
	/* Record the latest predictions in our rolling history buffer. */
	for (int i = 0; i < kGestureCount; ++i) {
		prediction_history[i][prediction_history_index] = output[i];
	}
	prediction_samples[prediction_history_index] = sample;
	if (prediction_count < kPredictionHistoryLength) {
		++prediction_count;
	}
	/* Figure out which slot to put the next predictions into. */
	++prediction_history_index;
	if (prediction_history_index >= kPredictionHistoryLength) {
		prediction_history_index = 0;
	}

	/* Average the predictions of the last kPredictionHistoryLength samples for
	 * each gesture, and find which has the highest score. This one is always
	 * among them.
	 */
	int recent = 0;
	float prediction_sums[kGestureCount] = {};
	for (int j = 0; j < prediction_count; ++j) {
		if (sample - prediction_samples[j] >= (uint32_t)kPredictionHistoryLength) {
			continue;
		}
		for (int i = 0; i < kGestureCount; ++i) {
			prediction_sums[i] += prediction_history[i][j];
		}
		++recent;
	}
	int max_predict_index = -1;
	float max_predict_score = 0.0f;
	for (int i = 0; i < kGestureCount; i++) {
		const float prediction_average = prediction_sums[i] / recent;
		if ((max_predict_index == -1) || (prediction_average > max_predict_score)) {
			max_predict_index = i;
			max_predict_score = prediction_average;
		}
	}

	/* If we're predicting no gesture, or the average score is too low, or there's
	 * been a gesture recognised too recently, return no gesture. The difference
	 * is signed so a wrapped sample count still compares right.
	 */
	if ((max_predict_index == kNoGesture) ||
	    (max_predict_score < kDetectionThreshold) ||
	    ((int32_t)(sample - suppressed_until) < 0)) {
		return kNoGesture;
	}
	/* Hold off the next detection so we don't report this gesture again. */
	suppressed_until = sample + kPredictionSuppressionSamples;
	return max_predict_index;
}
