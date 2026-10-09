/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>

#include "game.h"

/* World units: x right, y up (ground at 0), z forward */
#define X_LIMIT       7.0f
#define STEER_SPEED   10.0f
#define CLIMB_SPEED   7.0f
#define KITE_RADIUS   0.42f
#define BUG_RADIUS    0.42f
#define GATE_BAR      0.16f
#define VIEW_DISTANCE 120.0f

#define ROLL_COOLDOWN 1.1f
#define ROLL_DASH     11.0f

#define COUNTDOWN_TIME 3.0f
#define RESUME_TIME    1.5f
#define LAUNCH_DELAY   2.5f
#define ATTRACT_IDLE   30.0f

/* High score table and menus */
#define NAME_DELAY      2.5f /* GAME OVER shows that long before the name entry */
#define ENTRY_TIME      30.0f
#define BOT_ENTRY_TIME  1.5f
#define RESULT_TIME     2.5f
#define MENU_HOLD_TIME  2.0f
#define TITLE_PAGE_TIME 9.0f
#define SCORE_PAGE_TIME 7.0f
#define RETRO_BANNER    2.5f

/* Stick travel that presses a direction, and the travel that releases it */
#define NAV_PRESS   0.6f
#define NAV_RELEASE 0.3f
/* Up and down repeat while held, to scroll through the letters */
#define NAV_DELAY   0.45f
#define NAV_RATE    0.11f

#define GATES_PER_LEVEL 8

#define COLOR_SPARK_BLUE   0x00aeffU
#define COLOR_SPARK_PURPLE 0xaf7fe4U
#define COLOR_GOLD         0xffd94aU
#define COLOR_WHITE        0xffffffU
#define COLOR_BUG          0x8cff3cU
#define COLOR_RED          0xff4a5aU

static const uint32_t confetti_colors[] = {
	0x00aeffU, 0x0070c5U, 0x7929d2U, 0x9454dbU, 0xaf7fe4U, 0xb1e4faU,
};

static const char letters[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";

/* The right stick acts as a joystick, the rudder as the B and A buttons of a game pad */
enum nav {
	NAV_NONE,
	NAV_UP,
	NAV_DOWN,
	NAV_LEFT,
	NAV_RIGHT,
	NAV_B,
	NAV_A,
};

static const uint8_t konami_code[] = {
	NAV_UP, NAV_UP, NAV_DOWN, NAV_DOWN, NAV_LEFT, NAV_RIGHT, NAV_LEFT, NAV_RIGHT, NAV_B, NAV_A,
};

enum entry_status {
	ENTRY_EDITING,
	ENTRY_DONE,
	ENTRY_BACK,
	ENTRY_TIMEOUT,
};

static uint32_t rnd(struct game *g)
{
	/* xorshift32 */
	uint32_t x = g->rng;

	x ^= x << 13;
	x ^= x >> 17;
	x ^= x << 5;
	g->rng = x;

	return x;
}

static float rndf(struct game *g, float lo, float hi)
{
	return lo + (hi - lo) * (float)(rnd(g) & 0xffffU) / 65535.0f;
}

static float approach(float cur, float target, float rate, float dt)
{
	return cur + (target - cur) * MIN(1.0f, rate * dt);
}

static float clampf(float v, float lo, float hi)
{
	return v < lo ? lo : (v > hi ? hi : v);
}

/* Difficulty knobs, all ramping with the level */
static float level_spacing(const struct game *g)
{
	return MAX(13.0f, 18.0f - 0.8f * (float)(g->level - 1U));
}

static float level_gate_half(const struct game *g)
{
	return MAX(1.05f, 2.0f - 0.15f * (float)(g->level - 1U));
}

static float level_wander(const struct game *g)
{
	return MIN(4.8f, 2.2f + 0.5f * (float)(g->level - 1U));
}

static float level_drain(const struct game *g)
{
	return 0.85f + 0.08f * (float)(g->level - 1U);
}

static float gate_x_at(const struct gate *gt, float t)
{
	return gt->base_x + gt->move_amp * sinf(t * 1.3f + gt->move_phase);
}

static float bug_x_at(const struct bug *b, float t)
{
	return b->base_x + b->wobble * sinf(t * 2.1f + b->phase);
}

static float bug_y_at(const struct bug *b, float t)
{
	return b->base_y + 0.5f * b->wobble * cosf(t * 1.7f + b->phase);
}

static struct particle *particle_alloc(struct game *g)
{
	struct particle *oldest = &g->particles[0];

	for (int i = 0; i < GAME_MAX_PARTICLES; i++) {
		struct particle *p = &g->particles[i];

		if (p->life <= 0.0f) {
			return p;
		}
		if (p->life < oldest->life) {
			oldest = p;
		}
	}

	return oldest;
}

static void burst(struct game *g, float x, float y, float z, int count, enum particle_kind kind,
		  float speed, const uint32_t *colors, int ncolors)
{
	for (int i = 0; i < count; i++) {
		struct particle *p = particle_alloc(g);
		float a = rndf(g, 0.0f, 6.2832f);
		float v = rndf(g, 0.3f, 1.0f) * speed;

		p->x = x;
		p->y = y;
		p->z = z;
		p->vx = cosf(a) * v;
		p->vy = sinf(a) * v;
		p->vz = rndf(g, -0.2f, 0.6f) * g->kite.speed;
		p->max_life = rndf(g, 0.5f, 1.1f);
		p->life = p->max_life;
		p->size = kind == PARTICLE_CONFETTI ? rndf(g, 0.12f, 0.22f) : rndf(g, 0.05f, 0.1f);
		p->color = colors[rnd(g) % (uint32_t)ncolors];
		p->kind = kind;
	}
}

static void popup(struct game *g, const char *text, uint32_t color, uint8_t scale, float dy)
{
	struct popup *slot = &g->popups[0];

	for (int i = 0; i < GAME_MAX_POPUPS; i++) {
		struct popup *pp = &g->popups[i];

		/* Older popups make room above the new one */
		if (pp->life > 0.0f) {
			pp->dy -= (float)(8 * scale + 2);
		}
		if (pp->life <= 0.0f || pp->life < slot->life) {
			slot = pp;
		}
	}

	strncpy(slot->text, text, sizeof(slot->text) - 1);
	slot->text[sizeof(slot->text) - 1] = '\0';
	slot->dx = 0.0f;
	slot->dy = dy;
	slot->life = 1.0f;
	slot->color = color;
	slot->scale = scale;
}

static void spawn_bugs(struct game *g, float from_x, float from_y, float from_z,
		       const struct gate *to)
{
	int count = 0;

	if (g->phase == PHASE_ATTRACT) {
		count = (rnd(g) % 3U) == 0U ? 1 : 0;
	} else if (g->level >= 2U) {
		count = (int)(rnd(g) % (g->level >= 4U ? 3U : 2U)) + (g->level >= 6U ? 1 : 0);
	} else {
		count = (rnd(g) % 2U) == 0U ? 1 : 0;
	}

	for (int n = 0; n < count; n++) {
		for (int i = 0; i < GAME_MAX_BUGS; i++) {
			struct bug *b = &g->bugs[i];
			float t;

			if (b->active) {
				continue;
			}

			/* Somewhere on the racing line between the two gates */
			t = rndf(g, 0.3f, 0.7f);
			b->z = from_z + (to->z - from_z) * t;
			b->base_x = from_x + (to->base_x - from_x) * t + rndf(g, -1.2f, 1.2f);
			b->base_y = clampf(from_y + (to->y - from_y) * t + rndf(g, -0.9f, 0.9f),
					   GAME_Y_MIN + 0.3f, GAME_Y_MAX - 0.5f);
			b->wobble = g->level >= 3U ? rndf(g, 0.4f, 1.4f) : rndf(g, 0.0f, 0.4f);
			b->phase = rndf(g, 0.0f, 6.28f);
			b->x = b->base_x;
			b->y = b->base_y;
			b->splat = 0.0f;
			b->active = true;
			break;
		}
	}
}

static void spawn_gate(struct game *g, struct gate *gt)
{
	float wander = level_wander(g);
	float x, y;

	/* Random walk that keeps the racing line inside the flight envelope */
	x = clampf(g->last_gate_x + rndf(g, -wander, wander), -X_LIMIT + 1.5f, X_LIMIT - 1.5f);
	y = clampf(g->last_gate_y + rndf(g, -0.45f, 0.45f) * wander, GAME_Y_MIN + 0.9f,
		   GAME_Y_MAX - 0.9f);

	gt->index = g->next_gate_index++;
	gt->z = g->last_gate_z + level_spacing(g);
	gt->base_x = x;
	gt->x = x;
	gt->y = y;
	gt->half = level_gate_half(g);
	gt->move_amp = (g->level >= 3U && (rnd(g) % 3U) != 0U) ? rndf(g, 0.6f, 1.6f) : 0.0f;
	gt->move_phase = rndf(g, 0.0f, 6.28f);
	gt->flash = 0.0f;
	gt->state = GATE_PENDING;

	if (gt->index > 0U) {
		spawn_bugs(g, g->last_gate_x, g->last_gate_y, g->last_gate_z, gt);
	}

	g->last_gate_x = x;
	g->last_gate_y = y;
	g->last_gate_z = gt->z;
}

static void reset_world(struct game *g)
{
	memset(g->gates, 0, sizeof(g->gates));
	memset(g->bugs, 0, sizeof(g->bugs));
	memset(g->particles, 0, sizeof(g->particles));
	memset(g->popups, 0, sizeof(g->popups));

	g->kite = (struct kite){
		.x = 0.0f,
		.y = 2.8f,
		.z = 0.0f,
		.speed = GAME_SPEED_MIN + 4.0f,
	};
	g->cam_x = 0.0f;
	g->cam_y = g->kite.y * 0.8f + 1.1f;
	g->cam_z = -4.0f;

	g->next_gate_index = 0;
	g->last_gate_x = 0.0f;
	g->last_gate_y = 2.8f;
	g->last_gate_z = 12.0f;

	for (int i = 0; i < GAME_MAX_GATES; i++) {
		spawn_gate(g, &g->gates[i]);
	}
}

static void set_phase(struct game *g, enum game_phase phase)
{
	g->phase = phase;
	g->phase_t = 0.0f;
}

static void start_run(struct game *g)
{
	g->autopilot = IS_ENABLED(CONFIG_KITE_RUSH_AUTOPLAY);
	g->level = 1;
	g->level_blend = 1.0f;
	g->score = 0;
	g->combo = 0;
	g->gates_passed = 0;
	g->new_best = false;
	g->sun = GAME_SUN_START;
	g->countdown = 0;
	reset_world(g);
	set_phase(g, PHASE_COUNTDOWN);
}

/* The table a new board starts with, for the first pilots to beat */
static const struct {
	uint32_t score;
	uint8_t level;
} default_scores[GAME_HIGH_SCORES] = {
	{14735U, 5U}, {12960U, 4U}, {11285U, 4U}, {9870U, 3U},
	{8415U, 3U},  {7340U, 3U},  {6195U, 2U},  {5060U, 2U},
};

static void default_table(struct game *g)
{
	for (size_t i = 0; i < ARRAY_SIZE(g->scores); i++) {
		g->scores[i].score = default_scores[i].score;
		g->scores[i].level = default_scores[i].level;
		memcpy(g->scores[i].name, "BOT", GAME_NAME_LEN);
	}
	g->best = g->scores[0].score;
}

void game_init(struct game *g, uint32_t seed)
{
	memset(g, 0, sizeof(*g));
	g->rng = seed != 0U ? seed : 0x5eed1234U;
	g->level = 1;
	g->level_blend = 1.0f;
	g->sun = GAME_SUN_MAX * 0.62f;
	g->sun_display = g->sun;
	g->autopilot = true;
	g->yaw_centered = true;
	g->rank = -1;
	memcpy(g->last_name, "AAA", sizeof(g->last_name));
	default_table(g);
	reset_world(g);
	set_phase(g, PHASE_ATTRACT);
}

void game_set_scores(struct game *g, const struct high_score *scores, size_t count)
{
	/* An empty saved table leaves the default one */
	if (count == 0U || scores[0].score == 0U) {
		return;
	}

	memset(g->scores, 0, sizeof(g->scores));
	memcpy(g->scores, scores, MIN(count, ARRAY_SIZE(g->scores)) * sizeof(g->scores[0]));
	g->best = g->scores[0].score;
}

static struct gate *next_gate(struct game *g)
{
	struct gate *best = NULL;

	for (int i = 0; i < GAME_MAX_GATES; i++) {
		struct gate *gt = &g->gates[i];

		if (gt->state != GATE_PENDING || gt->z < g->kite.z) {
			continue;
		}
		if (best == NULL || gt->z < best->z) {
			best = gt;
		}
	}

	return best;
}

/* Steers towards the next gate while dodging bugs, used for the attract mode */
static void autopilot(struct game *g, struct controls *out)
{
	struct gate *gt = next_gate(g);
	struct kite *k = &g->kite;
	float tx = 0.0f;
	float ty = 2.5f;
	float eta;

	if (gt != NULL) {
		eta = (gt->z - k->z) / MAX(k->speed, 1.0f);
		tx = gate_x_at(gt, g->time + eta);
		ty = gt->y;
	}

	for (int i = 0; i < GAME_MAX_BUGS; i++) {
		struct bug *b = &g->bugs[i];
		float dz = b->z - k->z;
		float dx, dy;

		if (!b->active || b->splat > 0.0f || dz < 0.0f || dz > 14.0f) {
			continue;
		}
		dx = tx - bug_x_at(b, g->time + dz / MAX(k->speed, 1.0f));
		dy = ty - b->base_y;
		if (fabsf(dx) < 1.1f && fabsf(dy) < 1.1f) {
			/* Pass the bug on the side the line already favors */
			tx += dx >= 0.0f ? 1.2f : -1.2f;
		}
	}

	out->roll = clampf(((tx - k->x) * 1.6f - k->vx * 0.25f) / STEER_SPEED * 2.2f, -1.0f, 1.0f);
	out->pitch = clampf(((ty - k->y) * 1.6f - k->vy * 0.25f) / CLIMB_SPEED * 2.2f, -1.0f, 1.0f);
	out->throttle = 0.45f + 0.25f * sinf(g->time * 0.21f);
	out->yaw = 0.0f;
	out->valid = true;
}

static void add_points(struct game *g, int32_t pts)
{
	g->score += (uint32_t)pts;
	game_emit_points(pts);
}

static void level_up(struct game *g)
{
	g->level++;
	g->level_blend = 0.0f;
	g->level_banner = 1.6f;
	game_emit_event(EVT_LEVEL_UP, g->level);
}

static void gate_passed(struct game *g, struct gate *gt, bool perfect)
{
	char text[16];
	float mult = 1.0f + game_speed_ratio(g);
	int32_t pts;

	gt->state = perfect ? GATE_PERFECT : GATE_PASSED;
	gt->flash = 0.6f;

	if (g->phase == PHASE_FLYING) {
		g->combo = (uint8_t)MIN(255, g->combo + 1);
		pts = (int32_t)((50.0f + 10.0f * (float)MIN(g->combo, 30U)) * mult *
				(1.0f + 0.25f * (float)(g->level - 1U)));
		if (perfect) {
			pts *= 2;
		}
		pts = (pts / 5) * 5;
		g->sun = MIN(GAME_SUN_MAX, g->sun + (perfect ? 2.2f : 1.3f));
		add_points(g, pts);
		game_emit_event(perfect ? EVT_PERFECT : EVT_GATE, g->combo);
		if (perfect) {
			popup(g, "PERFECT", COLOR_GOLD, 2, -16.0f);
		}
		snprintf(text, sizeof(text), "+%d", pts);
		popup(g, text, perfect ? COLOR_GOLD : COLOR_WHITE, 2, -16.0f);
		g->gates_passed++;
		if ((g->gates_passed % GATES_PER_LEVEL) == 0U) {
			level_up(g);
		}
	}

	if (perfect) {
		burst(g, gt->x, gt->y, gt->z, 26, PARTICLE_CONFETTI, 5.0f, confetti_colors,
		      ARRAY_SIZE(confetti_colors));
		g->flash = MAX(g->flash, 0.25f);
	} else {
		static const uint32_t sparks[] = {COLOR_SPARK_BLUE, COLOR_SPARK_PURPLE,
						  COLOR_WHITE};

		burst(g, gt->x, gt->y, gt->z, 14, PARTICLE_SPARK, 4.0f, sparks,
		      ARRAY_SIZE(sparks));
	}
}

static void gate_missed(struct game *g, struct gate *gt)
{
	gt->state = GATE_MISSED;
	gt->flash = 0.5f;

	if (g->phase == PHASE_FLYING) {
		g->combo = 0;
		if (g->level >= 3U) {
			g->sun = MAX(0.0f, g->sun - 0.5f);
		}
		game_emit_event(EVT_MISS, 0);
		popup(g, "MISS", COLOR_RED, 2, -18.0f);
	}
}

static void bug_collision(struct game *g, struct bug *b)
{
	static const uint32_t splat[] = {COLOR_BUG, 0x3c9e2aU, COLOR_WHITE};
	char text[16];
	int32_t pts;

	b->splat = 0.5f;

	if (g->kite.roll_t > 0.0f) {
		/* A barrel roll squashes the bug instead of the other way round */
		burst(g, b->x, b->y, b->z, 18, PARTICLE_SPARK, 6.0f, splat, ARRAY_SIZE(splat));
		if (g->phase == PHASE_FLYING) {
			pts = 250 * (int32_t)g->level;
			add_points(g, pts);
			game_emit_event(EVT_SQUASH, 0);
			snprintf(text, sizeof(text), "+%d", pts);
			popup(g, "SQUASH!", COLOR_BUG, 2, -16.0f);
			popup(g, text, COLOR_WHITE, 2, -16.0f);
		}
		return;
	}

	burst(g, b->x, b->y, b->z, 22, PARTICLE_SPARK, 5.0f, splat, ARRAY_SIZE(splat));
	g->kite.hit_t = 0.7f;
	g->kite.speed *= 0.7f;
	g->shake = 6.0f;
	g->flash = MAX(g->flash, 0.5f);

	if (g->phase == PHASE_FLYING) {
		g->combo = 0;
		g->sun = MAX(0.0f, g->sun - 4.0f);
		game_emit_event(EVT_HIT, 0);
		popup(g, "BUG!", COLOR_RED, 3, -26.0f);
	}
}

static void update_kite(struct game *g, const struct controls *ctl, float dt)
{
	struct kite *k = &g->kite;
	float target_speed = GAME_SPEED_MIN + (GAME_SPEED_MAX - GAME_SPEED_MIN) * ctl->throttle;
	float tvx = ctl->roll * STEER_SPEED;
	float tvy = ctl->pitch * CLIMB_SPEED;

	target_speed *= 1.0f + 0.04f * (float)(g->level - 1U);

	if (g->phase == PHASE_COUNTDOWN) {
		target_speed = GAME_SPEED_MIN * 0.6f;
	} else if (game_is_over(g)) {
		target_speed = 2.5f;
	}

	/* Barrel roll on a full rudder flick */
	if (fabsf(ctl->yaw) < 0.4f) {
		g->yaw_centered = true;
	}
	if (fabsf(ctl->yaw) > 0.8f && g->yaw_centered && k->roll_cooldown <= 0.0f &&
	    k->roll_t <= 0.0f && g->phase != PHASE_COUNTDOWN) {
		g->yaw_centered = false;
		k->roll_dir = ctl->yaw > 0.0f ? 1.0f : -1.0f;
		k->roll_t = GAME_ROLL_DURATION;
		k->roll_cooldown = ROLL_COOLDOWN;
		k->vx += k->roll_dir * ROLL_DASH;
		if (g->phase == PHASE_FLYING) {
			game_emit_event(EVT_BARREL_ROLL, 0);
		}
	}

	k->roll_t = MAX(0.0f, k->roll_t - dt);
	k->roll_cooldown = MAX(0.0f, k->roll_cooldown - dt);
	k->hit_t = MAX(0.0f, k->hit_t - dt);

	k->vx = approach(k->vx, tvx, 5.0f, dt);
	k->vy = approach(k->vy, tvy, 5.0f, dt);
	k->speed = approach(k->speed, target_speed, 1.5f, dt);

	k->x += k->vx * dt;
	k->y += k->vy * dt;
	if (k->x < -X_LIMIT || k->x > X_LIMIT) {
		k->x = clampf(k->x, -X_LIMIT, X_LIMIT);
		k->vx *= -0.3f;
	}
	if (k->y < GAME_Y_MIN || k->y > GAME_Y_MAX) {
		k->y = clampf(k->y, GAME_Y_MIN, GAME_Y_MAX);
		k->vy *= -0.3f;
	}
	k->z += k->speed * dt;

	k->bank = approach(k->bank, clampf(k->vx * 0.07f, -0.7f, 0.7f), 8.0f, dt);
}

static void update_world(struct game *g, float prev_z, float dt)
{
	struct kite *k = &g->kite;

	for (int i = 0; i < GAME_MAX_GATES; i++) {
		struct gate *gt = &g->gates[i];

		gt->x = gate_x_at(gt, g->time);
		gt->flash = MAX(0.0f, gt->flash - dt);

		if (gt->state == GATE_PENDING && prev_z < gt->z && k->z >= gt->z) {
			float dx = k->x - gt->x;
			float dy = k->y - gt->y;
			float inner = gt->half - GATE_BAR * 0.5f;

			if (fabsf(dx) < inner && fabsf(dy) < inner) {
				gate_passed(g, gt, dx * dx + dy * dy < gt->half * gt->half * 0.12f);
			} else {
				gate_missed(g, gt);
			}
		}

		/* Recycle gates once they are behind the camera */
		if (gt->z < g->cam_z - 1.0f) {
			spawn_gate(g, gt);
		}
	}

	for (int i = 0; i < GAME_MAX_BUGS; i++) {
		struct bug *b = &g->bugs[i];

		if (!b->active) {
			continue;
		}

		if (b->splat > 0.0f) {
			b->splat -= dt;
			if (b->splat <= 0.0f) {
				b->active = false;
			}
			continue;
		}

		b->x = bug_x_at(b, g->time);
		b->y = bug_y_at(b, g->time);

		if (prev_z < b->z + BUG_RADIUS && k->z >= b->z - BUG_RADIUS) {
			float dx = k->x - b->x;
			float dy = k->y - b->y;
			float r = KITE_RADIUS + BUG_RADIUS;

			if (dx * dx + dy * dy < r * r) {
				bug_collision(g, b);
			}
		}

		if (b->z < g->cam_z - 1.0f) {
			b->active = false;
		}
	}
}

static void update_effects(struct game *g, float dt)
{
	struct kite *k = &g->kite;
	float speed_ratio = game_speed_ratio(g);
	float streaks = (g->phase == PHASE_FLYING || g->phase == PHASE_ATTRACT ||
			 g->phase == PHASE_RESET_CODE)
				? speed_ratio * speed_ratio * 40.0f
				: 0.0f;

	for (int i = 0; i < GAME_MAX_PARTICLES; i++) {
		struct particle *p = &g->particles[i];

		if (p->life <= 0.0f) {
			continue;
		}
		p->life -= dt;
		p->x += p->vx * dt;
		p->y += p->vy * dt;
		p->z += p->vz * dt;
		if (p->kind == PARTICLE_CONFETTI) {
			p->vy -= 4.0f * dt;
			p->vx *= 1.0f - MIN(1.0f, 1.5f * dt);
		}
		if (p->z < g->cam_z + 0.2f) {
			p->life = 0.0f;
		}
	}

	/* Wind streaks rushing past at high airspeed */
	for (float n = streaks * dt; n > 0.0f; n -= 1.0f) {
		struct particle *p;
		float a;

		if (n < 1.0f && rndf(g, 0.0f, 1.0f) > n) {
			break;
		}
		p = particle_alloc(g);
		a = rndf(g, 0.0f, 6.2832f);
		p->x = g->cam_x + cosf(a) * rndf(g, 2.5f, 7.0f);
		p->y = g->cam_y + sinf(a) * rndf(g, 1.8f, 4.0f);
		p->z = k->z + rndf(g, 10.0f, 40.0f);
		p->vx = 0.0f;
		p->vy = 0.0f;
		p->vz = 0.0f;
		p->max_life = 2.0f;
		p->life = p->max_life;
		p->size = 1.5f + 3.0f * speed_ratio;
		p->color = 0xd8c8ffU;
		p->kind = PARTICLE_STREAK;
	}

	for (int i = 0; i < GAME_MAX_POPUPS; i++) {
		struct popup *pp = &g->popups[i];

		if (pp->life > 0.0f) {
			pp->life -= dt * 1.4f;
			pp->dy -= 18.0f * dt;
		}
	}

	g->level_banner = MAX(0.0f, g->level_banner - dt);
	g->retro_banner = MAX(0.0f, g->retro_banner - dt);
	g->shake = MAX(0.0f, g->shake - 18.0f * dt);
	g->flash = MAX(0.0f, g->flash - 2.0f * dt);
	g->level_blend = MIN(1.0f, g->level_blend + 0.5f * dt);
	g->sun_display = approach(g->sun_display, g->sun, 3.0f, dt);
}

static void update_camera(struct game *g, float dt)
{
	struct kite *k = &g->kite;

	g->cam_x = approach(g->cam_x, k->x * 0.75f, 4.0f, dt);
	g->cam_y = approach(g->cam_y, k->y * 0.8f + 1.1f, 4.0f, dt);
	g->cam_z = k->z - 4.0f;
}

/* The right stick moves the way it is pushed, whatever the pitch convention */
static float stick_up(const struct controls *ctl)
{
	return IS_ENABLED(CONFIG_KITE_RUSH_INVERT_PITCH) ? -ctl->pitch : ctl->pitch;
}

static enum nav nav_direction(const struct controls *ctl, float travel)
{
	float up = stick_up(ctl);

	if (!ctl->valid) {
		return NAV_NONE;
	}
	if (fabsf(up) >= fabsf(ctl->roll) && fabsf(up) > travel) {
		return up > 0.0f ? NAV_UP : NAV_DOWN;
	}
	if (fabsf(ctl->roll) > travel) {
		return ctl->roll > 0.0f ? NAV_RIGHT : NAV_LEFT;
	}
	if (fabsf(ctl->yaw) > travel) {
		return ctl->yaw > 0.0f ? NAV_A : NAV_B;
	}

	return NAV_NONE;
}

/* Turns stick flicks into presses, returns NAV_NONE when nothing was pressed */
static enum nav nav_read(struct game *g, const struct controls *ctl, float dt)
{
	enum nav dir = nav_direction(ctl, NAV_RELEASE);

	if (g->nav_release) {
		if (dir != NAV_NONE) {
			return NAV_NONE;
		}
		g->nav_release = false;
	}

	/* A new direction needs a firm push, the held one lasts until the stick is back */
	if (dir != (enum nav)g->nav) {
		dir = nav_direction(ctl, NAV_PRESS);
	}

	if (dir != (enum nav)g->nav) {
		g->nav = (uint8_t)dir;
		g->nav_repeat = NAV_DELAY;
		return dir;
	}

	if (dir == NAV_UP || dir == NAV_DOWN) {
		g->nav_repeat -= dt;
		if (g->nav_repeat <= 0.0f) {
			g->nav_repeat += NAV_RATE;
			return dir;
		}
	}

	return NAV_NONE;
}

/* Returns true when the last presses spell the Konami code */
static bool konami_step(struct game *g, enum nav press)
{
	if (press == NAV_NONE) {
		return false;
	}

	if (press == konami_code[g->konami]) {
		g->konami++;
	} else if (press == NAV_UP) {
		/* A third up still leaves the code two presses in */
		g->konami = g->konami == 2U ? 2U : 1U;
	} else {
		g->konami = 0;
	}

	if (g->konami == ARRAY_SIZE(konami_code)) {
		g->konami = 0;
		return true;
	}

	return false;
}

static void entry_start(struct game *g, enum game_phase phase, const char *text)
{
	memcpy(g->entry.text, text, GAME_NAME_LEN);
	g->entry.text[GAME_NAME_LEN] = '\0';
	g->entry.pos = 0;
	g->entry.time_left = ENTRY_TIME;
	g->entry.result = RESET_NONE;
	/* The pilot may still hold the sticks that got here */
	g->nav_release = true;
	set_phase(g, phase);
}

/* Up and down pick the letter, right or A moves on, left or B goes back */
static enum entry_status entry_update(struct game *g, enum nav press, float dt)
{
	struct letter_entry *e = &g->entry;
	char *c = &e->text[e->pos];
	const char *at = strchr(letters, *c);
	int n = (int)sizeof(letters) - 1;
	int idx = at != NULL ? (int)(at - letters) : 0;

	e->time_left -= dt;
	if (e->time_left <= 0.0f) {
		e->time_left = 0.0f;
		return ENTRY_TIMEOUT;
	}

	switch (press) {
	case NAV_UP:
		*c = letters[(idx + 1) % n];
		break;
	case NAV_DOWN:
		*c = letters[(idx + n - 1) % n];
		break;
	case NAV_RIGHT:
	case NAV_A:
		if (e->pos == GAME_NAME_LEN - 1U) {
			return ENTRY_DONE;
		}
		e->pos++;
		break;
	case NAV_LEFT:
	case NAV_B:
		if (e->pos == 0U) {
			return ENTRY_BACK;
		}
		e->pos--;
		break;
	default:
		break;
	}

	return ENTRY_EDITING;
}

static int score_rank(const struct game *g, uint32_t score)
{
	if (score == 0U) {
		return -1;
	}

	for (int i = 0; i < GAME_HIGH_SCORES; i++) {
		if (score > g->scores[i].score) {
			return i;
		}
	}

	return -1;
}

static void score_insert(struct game *g, const char *name)
{
	struct high_score *hs = &g->scores[g->rank];

	memmove(hs + 1, hs, (size_t)(GAME_HIGH_SCORES - 1 - g->rank) * sizeof(*hs));
	hs->score = g->score;
	memcpy(hs->name, name, GAME_NAME_LEN);
	hs->level = g->level;
	memcpy(g->last_name, name, GAME_NAME_LEN);
	g->ranked = true;
	g->best = g->scores[0].score;
	game_store_scores(g->scores, ARRAY_SIZE(g->scores));
}

static bool reset_code_matches(const char *text)
{
	static const char code[] = CONFIG_KITE_RUSH_RESET_CODE;

	BUILD_ASSERT(sizeof(code) == GAME_NAME_LEN + 1U,
		     "CONFIG_KITE_RUSH_RESET_CODE must be three characters long");

	for (size_t i = 0; i < GAME_NAME_LEN; i++) {
		if (toupper((unsigned char)code[i]) != text[i]) {
			return false;
		}
	}

	return true;
}

static void attract_menu(struct game *g, const struct controls *ctl, float dt)
{
	enum nav press = nav_read(g, ctl, dt);

	/* The title and the high score table take turns, the right stick flips them */
	g->page_t += dt;
	if (g->scores[0].score == 0U) {
		g->show_scores = false;
	} else if (press == NAV_LEFT || press == NAV_RIGHT ||
		   g->page_t > (g->show_scores ? SCORE_PAGE_TIME : TITLE_PAGE_TIME)) {
		g->show_scores = !g->show_scores;
		g->page_t = 0.0f;
	}

	if (konami_step(g, press)) {
		g->retro = !g->retro;
		g->retro_banner = RETRO_BANNER;
		game_emit_event(EVT_RETRO, g->retro ? 1U : 0U);
	}

	/* Betaflight's stick command for its OSD menu: throttle mid, yaw left, pitch up */
	if (ctl->valid && fabsf(ctl->throttle - 0.5f) < 0.2f && ctl->yaw < -0.7f &&
	    stick_up(ctl) > 0.7f) {
		g->menu_hold += dt;
		if (g->menu_hold >= MENU_HOLD_TIME) {
			g->menu_hold = 0.0f;
			entry_start(g, PHASE_RESET_CODE, "AAA");
		}
	} else {
		g->menu_hold = 0.0f;
	}
}

static void reset_code_update(struct game *g, const struct controls *ctl, float dt)
{
	struct letter_entry *e = &g->entry;

	if (e->result != RESET_NONE) {
		if (g->phase_t > RESULT_TIME) {
			set_phase(g, PHASE_ATTRACT);
		}
		return;
	}

	switch (entry_update(g, nav_read(g, ctl, dt), dt)) {
	case ENTRY_DONE:
		if (reset_code_matches(e->text)) {
			default_table(g);
			g->rank = -1;
			game_store_scores(g->scores, ARRAY_SIZE(g->scores));
			e->result = RESET_CLEARED;
		} else {
			e->result = RESET_WRONG_CODE;
		}
		g->phase_t = 0.0f;
		break;
	case ENTRY_BACK:
	case ENTRY_TIMEOUT:
		set_phase(g, PHASE_ATTRACT);
		break;
	default:
		break;
	}
}

static void name_entry_update(struct game *g, const struct controls *ctl, float dt)
{
	enum entry_status status;

	if (g->autopilot) {
		/* Test runs fill the table too */
		status = g->phase_t > BOT_ENTRY_TIME ? ENTRY_DONE : ENTRY_EDITING;
	} else {
		status = entry_update(g, nav_read(g, ctl, dt), dt);
	}

	if (status == ENTRY_DONE || status == ENTRY_TIMEOUT) {
		score_insert(g, g->entry.text);
		set_phase(g, PHASE_GAME_OVER);
	}
}

static void glide(struct controls *ctl)
{
	ctl->roll = 0.0f;
	ctl->pitch = -0.25f;
	ctl->throttle = 0.0f;
	ctl->yaw = 0.0f;
}

static void game_over(struct game *g)
{
	set_phase(g, PHASE_GAME_OVER);
	g->armed = false;
	g->rank = (int8_t)score_rank(g, g->score);
	g->ranked = false;
	game_emit_event(EVT_GAME_OVER, 0);
	if (g->score > g->best) {
		g->best = g->score;
		g->new_best = g->score > 0U;
		if (g->new_best) {
			game_emit_event(EVT_NEW_BEST, 0);
		}
	}
}

void game_update(struct game *g, const struct controls *ctl_in, float dt)
{
	struct controls ctl = *ctl_in;
	struct controls pilot = {0};
	bool launch;
	float prev_z = g->kite.z;

	g->time += dt;
	g->phase_t += dt;

	if (ctl.valid && ctl.throttle < 0.12f) {
		g->armed = true;
	}
	launch = ctl.valid && g->armed && ctl.throttle > 0.75f;

	switch (g->phase) {
	case PHASE_ATTRACT:
		autopilot(g, &pilot);
		ctl = pilot;
		g->sun = GAME_SUN_MAX * 0.62f;
		attract_menu(g, ctl_in, dt);
		if (g->phase == PHASE_ATTRACT &&
		    (launch || IS_ENABLED(CONFIG_KITE_RUSH_AUTOPLAY))) {
			g->armed = false;
			start_run(g);
		}
		break;

	case PHASE_RESET_CODE:
		autopilot(g, &pilot);
		ctl = pilot;
		g->sun = GAME_SUN_MAX * 0.62f;
		reset_code_update(g, ctl_in, dt);
		break;

	case PHASE_COUNTDOWN:
		if (!ctl_in->valid && !g->autopilot) {
			set_phase(g, PHASE_SIGNAL_LOST);
			break;
		}
		if (g->autopilot) {
			autopilot(g, &pilot);
			ctl = pilot;
		}
		if (g->countdown < 3U && g->phase_t >= (float)g->countdown) {
			g->countdown++;
			game_emit_event(EVT_COUNTDOWN, (uint8_t)(4U - g->countdown));
		}
		if (g->phase_t >= COUNTDOWN_TIME) {
			set_phase(g, PHASE_FLYING);
			game_emit_event(EVT_GO, 0);
		}
		break;

	case PHASE_FLYING:
		if (!ctl_in->valid && !g->autopilot) {
			set_phase(g, PHASE_SIGNAL_LOST);
			break;
		}
		if (g->autopilot) {
			autopilot(g, &pilot);
			/* Make the robot imperfect so test runs end */
			pilot.roll *= 0.75f;
			ctl = pilot;
		}
		g->sun -= level_drain(g) * dt;
		if (g->sun <= 0.0f) {
			g->sun = 0.0f;
			game_over(g);
		}
		break;

	case PHASE_SIGNAL_LOST:
		if (ctl_in->valid && g->phase_t > RESUME_TIME) {
			set_phase(g, PHASE_FLYING);
			game_emit_event(EVT_GO, 0);
		}
		/* The world freezes while the pilot is gone */
		update_effects(g, dt);
		return;

	case PHASE_NAME_ENTRY:
		glide(&ctl);
		name_entry_update(g, ctl_in, dt);
		break;

	case PHASE_GAME_OVER:
		glide(&ctl);
		if (g->rank >= 0 && !g->ranked) {
			if (g->phase_t > NAME_DELAY) {
				entry_start(g, PHASE_NAME_ENTRY,
					    g->autopilot ? "BOT" : g->last_name);
				game_emit_event(EVT_HIGH_SCORE, (uint8_t)(g->rank + 1));
			}
		} else if (g->phase_t > LAUNCH_DELAY &&
			   (launch ||
			    (IS_ENABLED(CONFIG_KITE_RUSH_AUTOPLAY) && g->phase_t > 6.0f))) {
			g->armed = false;
			start_run(g);
		} else if (g->phase_t > ATTRACT_IDLE) {
			g->autopilot = true;
			g->sun = GAME_SUN_MAX * 0.62f;
			reset_world(g);
			set_phase(g, PHASE_ATTRACT);
		}
		break;
	}

	update_kite(g, &ctl, dt);
	update_world(g, prev_z, dt);
	update_camera(g, dt);
	update_effects(g, dt);
}
