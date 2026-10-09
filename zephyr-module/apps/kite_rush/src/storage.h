/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_STORAGE_H_
#define KITE_RUSH_STORAGE_H_

#include <stddef.h>

#include "game.h"

/* Reads the high score table back, returns -ENOENT if none was saved */
int storage_load_scores(struct high_score *scores, size_t count);

#endif /* KITE_RUSH_STORAGE_H_ */
