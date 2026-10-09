/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_KITE_H_
#define KITE_RUSH_KITE_H_

#include <stdint.h>

/* Width of the kite body in logo units */
#define KITE_BODY_WIDTH 121.5f

struct kite_pose {
	float x, y;    /* screen position of the body centre */
	float scale;   /* pixels per logo unit */
	float angle;   /* rotation in radians, positive is clockwise */
	float time;    /* drives the tail flutter */
	float swing;   /* -1..1, tail trails opposite to lateral motion */
	float flutter; /* tail wave amplitude in logo units */
	uint32_t tint;
	uint8_t tint_amount;
};

/* Queues the Zephyr kite, built from the logo geometry */
void kite_draw(const struct kite_pose *pose);

#endif /* KITE_RUSH_KITE_H_ */
