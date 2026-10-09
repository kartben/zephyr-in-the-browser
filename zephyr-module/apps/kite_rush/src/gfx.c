/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <math.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>

#include "font.h"
#include "gfx.h"

#define TEXT_POOL_SIZE 1024

/* Rows are grouped in bands, each band lists the primitives that reach it */
#define BAND_SHIFT   3
#define BAND_MAX     (1024 >> BAND_SHIFT)
#define BAND_ENTRIES (4 * CONFIG_KITE_RUSH_MAX_PRIMS)

enum prim_type {
	PRIM_RECT,
	PRIM_TRI,
	PRIM_ELLIPSE,
	PRIM_LINE,
	PRIM_SPRITE,
	PRIM_TEXT,
};

struct edge {
	float y0, y1; /* y0 < y1, an empty range marks a horizontal edge */
	float x0;     /* x at y0 */
	float slope;  /* dx / dy */
};

struct prim {
	uint8_t type;
	uint8_t blend;
	uint16_t alpha; /* 0..256 */
	int16_t y0, y1; /* covered rows [y0, y1) */
	uint32_t color;
	union {
		struct {
			int16_t x0, x1;
		} rect;
		struct {
			struct edge e[3];
			uint32_t c1;
			float gx, gy, gc; /* gradient position t = gx * x + gy * y + gc */
			bool gradient;
		} tri;
		struct {
			float cx, cy, rx, ry;
		} ell;
		struct {
			float x0, y0, x1, y1;
		} line;
		struct {
			float x, y, w, h;
			const struct gfx_sprite *sprite;
			uint32_t tint;
			uint8_t frame;
			uint8_t tint_amount;
		} spr;
		struct {
			int16_t x, y;
			uint16_t str;
			uint8_t scale;
			uint32_t bottom;
		} text;
	};
};

static struct prim prims[CONFIG_KITE_RUSH_MAX_PRIMS];
static int prim_count;
static uint16_t band_start[BAND_MAX + 1];
static uint16_t band_list[BAND_ENTRIES];
static bool banded;
static char text_pool[TEXT_POOL_SIZE];
static int text_used;
static int gfx_w;
static int gfx_h;

static inline int px_start(float x)
{
	/* First pixel whose centre lies at or right of x, without a libm call */
	float v = x - 0.5f;
	int i = (int)v;

	return ((float)i < v) ? i + 1 : i;
}

void gfx_begin(int width, int height)
{
	gfx_w = width;
	gfx_h = MIN(height, BAND_MAX << BAND_SHIFT);
	prim_count = 0;
	text_used = 0;
	banded = false;
}

void gfx_end(void)
{
	int bands = (gfx_h + (1 << BAND_SHIFT) - 1) >> BAND_SHIFT;
	uint16_t cursor[BAND_MAX];
	int total = 0;

	memset(cursor, 0, sizeof(cursor));
	for (int i = 0; i < prim_count; i++) {
		for (int b = prims[i].y0 >> BAND_SHIFT; b <= (prims[i].y1 - 1) >> BAND_SHIFT; b++) {
			cursor[b]++;
		}
	}

	for (int b = 0; b < bands; b++) {
		band_start[b] = (uint16_t)total;
		total += cursor[b];
		cursor[b] = band_start[b];
	}
	band_start[bands] = (uint16_t)total;

	/* Too many entries: fall back to scanning every primitive on every row */
	banded = total <= BAND_ENTRIES;
	if (!banded) {
		return;
	}

	/* Filled in primitive order, which is the drawing order */
	for (int i = 0; i < prim_count; i++) {
		for (int b = prims[i].y0 >> BAND_SHIFT; b <= (prims[i].y1 - 1) >> BAND_SHIFT; b++) {
			band_list[cursor[b]++] = (uint16_t)i;
		}
	}
}

static struct prim *prim_add(int type, float ymin, float ymax, uint32_t color, enum gfx_blend blend,
			     uint8_t alpha)
{
	struct prim *p;
	int y0 = (int)ceilf(ymin - 0.5f);
	int y1 = (int)ceilf(ymax - 0.5f);

	y0 = MAX(y0, 0);
	y1 = MIN(y1, gfx_h);
	if (y0 >= y1 || prim_count >= (int)ARRAY_SIZE(prims) || alpha == 0U) {
		return NULL;
	}

	p = &prims[prim_count++];
	p->type = (uint8_t)type;
	p->blend = (uint8_t)blend;
	p->alpha = alpha == 255U ? 256U : alpha;
	p->y0 = (int16_t)y0;
	p->y1 = (int16_t)y1;
	p->color = color;

	return p;
}

void gfx_rect(float x0, float y0, float x1, float y1, uint32_t color, enum gfx_blend blend,
	      uint8_t alpha)
{
	struct prim *p;

	if (x1 <= 0.0f || x0 >= (float)gfx_w) {
		return;
	}

	p = prim_add(PRIM_RECT, y0, y1, color, blend, alpha);
	if (p != NULL) {
		p->rect.x0 = (int16_t)MAX(px_start(x0), 0);
		p->rect.x1 = (int16_t)MIN(px_start(x1), gfx_w);
	}
}

static struct prim *tri_setup(const float v[6], uint32_t color, enum gfx_blend blend, uint8_t alpha)
{
	float ymin = MIN(v[1], MIN(v[3], v[5]));
	float ymax = MAX(v[1], MAX(v[3], v[5]));
	float xmin = MIN(v[0], MIN(v[2], v[4]));
	float xmax = MAX(v[0], MAX(v[2], v[4]));
	struct prim *p;

	if (xmax <= 0.0f || xmin >= (float)gfx_w) {
		return NULL;
	}

	p = prim_add(PRIM_TRI, ymin, ymax, color, blend, alpha);
	if (p == NULL) {
		return NULL;
	}

	for (int i = 0; i < 3; i++) {
		const float *a = &v[i * 2];
		const float *b = &v[((i + 1) % 3) * 2];
		struct edge *e = &p->tri.e[i];

		if (a[1] > b[1]) {
			const float *tmp = a;

			a = b;
			b = tmp;
		}
		e->y0 = a[1];
		e->y1 = b[1];
		e->x0 = a[0];
		e->slope = b[1] > a[1] ? (b[0] - a[0]) / (b[1] - a[1]) : 0.0f;
	}
	p->tri.gradient = false;

	return p;
}

void gfx_tri(const float v[6], uint32_t color, enum gfx_blend blend, uint8_t alpha)
{
	(void)tri_setup(v, color, blend, alpha);
}

void gfx_tri_gradient(const float v[6], uint32_t c0, uint32_t c1, const float g[4])
{
	struct prim *p = tri_setup(v, c0, GFX_SOLID, 255);
	float dx = g[2] - g[0];
	float dy = g[3] - g[1];
	float len2 = dx * dx + dy * dy;

	if (p == NULL || len2 < 1e-6f) {
		return;
	}

	p->tri.gradient = true;
	p->tri.c1 = c1;
	p->tri.gx = dx / len2;
	p->tri.gy = dy / len2;
	p->tri.gc = -(g[0] * dx + g[1] * dy) / len2;
}

void gfx_ellipse(float cx, float cy, float rx, float ry, uint32_t color, enum gfx_blend blend,
		 uint8_t alpha)
{
	struct prim *p;

	if (rx < 0.3f || ry < 0.3f || cx + rx <= 0.0f || cx - rx >= (float)gfx_w) {
		return;
	}

	p = prim_add(PRIM_ELLIPSE, cy - ry, cy + ry, color, blend, alpha);
	if (p != NULL) {
		p->ell.cx = cx;
		p->ell.cy = cy;
		p->ell.rx = rx;
		p->ell.ry = ry;
	}
}

void gfx_line(float x0, float y0, float x1, float y1, uint32_t color, enum gfx_blend blend,
	      uint8_t alpha)
{
	struct prim *p;

	if (y0 > y1) {
		float t = y0;

		y0 = y1;
		y1 = t;
		t = x0;
		x0 = x1;
		x1 = t;
	}

	p = prim_add(PRIM_LINE, floorf(y0) + 0.5f, floorf(y1) + 1.5f, color, blend, alpha);
	if (p != NULL) {
		p->line.x0 = x0;
		p->line.y0 = y0;
		p->line.x1 = x1;
		p->line.y1 = y1;
	}
}

void gfx_sprite(float x, float y, float w, float h, const struct gfx_sprite *sprite,
		uint8_t frame, uint32_t tint, uint8_t tint_amount)
{
	struct prim *p;

	if (w < 1.0f || h < 1.0f || x + w <= 0.0f || x >= (float)gfx_w) {
		return;
	}

	p = prim_add(PRIM_SPRITE, y, y + h, 0, GFX_SOLID, 255);
	if (p != NULL) {
		p->spr.x = x;
		p->spr.y = y;
		p->spr.w = w;
		p->spr.h = h;
		p->spr.sprite = sprite;
		p->spr.frame = frame % sprite->frames;
		p->spr.tint = tint;
		p->spr.tint_amount = tint_amount;
	}
}

int gfx_text_width(const char *str, int scale)
{
	int n = (int)strlen(str);

	return n > 0 ? (n * 6 - 1) * scale : 0;
}

void gfx_text(float x, float y, int scale, const char *str, uint32_t top, uint32_t bottom,
	      uint8_t alpha)
{
	size_t len = strlen(str) + 1U;
	struct prim *p;

	if ((size_t)text_used + len > sizeof(text_pool) || scale < 1) {
		return;
	}

	x = roundf(x);
	y = roundf(y);
	p = prim_add(PRIM_TEXT, y, y + (float)(7 * scale), top,
		     alpha == 255U ? GFX_SOLID : GFX_ALPHA, alpha);
	if (p == NULL) {
		return;
	}

	memcpy(&text_pool[text_used], str, len);
	p->text.x = (int16_t)x;
	p->text.y = (int16_t)y;
	p->text.str = (uint16_t)text_used;
	p->text.scale = (uint8_t)scale;
	p->text.bottom = bottom;
	text_used += (int)len;
}

void gfx_text_centered(float cx, float y, int scale, const char *str, uint32_t top,
		       uint32_t bottom, uint8_t alpha, uint32_t shadow)
{
	float x = cx - (float)gfx_text_width(str, scale) / 2.0f;
	int off = MAX(1, scale / 2);

	if (shadow != 0U) {
		gfx_text(x + (float)off, y + (float)off, scale, str, shadow, shadow,
			 (uint8_t)MIN(255U, alpha * 3U / 4U));
	}
	gfx_text(x, y, scale, str, top, bottom, alpha);
}

static void fill(uint32_t *row, int x0, int x1, uint32_t color, uint8_t blend, uint32_t alpha)
{
	x0 = MAX(x0, 0);
	x1 = MIN(x1, gfx_w);

	switch (blend) {
	case GFX_SOLID:
		gfx_fill32(&row[x0], color, x1 - x0);
		break;
	case GFX_ALPHA:
		for (int x = x0; x < x1; x++) {
			row[x] = gfx_mix(row[x], color, alpha);
		}
		break;
	default:
		for (int x = x0; x < x1; x++) {
			row[x] = gfx_add(row[x], color, alpha);
		}
		break;
	}
}

static void draw_tri(uint32_t *row, const struct prim *p, float yc)
{
	float xl = 1e9f;
	float xr = -1e9f;
	int32_t tf, dtf;
	int x0, x1;

	for (int i = 0; i < 3; i++) {
		const struct edge *e = &p->tri.e[i];
		float x;

		if (yc < e->y0 || yc >= e->y1) {
			continue;
		}
		x = e->x0 + (yc - e->y0) * e->slope;
		xl = MIN(xl, x);
		xr = MAX(xr, x);
	}
	if (xl >= xr) {
		return;
	}

	x0 = MAX(px_start(xl), 0);
	x1 = MIN(px_start(xr), gfx_w);

	if (!p->tri.gradient) {
		fill(row, x0, x1, p->color, p->blend, p->alpha);
		return;
	}

	/* Gradient position stepped in 16.16 fixed point */
	tf = (int32_t)((p->tri.gx * ((float)x0 + 0.5f) + p->tri.gy * yc + p->tri.gc) * 65536.0f);
	dtf = (int32_t)(p->tri.gx * 65536.0f);

	for (int x = x0; x < x1; x++) {
		int32_t k = tf >> 8;

		k = k < 0 ? 0 : (k > 256 ? 256 : k);
		row[x] = gfx_mix(p->color, p->tri.c1, (uint32_t)k);
		tf += dtf;
	}
}

static void draw_ellipse(uint32_t *row, const struct prim *p, float yc)
{
	float dy = (yc - p->ell.cy) / p->ell.ry;
	float hw;

	if (dy * dy >= 1.0f) {
		return;
	}
	hw = p->ell.rx * sqrtf(1.0f - dy * dy);
	fill(row, px_start(p->ell.cx - hw), px_start(p->ell.cx + hw), p->color, p->blend, p->alpha);
}

static void draw_line(uint32_t *row, const struct prim *p, int y)
{
	float ya = MAX((float)y, p->line.y0);
	float yb = MIN((float)y + 1.0f, p->line.y1);
	float xa, xb, dy = p->line.y1 - p->line.y0;

	if (dy < 1e-3f) {
		xa = p->line.x0;
		xb = p->line.x1;
	} else {
		xa = p->line.x0 + (ya - p->line.y0) * (p->line.x1 - p->line.x0) / dy;
		xb = p->line.x0 + (yb - p->line.y0) * (p->line.x1 - p->line.x0) / dy;
	}
	if (xa > xb) {
		float t = xa;

		xa = xb;
		xb = t;
	}
	fill(row, (int)floorf(xa), (int)floorf(xb) + 1, p->color, p->blend, p->alpha);
}

static void draw_sprite(uint32_t *row, const struct prim *p, float yc)
{
	const struct gfx_sprite *s = p->spr.sprite;
	int sy = (int)((yc - p->spr.y) * (float)s->h / p->spr.h);
	int x0 = MAX(px_start(p->spr.x), 0);
	int x1 = MIN(px_start(p->spr.x + p->spr.w), gfx_w);
	const uint8_t *src;
	int32_t u, du;

	if (sy < 0 || sy >= s->h || x0 >= x1) {
		return;
	}

	src = &s->pixels[((size_t)p->spr.frame * s->h + (size_t)sy) * s->w];
	du = (int32_t)((float)s->w / p->spr.w * 65536.0f);
	u = (int32_t)(((float)x0 + 0.5f - p->spr.x) * (float)s->w / p->spr.w * 65536.0f);

	for (int x = x0; x < x1; x++, u += du) {
		int sx = MIN(MAX(u >> 16, 0), s->w - 1);
		uint8_t idx = src[sx];

		if (idx != 0U) {
			row[x] = gfx_mix(s->palette[idx], p->spr.tint, p->spr.tint_amount);
		}
	}
}

static void draw_text(uint32_t *row, const struct prim *p, int y)
{
	int scale = p->text.scale;
	int gy = (y - p->text.y) / scale;
	const char *str = &text_pool[p->text.str];
	uint32_t color;
	int x;

	if (gy < 0 || gy >= FONT_HEIGHT) {
		return;
	}

	color = gfx_mix(p->color, p->text.bottom, (uint32_t)(gy * 256 / (FONT_HEIGHT - 1)));
	x = p->text.x;

	for (; *str != '\0'; str++, x += (FONT_WIDTH + 1) * scale) {
		uint8_t bits = font_glyph(*str)[gy];

		if (x >= gfx_w) {
			break;
		}
		for (int col = 0; col < FONT_WIDTH; col++) {
			if ((bits & (0x10U >> col)) != 0U) {
				int px = x + col * scale;

				fill(row, px, px + scale, color, p->blend, p->alpha);
			}
		}
	}
}

void gfx_draw_row(uint32_t *row, int y)
{
	float yc = (float)y + 0.5f;
	int first = 0;
	int count = prim_count;

	if (banded) {
		first = band_start[y >> BAND_SHIFT];
		count = band_start[(y >> BAND_SHIFT) + 1] - first;
	}

	for (int n = 0; n < count; n++) {
		const struct prim *p = &prims[banded ? band_list[first + n] : n];

		if (y < p->y0 || y >= p->y1) {
			continue;
		}

		switch (p->type) {
		case PRIM_RECT:
			fill(row, p->rect.x0, p->rect.x1, p->color, p->blend, p->alpha);
			break;
		case PRIM_TRI:
			draw_tri(row, p, yc);
			break;
		case PRIM_ELLIPSE:
			draw_ellipse(row, p, yc);
			break;
		case PRIM_LINE:
			draw_line(row, p, y);
			break;
		case PRIM_SPRITE:
			draw_sprite(row, p, yc);
			break;
		case PRIM_TEXT:
			draw_text(row, p, y);
			break;
		default:
			break;
		}
	}
}
