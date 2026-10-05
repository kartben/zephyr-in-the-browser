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
 * - A sampler thread reads one sample per kTargetHz tick of a kernel timer,
 *   whatever inference is doing. loop() runs inference on the newest window,
 *   at most every CONFIG_MAGIC_WAND_INFERENCE_STRIDE samples. Reading in
 *   loop() between inferences, as upstream does, lost a sample per tick
 *   whenever an inference took longer than a tick, so on a slow host a gesture
 *   reached the model squeezed into fewer samples and read as another.
 * - After a few inferences it prints one "Magic Wand ready" line with the time
 *   an inference takes, so a reader (or a smoke test) knows it is listening.
 * - The op resolver also registers RESHAPE, for models retrained with
 *   tools/train-magic-wand.py.
 */

#include "main_functions.hpp"

#include "accelerometer_handler.hpp"
#include "constants.hpp"
#include "gesture_predictor.hpp"
#include "magic_wand_model_data.hpp"
#include "output_handler.hpp"
#include <tensorflow/lite/micro/micro_log.h>
#include <tensorflow/lite/micro/micro_interpreter.h>
#include <tensorflow/lite/micro/micro_mutable_op_resolver.h>
#include <tensorflow/lite/schema/schema_generated.h>

#include <zephyr/kernel.h>

/* Globals, used for compatibility with Arduino-style sketches. */
namespace {
	const tflite::Model *model = nullptr;
	tflite::MicroInterpreter *interpreter = nullptr;
	TfLiteTensor *model_input = nullptr;
	int input_length;

	/* Create an area of memory to use for input, output, and intermediate arrays.
	* The size of this will depend on the model you're using, and may need to be
	* determined by experimentation.
	*/
	constexpr int kTensorArenaSize = 60 * 1024;
	uint8_t tensor_arena[kTensorArenaSize];

	/* Report the inference time once the code has been translated and warm. */
	constexpr int kReadyAfterInferences = 8;
	int inferences;
	/* The sample count the last inference's window ended at. */
	uint32_t inferred_at;
} /* namespace */

K_TIMER_DEFINE(sample_timer, NULL, NULL);
/* Given after each sample; loop() waits on it. */
K_SEM_DEFINE(sample_ready, 0, 1);

/* One sample per tick. Above the main thread (priority 0), so a sample is never
 * late for an inference, and cooperative: a read is short, then it waits for
 * the next tick.
 */
static void sample_loop(void *, void *, void *)
{
	while (true) {
		k_timer_status_sync(&sample_timer);
		if (SampleAccelerometer()) {
			k_sem_give(&sample_ready);
		}
	}
}

K_THREAD_DEFINE(sampler, 4096, sample_loop, NULL, NULL, NULL, -1, 0, SYS_FOREVER_MS);

/* The name of this function is important for Arduino compatibility. */
void setup(void)
{
	/* Map the model into a usable data structure. This doesn't involve any
	 * copying or parsing, it's a very lightweight operation.
	 */
	model = tflite::GetModel(g_magic_wand_model_data);
	if (model->version() != TFLITE_SCHEMA_VERSION) {
		MicroPrintf("Model provided is schema version %d not equal "
				    "to supported version %d.",
				    model->version(), TFLITE_SCHEMA_VERSION);
		return;
	}

	/* Pull in only the operation implementations we need.
	 * This relies on a complete list of all the ops needed by this graph.
	 * An easier approach is to just use the AllOpsResolver, but this will
	 * incur some penalty in code space for op implementations that are not
	 * needed by this graph.
	 */
	static tflite::MicroMutableOpResolver < 6 > micro_op_resolver; /* NOLINT */
	micro_op_resolver.AddConv2D();
	micro_op_resolver.AddDepthwiseConv2D();
	micro_op_resolver.AddFullyConnected();
	micro_op_resolver.AddMaxPool2D();
	/* Today's TFLite converter keeps the Flatten before the dense layer as a
	 * RESHAPE (tools/train-magic-wand.py); the 2019 model folded it away.
	 */
	micro_op_resolver.AddReshape();
	micro_op_resolver.AddSoftmax();

	/* Build an interpreter to run the model with. */
	static tflite::MicroInterpreter static_interpreter(
		model, micro_op_resolver, tensor_arena, kTensorArenaSize);
	interpreter = &static_interpreter;

	/* Allocate memory from the tensor_arena for the model's tensors. */
	interpreter->AllocateTensors();

	/* Obtain pointer to the model's input tensor. */
	model_input = interpreter->input(0);
	if ((model_input->dims->size != 4) || (model_input->dims->data[0] != 1) ||
	    (model_input->dims->data[1] != 128) ||
	    (model_input->dims->data[2] != kChannelNumber) ||
	    (model_input->type != kTfLiteFloat32)) {
		MicroPrintf("Bad input tensor parameters in model");
		return;
	}

	input_length = model_input->bytes / sizeof(float);

	TfLiteStatus setup_status = SetupAccelerometer();
	if (setup_status != kTfLiteOk) {
		MicroPrintf("Set up failed\n");
	}

	const k_timeout_t period = K_MSEC((int32_t)(1000 / kTargetHz));

	k_timer_start(&sample_timer, period, period);
	k_thread_start(sampler);
}

void loop(void)
{
	/* Wait for a new sample. After a slow inference several have landed, and
	 * this one runs on the newest window.
	 */
	k_sem_take(&sample_ready, K_FOREVER);
	if (SamplesRead() - inferred_at < CONFIG_MAGIC_WAND_INFERENCE_STRIDE) {
		return;
	}

	uint32_t sample;

	if (!CopyLatestWindow(model_input->data.f, input_length, &sample)) {
		return;
	}
	inferred_at = sample;

	/* Run inference, and report any error */
	const uint64_t start = k_cycle_get_64();
	TfLiteStatus invoke_status = interpreter->Invoke();
	if (invoke_status != kTfLiteOk) {
		MicroPrintf("Invoke failed at sample %u\n", (unsigned int)sample);
		return;
	}
	if (++inferences == kReadyAfterInferences) {
		printk("Magic Wand ready: inference takes %u ms\n",
		       (unsigned int)k_cyc_to_ms_ceil64(k_cycle_get_64() - start));
	}

	/* Analyze the results to obtain a prediction */
	int gesture_index = PredictGesture(interpreter->output(0)->data.f, sample);

	/* Produce an output */
	HandleOutput(gesture_index);
}
