/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_RENDER_H_
#define KITE_RUSH_RENDER_H_

#include <zephyr/device.h>

#include "game.h"

/* Cycles spent per stage since the last call, see CONFIG_KITE_RUSH_PROFILE */
struct render_stats {
	uint32_t scene;
	uint32_t background;
	uint32_t shapes;
	uint32_t output;
	uint32_t wait;
	uint32_t rows_sent;
};

int render_init(const struct device *display);
void render_frame(const struct game *g, const struct controls *ctl);
void render_take_stats(struct render_stats *stats);

#endif /* KITE_RUSH_RENDER_H_ */
