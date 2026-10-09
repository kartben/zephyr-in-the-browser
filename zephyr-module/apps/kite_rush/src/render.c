/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <math.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/drivers/display.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include "gfx.h"
#include "kite.h"
#include "render.h"

LOG_MODULE_REGISTER(render, LOG_LEVEL_INF);

/* The game is designed for 320x240 and scaled by an integer factor */
#define DESIGN_W 320
#define DESIGN_H 240
#define ROW_MAX  1024
#define ROWS_MAX 1024

#define HORIZON_RATIO 0.42f
#define FOCAL_RATIO   0.95f
#define FOG_START     20.0f
#define FOG_END       115.0f
#define GRID_X        2.0f
#define GRID_X_SHIFT  17 /* the same in 16.16 fixed point */
#define GRID_Z        4.0f
#define GRID_LINE     0.06f
#define KITE_WORLD_W  0.8f
#define GATE_BAR      0.16f
#define MTN_SIZE      512

struct palette {
	uint32_t sky_top;
	uint32_t sky_mid;
	uint32_t sky_horizon;
	uint32_t ground;
	uint32_t grid;
	uint32_t glow;
	uint32_t sun_top;
	uint32_t sun_bottom;
	uint32_t mtn_far;
	uint32_t mtn_near;
	uint32_t rim;
};

#define PALETTE_WORDS (sizeof(struct palette) / sizeof(uint32_t))

/* One palette per level, cycling */
static const struct palette palettes[] = {
	{
		/* Synthwave sunset */
		.sky_top = 0x1b0f45U,
		.sky_mid = 0x7b2c8fU,
		.sky_horizon = 0xff7b54U,
		.ground = 0x12062aU,
		.grid = 0xff2fb0U,
		.glow = 0x6a1458U,
		.sun_top = 0xffe55cU,
		.sun_bottom = 0xff3d7fU,
		.mtn_far = 0x4b2380U,
		.mtn_near = 0x24104cU,
		.rim = 0xff8ae0U,
	},
	{
		/* Zephyr blue hour */
		.sky_top = 0x04103aU,
		.sky_mid = 0x1f3a9eU,
		.sky_horizon = 0x45c8ffU,
		.ground = 0x050a26U,
		.grid = 0x00c8ffU,
		.glow = 0x103a78U,
		.sun_top = 0xffffffU,
		.sun_bottom = 0xaf7fe4U,
		.mtn_far = 0x22357aU,
		.mtn_near = 0x0f1a48U,
		.rim = 0x7fe0ffU,
	},
	{
		/* Aurora */
		.sky_top = 0x02121cU,
		.sky_mid = 0x0b4a5aU,
		.sky_horizon = 0x5effc0U,
		.ground = 0x03140fU,
		.grid = 0x2dffb3U,
		.glow = 0x0d4a3aU,
		.sun_top = 0xfdffb0U,
		.sun_bottom = 0x3dffa8U,
		.mtn_far = 0x11414dU,
		.mtn_near = 0x062530U,
		.rim = 0x8affd8U,
	},
	{
		/* Ember */
		.sky_top = 0x1a0408U,
		.sky_mid = 0x7a0f2aU,
		.sky_horizon = 0xffb03bU,
		.ground = 0x160308U,
		.grid = 0xff6a1fU,
		.glow = 0x5a1408U,
		.sun_top = 0xfff2a8U,
		.sun_bottom = 0xff5a1fU,
		.mtn_far = 0x5a1530U,
		.mtn_near = 0x2c0716U,
		.rim = 0xffb070U,
	},
};

static const struct palette night = {
	.sky_top = 0x020208U,
	.sky_mid = 0x0a0820U,
	.sky_horizon = 0x24124aU,
	.ground = 0x030208U,
	.grid = 0x3a1060U,
	.glow = 0x10061eU,
	.sun_top = 0x000000U,
	.sun_bottom = 0x000000U,
	.mtn_far = 0x0a0620U,
	.mtn_near = 0x050312U,
	.rim = 0x2a1a50U,
};

/* Bug sprite, left half mirrored at init */
static const char *const bug_art[2][14] = {
	{
		"..#.....",
		"...#....",
		"....####",
		"...#WWW#",
		"...#WKW#",
		"#..#####",
		".#.#GGGD",
		"..##GHGD",
		"...#GGGD",
		"####GGGD",
		"...#GHGD",
		"..##GGGD",
		".#..#GGD",
		"#....###",
	},
	{
		"...#....",
		"...#....",
		"....####",
		"...#WWW#",
		"...#WKW#",
		"...#####",
		"##.#GGGD",
		"..##GHGD",
		"#..#GGGD",
		".###GGGD",
		"#..#GHGD",
		".###GGGD",
		"...##GGD",
		"..#..###",
	},
};

static const uint32_t bug_palette[] = {
	0x000000U, 0x15240fU, 0x7cff3cU, 0xc8ff8aU, 0x2f8f1fU, 0xffffffU, 0x111111U,
};

static uint8_t bug_pixels[2 * 14 * 16];

static const struct gfx_sprite bug_sprite = {
	.w = 16,
	.h = 14,
	.frames = 2,
	.pixels = bug_pixels,
	.palette = bug_palette,
};

static const struct device *disp;
static uint8_t bpp; /* bytes per pixel */
static int scale;
static int log_w, log_h;
static int off_x, off_y;
static int out_x;        /* display column of the strips */
static int disp_h;       /* display rows */
static size_t out_pitch; /* bytes per output row */
static int lines_per_strip;

/*
 * With the display thread, one strip is drawn while the other one is sent,
 * which overlaps drawing with the transfer when the display driver sleeps
 * during DMA.
 */
#define STRIP_COUNT (IS_ENABLED(CONFIG_KITE_RUSH_DISPLAY_THREAD) ? 2 : 1)

struct strip_job {
	uint8_t *buf;
	uint16_t y;    /* first display row */
	uint16_t rows; /* display rows */
	bool last;
};

static uint8_t strips[STRIP_COUNT][CONFIG_KITE_RUSH_STRIP_BUFFER_SIZE] __aligned(4);
static uint32_t row_buf[ROW_MAX];

K_MSGQ_DEFINE(strip_queue, sizeof(struct strip_job), STRIP_COUNT, 4);
K_SEM_DEFINE(strip_free, STRIP_COUNT, STRIP_COUNT);
K_THREAD_STACK_DEFINE(writer_stack, 2048);
static struct k_thread writer_thread;

/* Strip being filled */
static struct {
	uint8_t *buf;
	int y;    /* first logical row */
	int rows; /* logical rows */
	int next; /* buffer to fill next */
} fill;

static struct render_stats stats;

static inline uint32_t prof_now(void)
{
	return IS_ENABLED(CONFIG_KITE_RUSH_PROFILE) ? k_cycle_get_32() : 0U;
}

static uint32_t row_hash[ROWS_MAX];
static bool row_hashed[ROWS_MAX];
static bool skip_rows;
static unsigned int field;

static uint8_t mtn_far[MTN_SIZE];
static uint8_t mtn_near[MTN_SIZE];
static int16_t mtn_far_top[ROW_MAX];
static int16_t mtn_near_top[ROW_MAX];

#define STAR_COUNT 72

struct star {
	int16_t x, y;
	uint8_t level;
};

static struct star stars[STAR_COUNT];

/* Per frame background state */
static struct {
	struct palette pal;
	float hy;     /* horizon row */
	float cx;     /* projection centre */
	float f;      /* focal length in pixels */
	float cam_x, cam_h, cam_z;
	float sun_x, sun_y, sun_r;
	float night;
	float time;
	int mtn_far_off, mtn_near_off;
	float mtn_far_h, mtn_near_h;
	int star_idx;
} bg;

/* Rows are read from the other end when the picture is upside down */
#define ROW_START(src, w) (IS_ENABLED(CONFIG_KITE_RUSH_ROTATE_180) ? (src) + (w) - 1 : (src))
#define ROW_STEP          (IS_ENABLED(CONFIG_KITE_RUSH_ROTATE_180) ? -1 : 1)

typedef void (*expand_fn)(uint8_t *dst, const uint32_t *src, int w, int s);

static void expand_argb8888(uint8_t *dst, const uint32_t *src, int w, int s)
{
	const uint32_t *p = ROW_START(src, w);
	uint32_t *d = (uint32_t *)dst;

	if (s == 1) {
		for (int x = 0; x < w; x++, p += ROW_STEP) {
			d[x] = sys_cpu_to_le32(*p | 0xff000000U);
		}
		return;
	}

	for (int x = 0; x < w; x++, p += ROW_STEP) {
		uint32_t c = sys_cpu_to_le32(*p | 0xff000000U);

		for (int k = 0; k < s; k++) {
			*d++ = c;
		}
	}
}

static void expand_rgb888(uint8_t *dst, const uint32_t *src, int w, int s)
{
	const uint32_t *p = ROW_START(src, w);

	for (int x = 0; x < w; x++, p += ROW_STEP) {
		uint32_t c = *p;

		for (int k = 0; k < s; k++) {
			*dst++ = (uint8_t)c;
			*dst++ = (uint8_t)(c >> 8);
			*dst++ = (uint8_t)(c >> 16);
		}
	}
}

static void expand_bgr888(uint8_t *dst, const uint32_t *src, int w, int s)
{
	const uint32_t *p = ROW_START(src, w);

	for (int x = 0; x < w; x++, p += ROW_STEP) {
		uint32_t c = *p;

		for (int k = 0; k < s; k++) {
			*dst++ = (uint8_t)(c >> 16);
			*dst++ = (uint8_t)(c >> 8);
			*dst++ = (uint8_t)c;
		}
	}
}

static inline uint16_t to_rgb565(uint32_t c)
{
	return (uint16_t)(((c >> 8) & 0xf800U) | ((c >> 5) & 0x07e0U) | ((c >> 3) & 0x001fU));
}

static void expand_rgb565(uint8_t *dst, const uint32_t *src, int w, int s)
{
	const uint32_t *p = ROW_START(src, w);
	uint16_t *d = (uint16_t *)dst;

	if (s == 1) {
		for (int x = 0; x < w; x++, p += ROW_STEP) {
			d[x] = sys_cpu_to_le16(to_rgb565(*p));
		}
		return;
	}

	if (s == 2) {
		/* Both copies of a pixel in one store, rows are 4-byte aligned */
		uint32_t *d2 = (uint32_t *)dst;

		for (int x = 0; x < w; x++, p += ROW_STEP) {
			uint32_t c = sys_cpu_to_le16(to_rgb565(*p));

			d2[x] = c | (c << 16);
		}
		return;
	}

	for (int x = 0; x < w; x++, p += ROW_STEP) {
		uint16_t c = sys_cpu_to_le16(to_rgb565(*p));

		for (int k = 0; k < s; k++) {
			*d++ = c;
		}
	}
}

static void expand_rgb565x(uint8_t *dst, const uint32_t *src, int w, int s)
{
	const uint32_t *p = ROW_START(src, w);
	uint16_t *d = (uint16_t *)dst;

	if (s == 1) {
		for (int x = 0; x < w; x++, p += ROW_STEP) {
			d[x] = sys_cpu_to_be16(to_rgb565(*p));
		}
		return;
	}

	if (s == 2) {
		/* Both copies of a pixel in one store, rows are 4-byte aligned */
		uint32_t *d2 = (uint32_t *)dst;

		for (int x = 0; x < w; x++, p += ROW_STEP) {
			uint32_t c = sys_cpu_to_be16(to_rgb565(*p));

			d2[x] = c | (c << 16);
		}
		return;
	}

	for (int x = 0; x < w; x++, p += ROW_STEP) {
		uint16_t c = sys_cpu_to_be16(to_rgb565(*p));

		for (int k = 0; k < s; k++) {
			*d++ = c;
		}
	}
}

static void expand_l8(uint8_t *dst, const uint32_t *src, int w, int s)
{
	const uint32_t *p = ROW_START(src, w);

	for (int x = 0; x < w; x++, p += ROW_STEP) {
		uint32_t c = *p;
		uint8_t l = (uint8_t)((((c >> 16) & 0xffU) * 77U + ((c >> 8) & 0xffU) * 150U +
				       (c & 0xffU) * 29U) >> 8);

		for (int k = 0; k < s; k++) {
			*dst++ = l;
		}
	}
}

static const struct {
	enum display_pixel_format fmt;
	uint8_t bpp;
	expand_fn fn;
} formats[] = {
	{PIXEL_FORMAT_ARGB_8888, 4, expand_argb8888},
	{PIXEL_FORMAT_XRGB_8888, 4, expand_argb8888},
	{PIXEL_FORMAT_RGB_565, 2, expand_rgb565},
	{PIXEL_FORMAT_RGB_565X, 2, expand_rgb565x},
	{PIXEL_FORMAT_RGB_888, 3, expand_rgb888},
	{PIXEL_FORMAT_BGR_888, 3, expand_bgr888},
	{PIXEL_FORMAT_L_8, 1, expand_l8},
};

static expand_fn expand;

static float clampf(float v, float lo, float hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

static inline int ifloor(float v)
{
	int i = (int)v;

	return (v < (float)i) ? i - 1 : i;
}

static uint32_t hash32(uint32_t x)
{
	x ^= x >> 16;
	x *= 0x7feb352dU;
	x ^= x >> 15;
	x *= 0x846ca68bU;
	x ^= x >> 16;

	return x;
}

static void build_assets(void)
{
	static const char keys[] = ".#GHDWK";

	for (int f = 0; f < 2; f++) {
		for (int y = 0; y < 14; y++) {
			for (int x = 0; x < 8; x++) {
				const char *k = strchr(keys, bug_art[f][y][x]);
				uint8_t idx = (k != NULL) ? (uint8_t)(k - keys) : 0U;
				uint8_t *line = &bug_pixels[(f * 14 + y) * 16];

				line[x] = idx;
				line[15 - x] = idx;
			}
		}
	}

	/* Periodic ridges so the skyline wraps around seamlessly */
	for (int i = 0; i < MTN_SIZE; i++) {
		float a = 6.2832f * (float)i / (float)MTN_SIZE;
		float far = 0.55f + 0.22f * sinf(2.0f * a + 1.3f) + 0.14f * sinf(5.0f * a + 0.2f) +
			    0.09f * fabsf(sinf(13.0f * a + 2.1f));
		float near = 0.45f + 0.25f * sinf(3.0f * a + 0.7f) + 0.18f * sinf(7.0f * a + 2.9f) +
			     0.12f * fabsf(sinf(19.0f * a + 1.1f));

		mtn_far[i] = (uint8_t)(clampf(far, 0.0f, 1.0f) * 255.0f);
		mtn_near[i] = (uint8_t)(clampf(near, 0.0f, 1.0f) * 255.0f);
	}
}

static void place_stars(void)
{
	/* Sorted by row so each row only scans its own stars */
	for (int i = 0; i < STAR_COUNT; i++) {
		uint32_t h = hash32((uint32_t)i * 2654435761U + 17U);

		stars[i].x = (int16_t)(h % (uint32_t)log_w);
		stars[i].y = (int16_t)((h >> 12) % (uint32_t)(log_h * 0.36f));
		stars[i].level = (uint8_t)(90U + ((h >> 24) % 166U));
	}
	for (int i = 1; i < STAR_COUNT; i++) {
		for (int j = i; j > 0 && stars[j].y < stars[j - 1].y; j--) {
			struct star tmp = stars[j];

			stars[j] = stars[j - 1];
			stars[j - 1] = tmp;
		}
	}
}

static void write_black(void)
{
	struct display_capabilities caps;
	struct display_buffer_descriptor desc;
	int rows;

	display_get_capabilities(disp, &caps);
	memset(strips[0], 0, sizeof(strips[0]));
	rows = MAX(1, (int)(sizeof(strips[0]) / ((size_t)caps.x_resolution * bpp)));

	for (int y = 0; y < caps.y_resolution; y += rows) {
		desc.width = caps.x_resolution;
		desc.height = (uint16_t)MIN(rows, caps.y_resolution - y);
		desc.pitch = caps.x_resolution;
		desc.buf_size = (uint32_t)desc.width * desc.height * bpp;
		desc.frame_incomplete = y + rows < caps.y_resolution;
		display_write(disp, 0, (uint16_t)y, &desc, strips[0]);
	}
}

static void write_strip(const struct strip_job *job)
{
	struct display_buffer_descriptor desc = {
		.width = (uint16_t)(log_w * scale),
		.height = job->rows,
		.pitch = (uint16_t)(log_w * scale),
		.buf_size = (uint32_t)(out_pitch * job->rows),
		.frame_incomplete = !job->last,
	};

	display_write(disp, (uint16_t)out_x, job->y, &desc, job->buf);
}

static void writer(void *p1, void *p2, void *p3)
{
	struct strip_job job;

	ARG_UNUSED(p1);
	ARG_UNUSED(p2);
	ARG_UNUSED(p3);

	while (true) {
		k_msgq_get(&strip_queue, &job, K_FOREVER);
		write_strip(&job);
		k_sem_give(&strip_free);
	}
}

static void strip_submit(bool last)
{
	struct strip_job job;

	if (fill.buf == NULL) {
		return;
	}

	job.buf = fill.buf;
	job.y = (uint16_t)(off_y + fill.y * scale);
	job.rows = (uint16_t)(fill.rows * scale);
	job.last = last;
	if (IS_ENABLED(CONFIG_KITE_RUSH_ROTATE_180)) {
		/* The rows sit at the end of the buffer, bottom up on the display */
		job.buf += (size_t)(lines_per_strip - fill.rows) * (size_t)scale * out_pitch;
		job.y = (uint16_t)(disp_h - off_y - (fill.y + fill.rows) * scale);
	}
	fill.buf = NULL;

	if (IS_ENABLED(CONFIG_KITE_RUSH_DISPLAY_THREAD)) {
		(void)k_msgq_put(&strip_queue, &job, K_FOREVER);
	} else {
		uint32_t t = prof_now();

		write_strip(&job);
		stats.wait += prof_now() - t;
	}
}

/* Returns where the display rows for logical row y go */
static uint8_t *strip_row(int y)
{
	int slot;

	if (fill.buf != NULL && (fill.y + fill.rows != y || fill.rows == lines_per_strip)) {
		strip_submit(false);
	}

	if (fill.buf == NULL) {
		if (IS_ENABLED(CONFIG_KITE_RUSH_DISPLAY_THREAD)) {
			uint32_t t = prof_now();

			(void)k_sem_take(&strip_free, K_FOREVER);
			stats.wait += prof_now() - t;
		}
		fill.buf = strips[fill.next];
		fill.next = (fill.next + 1) % STRIP_COUNT;
		fill.y = y;
		fill.rows = 0;
	}

	slot = fill.rows++;
	if (IS_ENABLED(CONFIG_KITE_RUSH_ROTATE_180)) {
		slot = lines_per_strip - slot - 1;
	}

	return &fill.buf[(size_t)slot * (size_t)scale * out_pitch];
}


static uint32_t hash_row(const uint32_t *row)
{
	uint32_t h = 0U;

	for (int x = 0; x < log_w; x++) {
		h = h * 31U + row[x];
	}

	return h;
}

int render_init(const struct device *display)
{
	struct display_capabilities caps;
	int fmt_idx = -1;

	disp = display;
	display_get_capabilities(disp, &caps);

	for (size_t i = 0; i < ARRAY_SIZE(formats); i++) {
		if (caps.current_pixel_format == formats[i].fmt) {
			fmt_idx = (int)i;
			break;
		}
	}
	for (size_t i = 0; fmt_idx < 0 && i < ARRAY_SIZE(formats); i++) {
		if ((caps.supported_pixel_formats & formats[i].fmt) != 0U &&
		    display_set_pixel_format(disp, formats[i].fmt) == 0) {
			fmt_idx = (int)i;
		}
	}
	if (fmt_idx < 0) {
		LOG_ERR("No supported pixel format (current 0x%x)", caps.current_pixel_format);
		return -ENOTSUP;
	}

	bpp = formats[fmt_idx].bpp;
	expand = formats[fmt_idx].fn;

	scale = MAX(1, MIN(caps.x_resolution / DESIGN_W, caps.y_resolution / DESIGN_H));
	log_w = MIN(caps.x_resolution / scale, ROW_MAX);
	log_h = MIN(caps.y_resolution / scale, ROWS_MAX);
	off_x = (caps.x_resolution - log_w * scale) / 2;
	off_y = (caps.y_resolution - log_h * scale) / 2;
	out_x = off_x;
	if (IS_ENABLED(CONFIG_KITE_RUSH_ROTATE_180)) {
		out_x = caps.x_resolution - off_x - log_w * scale;
	}
	disp_h = caps.y_resolution;
	out_pitch = (size_t)log_w * (size_t)scale * bpp;
	lines_per_strip = (int)(sizeof(strips[0]) / (out_pitch * (size_t)scale));

	if (lines_per_strip < 1) {
		LOG_ERR("Strip buffer too small, need %u bytes",
			(unsigned int)(out_pitch * (size_t)scale));
		return -ENOMEM;
	}

	LOG_INF("Display %ux%u, %u bpp, game %dx%d scaled x%d, %d rows per write",
		caps.x_resolution, caps.y_resolution, bpp * 8U, log_w, log_h, scale,
		lines_per_strip);

	/* Panels with their own memory keep the rows that are not resent */
	skip_rows = IS_ENABLED(CONFIG_KITE_RUSH_SKIP_UNCHANGED_ROWS) &&
		    display_get_framebuffer(disp) == NULL;

	build_assets();
	place_stars();
	write_black();
	display_blanking_off(disp);

	if (IS_ENABLED(CONFIG_KITE_RUSH_DISPLAY_THREAD)) {
		k_thread_create(&writer_thread, writer_stack, K_THREAD_STACK_SIZEOF(writer_stack),
				writer, NULL, NULL, NULL, CONFIG_MAIN_THREAD_PRIORITY - 1, 0,
				K_NO_WAIT);
		k_thread_name_set(&writer_thread, "display");
	}

	return 0;
}

static void mix_palette(struct palette *out, const struct palette *a, const struct palette *b,
			float t)
{
	const uint32_t *pa = (const uint32_t *)a;
	const uint32_t *pb = (const uint32_t *)b;
	uint32_t *po = (uint32_t *)out;

	for (size_t i = 0; i < PALETTE_WORDS; i++) {
		po[i] = gfx_mixf(pa[i], pb[i], t);
	}
}

static void fill_row(uint32_t *row, int x0, int x1, uint32_t c)
{
	x0 = MAX(x0, 0);
	x1 = MIN(x1, log_w);
	if (x1 > x0) {
		gfx_fill32(&row[x0], c, x1 - x0);
	}
}

static void span_row(uint32_t *row, float cx, float hw, uint32_t c)
{
	fill_row(row, -ifloor(hw + 0.5f - cx), -ifloor(0.5f - hw - cx), c);
}

/* The sky is one color per row, so each halo band is a plain fill */
static void halo_row(uint32_t *row, float dy, uint32_t sky)
{
	float r = bg.sun_r;
	uint32_t outer = gfx_add(sky, bg.pal.sun_bottom, 22);

	span_row(row, bg.sun_x, sqrtf(r * r * 3.0625f - dy * dy), outer);
	if (fabsf(dy) < r * 1.3f) {
		span_row(row, bg.sun_x, sqrtf(r * r * 1.69f - dy * dy),
			 gfx_add(outer, bg.pal.sun_bottom, 40));
	}
}

static void sun_row(uint32_t *row, float dy)
{
	float r = bg.sun_r;
	uint32_t c;

	/* Retro stripes, getting thicker towards the bottom of the disc */
	if (dy > -0.25f * r) {
		float k = (dy + 0.25f * r) / (1.25f * r) * 7.0f;
		int band = (int)k;

		if (k - (float)band > 0.86f - 0.075f * (float)band) {
			return;
		}
	}

	c = gfx_mixf(bg.pal.sun_top, bg.pal.sun_bottom, (dy + r) / (2.0f * r));
	span_row(row, bg.sun_x, sqrtf(r * r - dy * dy), c);
}

static void mountain_row(uint32_t *row, int y, const int16_t *top, float hmax, uint32_t color)
{
	float up = bg.hy - (float)y - 0.5f; /* height above the horizon */
	uint32_t base, rim;

	if (up < 0.0f || up > hmax) {
		return;
	}

	base = gfx_mixf(color, bg.pal.sky_horizon, 0.35f * (1.0f - up / hmax));
	rim = gfx_mixf(color, bg.pal.rim, 0.6f);

	for (int x = 0; x < log_w; x++) {
		if (y >= top[x]) {
			row[x] = (y == top[x]) ? rim : base;
		}
	}
}

/* First mountain row of each column, from the skyline height map */
static void mountain_tops(int16_t *top, const uint8_t *map, int off, float hmax)
{
	for (int x = 0; x < log_w; x++) {
		float h = (float)map[(x + off) & (MTN_SIZE - 1)] * hmax / 255.0f;

		top[x] = (int16_t)-ifloor(h + 0.5f - bg.hy);
	}
}

static void sky_row(uint32_t *row, int y)
{
	float yc = (float)y + 0.5f;
	float t = yc / bg.hy;
	float dy = yc - bg.sun_y;
	uint32_t c;

	c = t < 0.55f ? gfx_mixf(bg.pal.sky_top, bg.pal.sky_mid, t / 0.55f)
		      : gfx_mixf(bg.pal.sky_mid, bg.pal.sky_horizon, (t - 0.55f) / 0.45f);
	fill_row(row, 0, log_w, c);

	if (fabsf(dy) < bg.sun_r * 1.75f) {
		halo_row(row, dy, c);
	}

	/* Stars shine through the glow, the disc hides them */
	while (bg.star_idx < STAR_COUNT && stars[bg.star_idx].y < y) {
		bg.star_idx++;
	}
	for (int i = bg.star_idx; i < STAR_COUNT && stars[i].y == y; i++) {
		float tw = 0.65f + 0.35f * sinf(bg.time * 3.0f + (float)i);
		uint32_t a = (uint32_t)((float)stars[i].level * tw * (0.2f + 0.8f * bg.night));

		row[stars[i].x] = gfx_add(row[stars[i].x], 0xffffffU, a);
	}

	if (fabsf(dy) < bg.sun_r) {
		sun_row(row, dy);
	}

	mountain_row(row, y, mtn_far_top, bg.mtn_far_h, bg.pal.mtn_far);
	mountain_row(row, y, mtn_near_top, bg.mtn_near_h, bg.pal.mtn_near);
}

static void ground_row(uint32_t *row, int y)
{
	float dy = (float)y + 0.5f - bg.hy;
	float zc = bg.cam_h * bg.f / dy;
	float z_far = bg.cam_h * bg.f / MAX(dy - 0.5f, 0.05f);
	float z_near = bg.cam_h * bg.f / (dy + 0.5f);
	float fog = clampf((zc - FOG_START) / (FOG_END - FOG_START), 0.0f, 1.0f);
	float glow = clampf(1.0f - dy / ((float)log_h * 0.2f), 0.0f, 1.0f);
	float dwx = zc / bg.f;
	float x_left, inv, xa;
	uint32_t base, line;
	int first, last;

	base = gfx_mixf(bg.pal.ground, bg.pal.glow, glow * glow);
	base = gfx_mixf(base, bg.pal.sky_horizon, fog * fog * 0.8f);
	line = gfx_mixf(bg.pal.grid, bg.pal.sky_horizon, fog * 0.85f);

	if (dy < 1.0f) {
		/* Hot horizon line */
		fill_row(row, 0, log_w, gfx_add(line, bg.pal.sky_horizon, 160));
		return;
	}

	if (z_far - z_near > GRID_Z || dwx > 0.9f) {
		fill_row(row, 0, log_w, gfx_mix(base, line, 96));
		return;
	}

	if (floorf((bg.cam_z + z_far + GRID_LINE) / GRID_Z) !=
	    floorf((bg.cam_z + z_near - GRID_LINE) / GRID_Z)) {
		fill_row(row, 0, log_w, line);
		return;
	}

	x_left = bg.cam_x - bg.cx * dwx;

	if (GRID_X < 6.0f * dwx) {
		/* Lines a few pixels apart: test the world x interval under each pixel */
		int32_t a = (int32_t)((x_left - GRID_LINE) * 65536.0f);
		int32_t b = a + (int32_t)((dwx + 2.0f * GRID_LINE) * 65536.0f);
		int32_t step = (int32_t)(dwx * 65536.0f);

		for (int x = 0; x < log_w; x++) {
			row[x] = ((a >> GRID_X_SHIFT) != (b >> GRID_X_SHIFT)) ? line : base;
			a += step;
			b += step;
		}
		return;
	}

	/* Lines far apart: fill the row, then draw each line as a span */
	fill_row(row, 0, log_w, base);

	inv = 1.0f / dwx;
	first = ifloor((x_left - GRID_LINE) / GRID_X);
	last = ifloor((x_left + (float)log_w * dwx + GRID_LINE) / GRID_X);
	xa = ((float)first * GRID_X - GRID_LINE - x_left) * inv;

	for (int n = first; n <= last; n++, xa += GRID_X * inv) {
		fill_row(row, ifloor(xa), ifloor(xa + 2.0f * GRID_LINE * inv) + 1, line);
	}
}

static bool project(float x, float y, float z, float *sx, float *sy, float *s)
{
	float dz = z - bg.cam_z;

	if (dz < 0.35f) {
		return false;
	}
	*s = bg.f / dz;
	*sx = bg.cx + (x - bg.cam_x) * *s;
	*sy = bg.hy + (bg.cam_h - y) * *s;

	return true;
}

static uint32_t fogged(uint32_t c, float dz)
{
	return gfx_mixf(c, bg.pal.sky_horizon, 0.85f * clampf((dz - FOG_START) /
							      (FOG_END - FOG_START), 0.0f, 1.0f));
}

static void draw_gate(const struct game *g, const struct gate *gt, bool next)
{
	float sx, sy, s, hp, t, pw, ground;
	uint32_t c = (gt->index & 1U) != 0U ? 0x00aeffU : 0xaf7fe4U;
	enum gfx_blend blend;
	uint8_t alpha;
	float dz = gt->z - bg.cam_z;

	/* Gates fade out before reaching the camera, where they would cover the screen */
	if (dz < 1.2f || dz > FOG_END + 10.0f || !project(gt->x, gt->y, gt->z, &sx, &sy, &s)) {
		return;
	}

	switch (gt->state) {
	case GATE_PASSED:
		c = gfx_mixf(c, 0xffffffU, 0.4f + gt->flash);
		break;
	case GATE_PERFECT:
		c = gfx_mixf(0xffd94aU, 0xffffffU, gt->flash);
		break;
	case GATE_MISSED:
		c = 0xff3050U;
		break;
	default:
		if (next) {
			c = gfx_mixf(c, 0xffffffU, 0.35f + 0.25f * sinf(g->time * 12.0f));
		}
		break;
	}
	c = fogged(c, dz);

	hp = gt->half * s;
	t = MAX(1.0f, GATE_BAR * s);
	pw = MAX(1.0f, 0.07f * s);
	ground = bg.hy + bg.cam_h * s;
	alpha = (uint8_t)(255.0f * clampf((dz - 0.6f) / 3.0f, 0.0f, 1.0f));
	blend = alpha == 255U ? GFX_SOLID : GFX_ALPHA;

	/* Stand poles, then the frame */
	gfx_rect(sx - hp + t * 0.5f - pw * 0.5f, sy + hp, sx - hp + t * 0.5f + pw * 0.5f, ground,
		 gfx_mix(c, 0x000000U, 140), blend, alpha);
	gfx_rect(sx + hp - t * 0.5f - pw * 0.5f, sy + hp, sx + hp - t * 0.5f + pw * 0.5f, ground,
		 gfx_mix(c, 0x000000U, 140), blend, alpha);

	if (next) {
		/* A one pixel outline, solid fills cost a fraction of blended ones */
		uint32_t o = gfx_mix(c, 0xffffffU, 140);

		gfx_rect(sx - hp - 1.0f, sy - hp - 1.0f, sx + hp + 1.0f, sy - hp, o, GFX_SOLID,
			 255);
		gfx_rect(sx - hp - 1.0f, sy + hp, sx + hp + 1.0f, sy + hp + 1.0f, o, GFX_SOLID,
			 255);
		gfx_rect(sx - hp - 1.0f, sy - hp, sx - hp, sy + hp, o, GFX_SOLID, 255);
		gfx_rect(sx + hp, sy - hp, sx + hp + 1.0f, sy + hp, o, GFX_SOLID, 255);
	}

	gfx_rect(sx - hp, sy - hp, sx + hp, sy - hp + t, c, blend, alpha);
	gfx_rect(sx - hp, sy + hp - t, sx + hp, sy + hp, c, blend, alpha);
	gfx_rect(sx - hp, sy - hp + t, sx - hp + t, sy + hp - t, c, blend, alpha);
	gfx_rect(sx + hp - t, sy - hp + t, sx + hp, sy + hp - t, c, blend, alpha);
}

static void draw_bug(const struct game *g, const struct bug *b)
{
	float sx, sy, s, w, h;
	float dz = b->z - bg.cam_z;

	if (b->splat > 0.0f || !project(b->x, b->y, b->z, &sx, &sy, &s)) {
		return;
	}

	w = 0.95f * s;
	h = w * 14.0f / 16.0f;
	gfx_sprite(sx - w * 0.5f, sy - h * 0.5f, w, h, &bug_sprite,
		   (uint8_t)((int)(g->time * 10.0f) & 1), bg.pal.sky_horizon,
		   (uint8_t)(220.0f * clampf((dz - FOG_START) / (FOG_END - FOG_START), 0.0f,
					     1.0f)));
}

static void draw_particle(const struct particle *p, int idx)
{
	float sx, sy, s, sx2, sy2, s2, r;
	float life = p->life / p->max_life;
	float v[6];

	if (!project(p->x, p->y, p->z, &sx, &sy, &s)) {
		return;
	}

	switch (p->kind) {
	case PARTICLE_STREAK:
		if (project(p->x, p->y, p->z + p->size, &sx2, &sy2, &s2)) {
			gfx_line(sx, sy, sx2, sy2, p->color, GFX_ADD,
				 (uint8_t)(140.0f * MIN(life * 2.0f, 1.0f)));
		}
		break;
	case PARTICLE_CONFETTI: {
		float a = p->life * 9.0f + (float)idx;
		float near = clampf((p->z - bg.cam_z - 0.5f) / 2.5f, 0.0f, 1.0f);

		life = MIN(life * 3.0f, 1.0f) * near;
		r = clampf(p->size * s, 1.5f, 6.0f);
		v[0] = sx + cosf(a) * r;
		v[1] = sy + sinf(a) * r;
		v[2] = sx + cosf(a + 2.3f) * r;
		v[3] = sy + sinf(a + 2.3f) * r * 0.6f;
		v[4] = sx + cosf(a + 4.1f) * r;
		v[5] = sy + sinf(a + 4.1f) * r;
		gfx_tri(v, p->color, GFX_ALPHA, (uint8_t)(255.0f * life));
		break;
	}
	default:
		r = clampf(p->size * s, 0.5f, 4.0f);
		gfx_rect(sx - r, sy - r, sx + r, sy + r, p->color, GFX_ADD,
			 (uint8_t)(255.0f * life));
		break;
	}
}

static void draw_kite(const struct game *g, float *ksx, float *ksy)
{
	const struct kite *k = &g->kite;
	struct kite_pose pose = {0};
	float sx, sy, s, gx, gy, gs;
	float roll = 0.0f;

	if (!project(k->x, k->y, k->z, &sx, &sy, &s)) {
		return;
	}
	*ksx = sx;
	*ksy = sy;

	/* Ground shadow helps judging the height against the gates */
	if (project(k->x, 0.0f, k->z, &gx, &gy, &gs)) {
		gfx_ellipse(gx, gy, 0.5f * gs, 0.13f * gs, 0x000000U, GFX_ALPHA, 120);
	}


	if (k->roll_t > 0.0f) {
		float u = 1.0f - k->roll_t / GAME_ROLL_DURATION;

		roll = k->roll_dir * 6.2832f * (u * u * (3.0f - 2.0f * u));
	}

	pose.x = sx;
	pose.y = sy;
	pose.scale = s * KITE_WORLD_W / KITE_BODY_WIDTH;
	pose.angle = k->bank + roll;
	pose.time = g->time;
	pose.swing = clampf(k->vx / 10.0f, -1.0f, 1.0f);
	pose.flutter = 8.0f + 12.0f * game_speed_ratio(g);

	if (k->hit_t > 0.0f && ((int)(k->hit_t * 16.0f) & 1) != 0) {
		pose.tint = 0xff2040U;
		pose.tint_amount = 170;
	} else if (g->phase == PHASE_GAME_OVER) {
		pose.tint = 0x3a2d52U;
		pose.tint_amount = (uint8_t)(160.0f * clampf(g->phase_t, 0.0f, 1.0f));
	} else if (g->combo >= 3U) {
		/* The kite lights up as the combo grows */
		pose.tint = 0xd8f4ffU;
		pose.tint_amount = (uint8_t)MIN(90U, 6U * g->combo);
	}

	kite_draw(&pose);
}

/* Where the kite crosses the next gate plane if it keeps its course */
static void draw_aim(const struct game *g, const struct gate *gt)
{
	const struct kite *k = &g->kite;
	float eta, lead, ax, ay, sx, sy, s, r, inner, dx, dy;
	uint32_t c = 0xffffffU;

	if (gt == NULL || g->phase == PHASE_GAME_OVER) {
		return;
	}

	eta = (gt->z - k->z) / MAX(k->speed, 1.0f);
	lead = MIN(eta, 0.3f);
	ax = k->x + k->vx * lead;
	ay = k->y + k->vy * lead;
	if (!project(ax, ay, gt->z, &sx, &sy, &s)) {
		return;
	}

	dx = ax - gt->x;
	dy = ay - gt->y;
	inner = gt->half - GATE_BAR * 0.5f;
	if (dx * dx + dy * dy < gt->half * gt->half * 0.12f) {
		c = 0xffd94aU;
	} else if (fabsf(dx) < inner && fabsf(dy) < inner) {
		c = 0x7dff9aU;
	}

	r = MAX(3.0f, 0.22f * s);
	gfx_line(sx - r, sy, sx, sy - r, c, GFX_ADD, 200);
	gfx_line(sx, sy - r, sx + r, sy, c, GFX_ADD, 200);
	gfx_line(sx + r, sy, sx, sy + r, c, GFX_ADD, 200);
	gfx_line(sx, sy + r, sx - r, sy, c, GFX_ADD, 200);
	gfx_rect(sx - 0.5f, sy - 0.5f, sx + 0.5f, sy + 0.5f, c, GFX_SOLID, 255);
}

static bool blink(const struct game *g, float hz)
{
	return ((int)(g->time * hz * 2.0f) & 1) == 0;
}

static const char *const ordinals[] = {
	"1ST", "2ND", "3RD", "4TH", "5TH", "6TH", "7TH", "8TH",
};

BUILD_ASSERT(ARRAY_SIZE(ordinals) == GAME_HIGH_SCORES);

/* Each row of the high score table gets its own colors, top and bottom of the glyphs */
static const uint32_t score_colors[][2] = {
	{0xfff3a0U, 0xffb02eU}, {0xffb0e8U, 0xff3d8bU}, {0xd8b8ffU, 0xaf7fe4U},
	{0x9ad8ffU, 0x00aeffU}, {0xb8f4ffU, 0x45c8ffU}, {0xc8ffe8U, 0x2dffb3U},
	{0xfff8c8U, 0xffd94aU}, {0xffd0a8U, 0xff6a1fU},
};

BUILD_ASSERT(ARRAY_SIZE(score_colors) == GAME_HIGH_SCORES);

#define TABLE_ROW_H  17.0f
#define TABLE_HALF_W 132.0f

/* Rows are "1ST  ZEP   48250   9" at scale 2, the header lines up with the columns */
static void draw_scores(const struct game *g, float y, int highlight)
{
	float cx = (float)log_w / 2.0f;
	float x0 = cx - (float)gfx_text_width("1ST  ZEP  999999  99", 2) / 2.0f;
	float bottom;
	char text[32];
	int rows = 0;

	while (rows < GAME_HIGH_SCORES && g->scores[rows].score > 0U) {
		rows++;
	}

	gfx_text_centered(cx, y, 3, "HIGH SCORES", 0xfff3a0U, 0xff3d8bU, 255, 0x0b0322U);
	y += 28.0f;
	bottom = y + 16.0f + (float)rows * TABLE_ROW_H;

	gfx_rect(cx - TABLE_HALF_W, y, cx + TABLE_HALF_W, bottom, 0x0b0322U, GFX_ALPHA, 150);
	gfx_rect(cx - TABLE_HALF_W, y - 1.0f, cx + TABLE_HALF_W, y, 0xff3d8bU, GFX_SOLID, 255);
	gfx_rect(cx - TABLE_HALF_W, bottom, cx + TABLE_HALF_W, bottom + 1.0f, 0xff3d8bU, GFX_SOLID,
		 255);

	gfx_text(x0, y + 4.0f, 1, "RANK", 0xb1e4faU, 0x7fa8d8U, 255);
	gfx_text(x0 + 60.0f, y + 4.0f, 1, "NAME", 0xb1e4faU, 0x7fa8d8U, 255);
	gfx_text(x0 + 190.0f - (float)gfx_text_width("SCORE", 1), y + 4.0f, 1, "SCORE",
		 0xb1e4faU, 0x7fa8d8U, 255);
	gfx_text(x0 + 238.0f - (float)gfx_text_width("LV", 1), y + 4.0f, 1, "LV", 0xb1e4faU,
		 0x7fa8d8U, 255);

	for (int i = 0; i < rows; i++) {
		const struct high_score *hs = &g->scores[i];
		float ry = y + 16.0f + (float)i * TABLE_ROW_H;
		float hw = TABLE_HALF_W - 4.0f;
		uint32_t top = score_colors[i][0];
		uint32_t bot = score_colors[i][1];

		if (i == highlight) {
			if (blink(g, 3.0f)) {
				gfx_rect(cx - hw, ry - 2.0f, cx + hw, ry + 16.0f, 0xffffffU,
					 GFX_ALPHA, 60);
				top = 0xffffffU;
				bot = 0xfff3a0U;
			}
			gfx_text(x0 - 13.0f, ry, 2, ">", 0xffffffU, 0xffd94aU, 255);
		}

		snprintf(text, sizeof(text), "%s  %.3s  %6u  %2u", ordinals[i], hs->name, hs->score,
			 hs->level);
		gfx_text(x0 + 1.0f, ry + 1.0f, 2, text, 0x0b0322U, 0x0b0322U, 190);
		gfx_text(x0, ry, 2, text, top, bot, 255);
	}
}

/* Three big letters, arrows around the one being edited */
static void draw_entry(const struct game *g, float y, uint32_t top, uint32_t bottom, bool mask)
{
	const struct letter_entry *e = &g->entry;
	float cx = (float)log_w / 2.0f;
	char ch[2] = {0};

	/* The kite glides down right behind the letters */
	gfx_rect(cx - 72.0f, y - 22.0f, cx + 72.0f, y + 64.0f, 0x0b0322U, GFX_ALPHA, 150);
	gfx_rect(cx - 72.0f, y - 23.0f, cx + 72.0f, y - 22.0f, 0xff3d8bU, GFX_SOLID, 255);
	gfx_rect(cx - 72.0f, y + 64.0f, cx + 72.0f, y + 65.0f, 0xff3d8bU, GFX_SOLID, 255);

	for (int i = 0; i < GAME_NAME_LEN; i++) {
		float x = cx + (float)(i - 1) * 46.0f;
		bool active = i == e->pos;
		uint32_t line = active ? (blink(g, 2.0f) ? 0xffffffU : 0xffd94aU) : 0xaf7fe4U;

		ch[0] = (mask && i < e->pos) ? '*' : e->text[i];
		if (active) {
			float up[6] = {x - 8.0f, y - 9.0f, x + 8.0f, y - 9.0f, x, y - 17.0f};
			float down[6] = {x - 8.0f, y + 51.0f, x + 8.0f, y + 51.0f, x, y + 59.0f};

			gfx_tri(up, 0xffffffU, GFX_SOLID, 255);
			gfx_tri(down, 0xffffffU, GFX_SOLID, 255);
			gfx_text_centered(x, y, 6, ch, 0xffffffU, 0xffd94aU, 255, 0x0b0322U);
		} else {
			gfx_text_centered(x, y, 6, ch, top, bottom, 255, 0x0b0322U);
		}
		gfx_rect(x - 16.0f, y + 46.0f, x + 16.0f, y + 48.0f, line, GFX_SOLID, 255);
	}
}

static void draw_entry_timer(const struct game *g)
{
	char text[8];
	int left = (int)ceilf(g->entry.time_left);

	snprintf(text, sizeof(text), "%d", left);
	gfx_text((float)(log_w - gfx_text_width(text, 2) - 6), 6.0f, 2, text, 0xffffffU,
		 left <= 5 ? 0xff2040U : 0xff3d8bU, 255);
}

/* Prompts in the words of the controls in use */
struct control_words {
	const char *fly;
	const char *retry;
	const char *letter;
	const char *next;
	const char *confirm;
	const char *cancel;
};

static const struct control_words control_words[] = {
	[CONTROL_RC] = {
		.fly = "THROTTLE UP TO FLY!",
		.retry = "THROTTLE UP TO RETRY",
		.letter = "STICK UP/DOWN: LETTER",
		.next = "RIGHT: NEXT    LEFT: BACK",
		.confirm = "RIGHT ON THE LAST LETTER: CONFIRM",
		.cancel = "LEFT ON THE FIRST LETTER: CANCEL",
	},
	[CONTROL_KEYS] = {
		.fly = "PRESS TO FLY!",
		.retry = "PRESS TO RETRY",
		.letter = "UP/DOWN: LETTER",
		.next = "RIGHT: NEXT    LEFT: BACK",
		.confirm = "RIGHT ON THE LAST LETTER: CONFIRM",
		.cancel = "LEFT ON THE FIRST LETTER: CANCEL",
	},
	[CONTROL_TOUCH] = {
		.fly = "TAP TO FLY!",
		.retry = "TAP TO RETRY",
		.letter = "SWIPE UP/DOWN: LETTER",
		.next = "TAP RIGHT: NEXT    LEFT: BACK",
		.confirm = "TAP RIGHT ON THE LAST LETTER: CONFIRM",
		.cancel = "TAP LEFT ON THE FIRST LETTER: CANCEL",
	},
};

static void draw_prompt(const struct game *g, const struct controls *ctl, float y)
{
	const char *text;

	if (!ctl->valid) {
		text = "WAITING FOR RC LINK";
	} else if (!g->armed) {
		text = "THROTTLE DOWN TO ARM";
	} else {
		text = control_words[ctl->source].fly;
	}
	if (blink(g, 1.0f)) {
		gfx_text_centered((float)log_w / 2.0f, y, 2, text, 0xffffffU, 0xffd94aU, 255,
				  0x0b0322U);
	}
}

static void draw_overlay(const struct game *g, const struct controls *ctl)
{
	const struct control_words *words = &control_words[ctl->source];
	float cx = (float)log_w / 2.0f;
	float h = (float)log_h;
	const char *msg;
	char text[32];

	switch (g->phase) {
	case PHASE_ATTRACT: {
		float bob = 2.0f * sinf(g->time * 2.0f);
		int big = log_w >= 300 ? 5 : 4;

		if (g->show_scores) {
			draw_scores(g, h * 0.04f, -1);
			draw_prompt(g, ctl, h * 0.84f);
			break;
		}

		gfx_text_centered(cx, h * 0.07f + bob, 2, "ZEPHYR", 0xffffffU, 0xb1e4faU, 255,
				  0x0b0322U);
		gfx_text_centered(cx, h * 0.07f + 20.0f + bob, big, "KITE RUSH", 0xfff3a0U,
				  0xff3d8bU, 255, 0x0b0322U);
		draw_prompt(g, ctl, h * 0.84f);
		if (g->best > 0U) {
			snprintf(text, sizeof(text), "HIGH SCORE %u %.3s", g->best,
				 g->scores[0].name);
			gfx_text_centered(cx, h * 0.93f, 1, text, 0xb1e4faU, 0xb1e4faU, 255,
					  0x0b0322U);
		}
		break;
	}

	case PHASE_COUNTDOWN: {
		int n = 3 - (int)g->phase_t;
		float pop = g->phase_t - floorf(g->phase_t);

		snprintf(text, sizeof(text), "%d", MAX(n, 1));
		gfx_text_centered(cx, h * 0.12f, pop < 0.15f ? 10 : 8, text, 0xffffffU, 0xffd94aU,
				  255, 0x0b0322U);
		break;
	}

	case PHASE_FLYING:
		if (g->phase_t < 0.8f) {
			gfx_text_centered(cx, h * 0.12f, 8, "GO!", 0xfff3a0U, 0xff3d8bU,
					  (uint8_t)(255.0f * (1.0f - g->phase_t / 0.8f)),
					  0x0b0322U);
		}
		if (g->level_banner > 0.0f) {
			snprintf(text, sizeof(text), "LEVEL %u", g->level);
			gfx_text_centered(cx, h * 0.1f, 4, text, 0xfff3a0U, 0xffd94aU,
					  (uint8_t)(255.0f * MIN(1.0f, g->level_banner * 2.0f)),
					  0x0b0322U);
		}
		break;

	case PHASE_SIGNAL_LOST:
		if (blink(g, 1.5f)) {
			gfx_text_centered(cx, h * 0.3f, 3, "SIGNAL LOST", 0xff6070U, 0xff2040U, 255,
					  0x0b0322U);
		}
		gfx_text_centered(cx, h * 0.3f + 30.0f, 1, "CHECK THE RC LINK", 0xffffffU,
				  0xffffffU, 255, 0x0b0322U);
		break;

	case PHASE_GAME_OVER:
		if (g->ranked && g->rank >= 0) {
			draw_scores(g, h * 0.04f, g->rank);
		} else if (g->phase_t > 0.4f) {
			gfx_text_centered(cx, h * 0.12f, 4, "GAME OVER", 0xffffffU, 0xaf7fe4U, 255,
					  0x0b0322U);
			snprintf(text, sizeof(text), "%u", g->score);
			gfx_text_centered(cx, h * 0.12f + 38.0f, 4, text, 0xfff3a0U, 0xff3d8bU, 255,
					  0x0b0322U);
			snprintf(text, sizeof(text), "GATES %u  LEVEL %u", g->gates_passed,
				 g->level);
			gfx_text_centered(cx, h * 0.12f + 74.0f, 1, text, 0xb1e4faU, 0xb1e4faU, 255,
					  0x0b0322U);
			if (g->rank >= 0 && g->phase_t > 0.8f && blink(g, 2.0f)) {
				msg = g->new_best ? "NEW BEST!" : "HIGH SCORE!";
				gfx_text_centered(cx, h * 0.12f + 90.0f, 2, msg, 0xffd94aU,
						  0xff8a3dU, 255, 0x0b0322U);
			}
		}
		if ((g->ranked || g->rank < 0) && g->phase_t > 2.5f && blink(g, 1.0f)) {
			gfx_text_centered(cx, h * 0.86f, 2,
					  g->armed ? words->retry : "THROTTLE DOWN",
					  0xffffffU, 0xffd94aU, 255, 0x0b0322U);
		}
		break;

	case PHASE_NAME_ENTRY:
		msg = g->new_best ? "NEW BEST SCORE!" : "NEW HIGH SCORE!";
		gfx_text_centered(cx, h * 0.05f, 3, msg, 0xffd94aU, 0xff8a3dU, 255, 0x0b0322U);
		snprintf(text, sizeof(text), "%s PLACE  %u", ordinals[g->rank], g->score);
		gfx_text_centered(cx, h * 0.05f + 30.0f, 2, text, 0xffffffU, 0xb1e4faU, 255,
				  0x0b0322U);
		gfx_text_centered(cx, h * 0.05f + 52.0f, 1, "ENTER YOUR NAME", 0xb1e4faU, 0xb1e4faU,
				  255, 0x0b0322U);
		draw_entry(g, h * 0.44f, 0xfff3a0U, 0xff3d8bU, false);
		gfx_text_centered(cx, h * 0.8f, 1, words->letter, 0xffffffU, 0xd8c8ffU, 255,
				  0x0b0322U);
		gfx_text_centered(cx, h * 0.8f + 11.0f, 1, words->next, 0xffffffU, 0xd8c8ffU, 255,
				  0x0b0322U);
		draw_entry_timer(g);
		break;

	case PHASE_RESET_CODE:
		if (g->entry.result == RESET_CLEARED) {
			gfx_text_centered(cx, h * 0.35f, 3, "SCORES RESET", 0x9affc0U, 0x2dffb3U,
					  255, 0x0b0322U);
			break;
		}
		if (g->entry.result == RESET_WRONG_CODE) {
			gfx_text_centered(cx, h * 0.35f, 3, "WRONG CODE", 0xff8a9aU, 0xff2040U, 255,
					  0x0b0322U);
			break;
		}
		gfx_text_centered(cx, h * 0.06f, 2, "OPERATOR MENU", 0xb1e4faU, 0x45c8ffU, 255,
				  0x0b0322U);
		gfx_text_centered(cx, h * 0.06f + 22.0f, 3, "RESET SCORES", 0xff8a9aU, 0xff2040U,
				  255, 0x0b0322U);
		gfx_text_centered(cx, h * 0.06f + 54.0f, 1, "ENTER THE CODE", 0xffffffU, 0xffffffU,
				  255, 0x0b0322U);
		draw_entry(g, h * 0.45f, 0xffffffU, 0xb1e4faU, true);
		gfx_text_centered(cx, h * 0.8f, 1, words->confirm, 0xffffffU, 0xd8c8ffU, 255,
				  0x0b0322U);
		gfx_text_centered(cx, h * 0.8f + 11.0f, 1, words->cancel, 0xffffffU, 0xd8c8ffU, 255,
				  0x0b0322U);
		draw_entry_timer(g);
		break;
	}

	if (g->retro_banner > 0.0f) {
		uint8_t alpha = (uint8_t)(255.0f * MIN(1.0f, g->retro_banner * 2.0f));
		float half;

		msg = g->retro ? "RETRO MODE" : "RETRO MODE OFF";
		half = (float)gfx_text_width(msg, 3) / 2.0f + 8.0f;
		gfx_rect(cx - half, h * 0.6f - 7.0f, cx + half, h * 0.6f + 28.0f, 0x081820U,
			 GFX_ALPHA, alpha);
		gfx_text_centered(cx, h * 0.6f, 3, msg, 0xe0f8d0U, 0x88c070U, alpha, 0U);
	}
}

struct obj {
	float dz;
	uint8_t type;
	uint8_t idx;
};

enum {
	OBJ_GATE,
	OBJ_BUG,
	OBJ_PARTICLE,
	OBJ_KITE,
};

static struct obj objs[GAME_MAX_GATES + GAME_MAX_BUGS + GAME_MAX_PARTICLES + 1];

static void build_scene(const struct game *g, const struct controls *ctl)
{
	const struct gate *next = NULL;
	float sun_frac, kite_sx = 0.0f, kite_sy = 0.0f;
	int level_idx = (g->level - 1) % (int)ARRAY_SIZE(palettes);
	int prev_idx = (g->level + (int)ARRAY_SIZE(palettes) - 2) % (int)ARRAY_SIZE(palettes);
	struct palette lvl;
	float shake_x = 0.0f, shake_y = 0.0f;
	int n = 0;

	if (g->shake > 0.0f) {
		uint32_t h = hash32((uint32_t)(g->time * 1000.0f));

		shake_x = g->shake * ((float)(h & 0xffU) / 127.5f - 1.0f);
		shake_y = g->shake * ((float)((h >> 8) & 0xffU) / 127.5f - 1.0f);
	}

	bg.time = g->time;
	bg.f = (float)log_h * FOCAL_RATIO;
	bg.hy = (float)log_h * HORIZON_RATIO + shake_y;
	bg.cx = (float)log_w / 2.0f + shake_x;
	bg.cam_x = g->cam_x;
	bg.cam_h = g->cam_y;
	bg.cam_z = g->cam_z;

	sun_frac = clampf(g->sun_display / GAME_SUN_MAX, 0.0f, 1.0f);
	bg.night = clampf(1.0f - sun_frac / 0.4f, 0.0f, 1.0f);
	bg.night = bg.night * sqrtf(bg.night);

	if (g->level > 1U && g->level_blend < 1.0f) {
		mix_palette(&lvl, &palettes[prev_idx], &palettes[level_idx], g->level_blend);
	} else {
		lvl = palettes[level_idx];
	}
	mix_palette(&bg.pal, &lvl, &night, bg.night * 0.85f);
	if (g->flash > 0.0f) {
		/* Flash the world through its colors rather than blending every pixel */
		static const struct palette white = {
			0xffffffU, 0xffffffU, 0xffffffU, 0xffffffU, 0xffffffU, 0xffffffU,
			0xffffffU, 0xffffffU, 0xffffffU, 0xffffffU, 0xffffffU,
		};

		mix_palette(&bg.pal, &bg.pal, &white, 0.5f * MIN(g->flash, 1.0f));
	}

	bg.sun_r = (float)log_h * 0.2f;
	bg.sun_x = bg.cx - g->cam_x * 2.0f;
	bg.sun_y = bg.hy + bg.sun_r * 1.1f - sun_frac * (bg.sun_r * 2.1f + bg.hy * 0.3f);

	bg.mtn_far_h = (float)log_h * 0.15f;
	bg.mtn_near_h = (float)log_h * 0.09f;
	bg.mtn_far_off = (int)(g->cam_x * 3.0f) + 1000 * MTN_SIZE;
	bg.mtn_near_off = (int)(g->cam_x * 7.0f) + 1000 * MTN_SIZE + 137;
	bg.star_idx = 0;
	mountain_tops(mtn_far_top, mtn_far, bg.mtn_far_off, bg.mtn_far_h);
	mountain_tops(mtn_near_top, mtn_near, bg.mtn_near_off, bg.mtn_near_h);

	gfx_begin(log_w, log_h);

	/* Depth sort everything that lives in the world, far to near */
	for (int i = 0; i < GAME_MAX_GATES; i++) {
		const struct gate *gt = &g->gates[i];

		if (gt->state == GATE_PENDING && gt->z > g->kite.z &&
		    (next == NULL || gt->z < next->z)) {
			next = gt;
		}
		objs[n++] = (struct obj){gt->z - bg.cam_z, OBJ_GATE, (uint8_t)i};
	}
	for (int i = 0; i < GAME_MAX_BUGS; i++) {
		if (g->bugs[i].active) {
			objs[n++] = (struct obj){g->bugs[i].z - bg.cam_z, OBJ_BUG, (uint8_t)i};
		}
	}
	for (int i = 0; i < GAME_MAX_PARTICLES; i++) {
		if (g->particles[i].life > 0.0f) {
			objs[n++] = (struct obj){g->particles[i].z - bg.cam_z, OBJ_PARTICLE,
						 (uint8_t)i};
		}
	}
	objs[n++] = (struct obj){g->kite.z - bg.cam_z, OBJ_KITE, 0};

	for (int i = 1; i < n; i++) {
		struct obj o = objs[i];
		int j = i;

		while (j > 0 && objs[j - 1].dz < o.dz) {
			objs[j] = objs[j - 1];
			j--;
		}
		objs[j] = o;
	}

	for (int i = 0; i < n; i++) {
		switch (objs[i].type) {
		case OBJ_GATE:
			draw_gate(g, &g->gates[objs[i].idx], &g->gates[objs[i].idx] == next);
			break;
		case OBJ_BUG:
			draw_bug(g, &g->bugs[objs[i].idx]);
			break;
		case OBJ_PARTICLE:
			draw_particle(&g->particles[objs[i].idx], objs[i].idx);
			break;
		default:
			draw_kite(g, &kite_sx, &kite_sy);
			break;
		}
	}

	if (g->phase == PHASE_FLYING || g->phase == PHASE_COUNTDOWN) {
		draw_aim(g, next);
	}

	for (int i = 0; i < GAME_MAX_POPUPS; i++) {
		const struct popup *pp = &g->popups[i];

		if (pp->life > 0.0f) {
			gfx_text_centered(kite_sx + pp->dx, kite_sy - 24.0f + pp->dy, pp->scale,
					  pp->text, pp->color, gfx_mix(pp->color, 0xff3d8bU, 90),
					  (uint8_t)(255.0f * MIN(1.0f, pp->life * 2.5f)),
					  0x0b0322U);
		}
	}

	draw_overlay(g, ctl);

	gfx_end();
}

void render_take_stats(struct render_stats *out)
{
	*out = stats;
	memset(&stats, 0, sizeof(stats));
}

/* Four shades of green, darkest first */
static const uint32_t retro_shades[] = {0x081820U, 0x346856U, 0x88c070U, 0xe0f8d0U};

static uint32_t retro_bg[ROW_MAX];

/* Luminance to four shades, on blocks of step pixels */
static void retro_row(uint32_t *row, int step)
{
	for (int x = 0; x < log_w; x += step) {
		uint32_t c = row[x];
		uint32_t l = (((c >> 16) & 0xffU) * 77U + ((c >> 8) & 0xffU) * 150U +
			      (c & 0xffU) * 29U) >> 8;
		uint32_t shade = retro_shades[l >> 6];

		row[x] = shade;
		if (step > 1 && x + 1 < log_w) {
			row[x + 1] = shade;
		}
	}
}

static void background_row(uint32_t *row, int y)
{
	if ((float)y < bg.hy - 0.5f) {
		sky_row(row, y);
	} else {
		ground_row(row, y);
	}
}

void render_frame(const struct game *g, const struct controls *ctl)
{
	int last_y = log_h - 1;
	int retro_y = -1; /* logical row held in retro_bg */
	uint32_t t0 = prof_now();
	uint32_t t1, waited;

	build_scene(g, ctl);
	t1 = prof_now();
	stats.scene += t1 - t0;

	if (IS_ENABLED(CONFIG_KITE_RUSH_INTERLACE)) {
		field ^= 1U;
		if (((unsigned int)last_y & 1U) != field) {
			last_y--;
		}
	}

	for (int y = 0; y <= last_y; y++) {
		uint8_t *dst;

		if (IS_ENABLED(CONFIG_KITE_RUSH_INTERLACE) && ((unsigned int)y & 1U) != field) {
			continue;
		}

		t0 = prof_now();
		if (g->retro) {
			/* Chunky background, drawn on every other row, shapes at full resolution */
			if ((y & ~1) != retro_y) {
				retro_y = y & ~1;
				background_row(retro_bg, retro_y);
				retro_row(retro_bg, 2);
			}
			memcpy(row_buf, retro_bg, (size_t)log_w * sizeof(row_buf[0]));
		} else {
			background_row(row_buf, y);
		}
		t1 = prof_now();
		stats.background += t1 - t0;
		gfx_draw_row(row_buf, y);
		if (g->retro) {
			retro_row(row_buf, 1);
		}
		t0 = t1;
		t1 = prof_now();
		stats.shapes += t1 - t0;

		/*
		 * The ground scrolls with every frame, only sky rows can be the same
		 * as last time. The last row always goes out, it ends the frame.
		 */
		if (skip_rows && (float)y < bg.hy - 0.5f) {
			uint32_t h = hash_row(row_buf);

			if (row_hashed[y] && h == row_hash[y] && y != last_y) {
				stats.output += prof_now() - t1;
				continue;
			}
			row_hash[y] = h;
			row_hashed[y] = true;
		} else {
			row_hashed[y] = false;
		}

		waited = stats.wait;
		stats.rows_sent++;
		dst = strip_row(y);
		expand(dst, row_buf, log_w, scale);
		for (int k = 1; k < scale; k++) {
			memcpy(dst + (size_t)k * out_pitch, dst, out_pitch);
		}
		stats.output += prof_now() - t1 - (stats.wait - waited);
	}

	strip_submit(true);
}
