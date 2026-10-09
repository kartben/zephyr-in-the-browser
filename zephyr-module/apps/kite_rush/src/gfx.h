/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_GFX_H_
#define KITE_RUSH_GFX_H_

#include <stdint.h>

/*
 * Scanline rasterizer: primitives are queued in a display list, then drawn
 * one logical row at a time, so no frame buffer is needed. Colors are
 * 0x00RRGGBB.
 */

enum gfx_blend {
	GFX_SOLID,
	GFX_ALPHA,
	GFX_ADD,
};

struct gfx_sprite {
	uint8_t w;
	uint8_t h;
	uint8_t frames;
	const uint8_t *pixels;   /* w * h * frames palette indices, 0 is transparent */
	const uint32_t *palette;
};

void gfx_begin(int width, int height);
/* Call once all primitives of the frame are queued, before drawing rows */
void gfx_end(void);
void gfx_draw_row(uint32_t *row, int y);

void gfx_rect(float x0, float y0, float x1, float y1, uint32_t color, enum gfx_blend blend,
	      uint8_t alpha);
void gfx_tri(const float v[6], uint32_t color, enum gfx_blend blend, uint8_t alpha);
/* Triangle with a linear gradient from c0 at g[0..1] to c1 at g[2..3] */
void gfx_tri_gradient(const float v[6], uint32_t c0, uint32_t c1, const float g[4]);
void gfx_ellipse(float cx, float cy, float rx, float ry, uint32_t color, enum gfx_blend blend,
		 uint8_t alpha);
void gfx_line(float x0, float y0, float x1, float y1, uint32_t color, enum gfx_blend blend,
	      uint8_t alpha);
void gfx_sprite(float x, float y, float w, float h, const struct gfx_sprite *sprite,
		uint8_t frame, uint32_t tint, uint8_t tint_amount);
/* Text in the built-in 5x7 font, colors fade from top to bottom of the glyphs */
void gfx_text(float x, float y, int scale, const char *str, uint32_t top, uint32_t bottom,
	      uint8_t alpha);
void gfx_text_centered(float cx, float y, int scale, const char *str, uint32_t top,
		       uint32_t bottom, uint8_t alpha, uint32_t shadow);
int gfx_text_width(const char *str, int scale);

/* Unrolled, a plain store loop costs about four instructions per pixel */
static inline void gfx_fill32(uint32_t *p, uint32_t c, int n)
{
	for (; n >= 4; n -= 4, p += 4) {
		p[0] = c;
		p[1] = c;
		p[2] = c;
		p[3] = c;
	}
	for (; n > 0; n--) {
		*p++ = c;
	}
}

static inline uint32_t gfx_rgb(uint8_t r, uint8_t g, uint8_t b)
{
	return ((uint32_t)r << 16) | ((uint32_t)g << 8) | b;
}

/* Blend a towards b, t in 0..256 */
static inline uint32_t gfx_mix(uint32_t a, uint32_t b, uint32_t t)
{
	uint32_t rb = (((a & 0xff00ffU) * (256U - t)) + ((b & 0xff00ffU) * t)) >> 8;
	uint32_t g = (((a & 0x00ff00U) * (256U - t)) + ((b & 0x00ff00U) * t)) >> 8;

	return (rb & 0xff00ffU) | (g & 0x00ff00U);
}

static inline uint32_t gfx_mixf(uint32_t a, uint32_t b, float t)
{
	t = t < 0.0f ? 0.0f : (t > 1.0f ? 1.0f : t);

	return gfx_mix(a, b, (uint32_t)(t * 256.0f));
}

/* Saturating add of b scaled by alpha (0..256) */
static inline uint32_t gfx_add(uint32_t a, uint32_t b, uint32_t alpha)
{
	uint32_t r = ((a >> 16) & 0xffU) + ((((b >> 16) & 0xffU) * alpha) >> 8);
	uint32_t g = ((a >> 8) & 0xffU) + ((((b >> 8) & 0xffU) * alpha) >> 8);
	uint32_t bl = (a & 0xffU) + (((b & 0xffU) * alpha) >> 8);

	r = r > 255U ? 255U : r;
	g = g > 255U ? 255U : g;
	bl = bl > 255U ? 255U : bl;

	return (r << 16) | (g << 8) | bl;
}

#endif /* KITE_RUSH_GFX_H_ */
