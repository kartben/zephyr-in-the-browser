/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_TELEMETRY_H_
#define KITE_RUSH_TELEMETRY_H_

#include <stdint.h>

#include <zephyr/device.h>

#include "game.h"

/* crsf may be NULL, telemetry is then dropped */
void telemetry_init(const struct device *crsf);
void telemetry_update(const struct game *g, int64_t now_ms);

#endif /* KITE_RUSH_TELEMETRY_H_ */
