/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_CONTROLS_H_
#define KITE_RUSH_CONTROLS_H_

#include <zephyr/device.h>

#include "game.h"

/* The game decides what a press or a tap does, the display scales the touchscreen */
void controls_init(const struct game *g, const struct device *display);
void controls_read(struct controls *ctl);

/* CRSF receiver the radio sticks come from, NULL if none */
const struct device *controls_receiver(void);

#endif /* KITE_RUSH_CONTROLS_H_ */
