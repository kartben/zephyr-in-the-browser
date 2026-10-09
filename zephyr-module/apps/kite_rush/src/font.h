/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_FONT_H_
#define KITE_RUSH_FONT_H_

#include <stdint.h>

#define FONT_WIDTH  5
#define FONT_HEIGHT 7

/* Returns FONT_HEIGHT rows, bit 4 is the leftmost column */
const uint8_t *font_glyph(char c);

#endif /* KITE_RUSH_FONT_H_ */
