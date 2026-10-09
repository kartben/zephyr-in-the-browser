/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <math.h>

#include <zephyr/sys/util.h>

#include "gfx.h"
#include "kite.h"

/* Logo coordinates (doc/_static/images/logo.svg), body centre E */
#define E_X 220.982f
#define E_Y 44.482f

/* Tail runs from the body corner to the tip */
#define TAIL_ROOT_X 137.154f
#define TAIL_SPAN   128.4f

struct facet {
	float v[6];
	float g[4]; /* gradient start and end */
	uint32_t c0, c1;
};

static const struct facet body[] = {
	{{137.154f, 121.601f, 220.982f, 44.482f, 258.666f, 94.416f},
	 {173.227f, 83.041f, 269.621f, 83.041f},
	 0x7929d2U,
	 0x0070c5U},
	{{137.154f, 121.601f, 172.959f, 8.13f, 220.982f, 44.482f},
	 {179.787f, -1.879f, 178.980f, 93.408f},
	 0x00aeffU,
	 0x9454dbU},
	{{172.959f, 8.13f, 258.666f, 8.13f, 220.982f, 44.482f},
	 {232.845f, 37.632f, 212.266f, 1.987f},
	 0x66a9dcU,
	 0xb1e4faU},
	{{258.666f, 94.416f, 258.666f, 8.13f, 220.982f, 44.482f},
	 {237.423f, 9.703f, 249.116f, 90.577f},
	 0x00aeffU,
	 0x9454dbU},
};

static const struct {
	float v[6];
	uint32_t color;
} tail[] = {
	{{137.154f, 121.601f, 105.31f, 135.046f, 132.385f, 148.72f}, 0x7929d2U},
	{{84.508f, 115.518f, 105.31f, 135.046f, 68.401f, 139.419f}, 0xaf7fe4U},
	{{68.401f, 139.419f, 34.434f, 126.703f, 42.309f, 153.408f}, 0x9454dbU},
	{{38.535f, 97.167f, 34.434f, 126.703f, 8.759f, 101.076f}, 0xaf7fe4U},
};

struct xform {
	float cx, cy, s, ca, sa;
};

static void apply(const struct xform *xf, float lx, float ly, float *out)
{
	float dx = (lx - E_X) * xf->s;
	float dy = (ly - E_Y) * xf->s;

	out[0] = xf->cx + dx * xf->ca - dy * xf->sa;
	out[1] = xf->cy + dx * xf->sa + dy * xf->ca;
}

static void tail_point(const struct kite_pose *pose, float lx, float ly, float *ox, float *oy)
{
	float u = (TAIL_ROOT_X - lx) / TAIL_SPAN;

	u = u < 0.0f ? 0.0f : (u > 1.0f ? 1.0f : u);
	*ox = lx - pose->swing * u * 45.0f;
	*oy = ly + pose->flutter * u * sinf(pose->time * 9.0f - u * 4.5f);
}

void kite_draw(const struct kite_pose *pose)
{
	struct xform xf = {
		.cx = pose->x,
		.cy = pose->y,
		.s = pose->scale,
		.ca = cosf(pose->angle),
		.sa = sinf(pose->angle),
	};
	struct xform outline = xf;
	float v[6], g[4];

	/* Dark silhouette behind the body keeps it readable on any sky */
	outline.s *= 1.14f;
	for (size_t i = 0; i < ARRAY_SIZE(body); i++) {
		for (int k = 0; k < 3; k++) {
			apply(&outline, body[i].v[k * 2], body[i].v[k * 2 + 1], &v[k * 2]);
		}
		gfx_tri(v, 0x0b0322U, GFX_SOLID, 255);
	}

	for (size_t i = 0; i < ARRAY_SIZE(tail); i++) {
		for (int k = 0; k < 3; k++) {
			float lx, ly;

			tail_point(pose, tail[i].v[k * 2], tail[i].v[k * 2 + 1], &lx, &ly);
			apply(&xf, lx, ly, &v[k * 2]);
		}
		gfx_tri(v, gfx_mix(tail[i].color, pose->tint, pose->tint_amount), GFX_SOLID, 255);
	}

	for (size_t i = 0; i < ARRAY_SIZE(body); i++) {
		for (int k = 0; k < 3; k++) {
			apply(&xf, body[i].v[k * 2], body[i].v[k * 2 + 1], &v[k * 2]);
		}
		apply(&xf, body[i].g[0], body[i].g[1], &g[0]);
		apply(&xf, body[i].g[2], body[i].g[3], &g[2]);
		gfx_tri_gradient(v, gfx_mix(body[i].c0, pose->tint, pose->tint_amount),
				 gfx_mix(body[i].c1, pose->tint, pose->tint_amount), g);
	}
}
