/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/util.h>

#include "controls.h"
#include "game.h"
#include "render.h"
#include "storage.h"
#include "telemetry.h"

LOG_MODULE_REGISTER(kite_rush, LOG_LEVEL_INF);

#define FRAME_MS (1000 / CONFIG_KITE_RUSH_TARGET_FPS)

static struct game game;

int main(void)
{
	const struct device *display = DEVICE_DT_GET(DT_CHOSEN(zephyr_display));
	const struct device *receiver = controls_receiver();
	struct high_score scores[GAME_HIGH_SCORES];
	struct controls ctl;
	int64_t last, fps_start, deadline;
	uint32_t frames = 0;
	uint32_t logic = 0;
	int ret;

	if (!device_is_ready(display)) {
		LOG_ERR("Display %s not ready", display->name);
		return 0;
	}

	ret = render_init(display);
	if (ret < 0) {
		return 0;
	}

	if (receiver != NULL && !device_is_ready(receiver)) {
		LOG_WRN("CRSF receiver not ready, telemetry disabled");
		telemetry_init(NULL);
	} else {
		telemetry_init(receiver);
	}

	game_init(&game, k_cycle_get_32());
	if (storage_load_scores(scores, ARRAY_SIZE(scores)) == 0) {
		game_set_scores(&game, scores, ARRAY_SIZE(scores));
	}
	controls_init(&game, display);
	LOG_INF("Kite Rush ready, push the throttle up to fly");

	last = k_uptime_get();
	fps_start = last;
	deadline = last;

	while (true) {
		int64_t now = k_uptime_get();
		uint32_t t0;
		float dt = CLAMP((float)(now - last) / 1000.0f, 0.001f, 0.05f);

		last = now;
		controls_read(&ctl);
		t0 = k_cycle_get_32();
		game_update(&game, &ctl, dt);
		logic += k_cycle_get_32() - t0;
		render_frame(&game, &ctl);
		telemetry_update(&game, now);

		frames++;
		if (now - fps_start >= 10000) {
			uint32_t fps = frames * 1000U / (uint32_t)(now - fps_start);

			LOG_INF("%u fps, phase %d, score %u", fps, game.phase, game.score);
			if (IS_ENABLED(CONFIG_KITE_RUSH_PROFILE)) {
				struct render_stats rs;

				render_take_stats(&rs);
				LOG_INF("us per frame: logic %u scene %u background %u shapes %u "
					"output %u wait %u, rows sent %u",
					k_cyc_to_us_floor32(logic / frames),
					k_cyc_to_us_floor32(rs.scene / frames),
					k_cyc_to_us_floor32(rs.background / frames),
					k_cyc_to_us_floor32(rs.shapes / frames),
					k_cyc_to_us_floor32(rs.output / frames),
					k_cyc_to_us_floor32(rs.wait / frames),
					rs.rows_sent / frames);
			}
			logic = 0;
			frames = 0;
			fps_start = now;
		}

		/*
		 * Absolute deadlines keep the pace exact. A late frame resyncs and
		 * still sleeps, so lower priority threads are never starved.
		 */
		deadline += FRAME_MS;
		if (deadline <= k_uptime_get()) {
			deadline = k_uptime_get() + 1;
		}
		k_sleep(K_TIMEOUT_ABS_MS(deadline));
	}

	return 0;
}
