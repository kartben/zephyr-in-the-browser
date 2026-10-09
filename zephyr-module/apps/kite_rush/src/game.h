/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#ifndef KITE_RUSH_GAME_H_
#define KITE_RUSH_GAME_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define GAME_MAX_GATES     8
#define GAME_MAX_BUGS      12
#define GAME_MAX_PARTICLES 128
#define GAME_MAX_POPUPS    6

/* Seconds of daylight: the sun height is the remaining time */
#define GAME_SUN_MAX   30.0f
#define GAME_SUN_START 20.0f

/* Flight envelope in world units, y is the height above the ground */
#define GAME_Y_MIN     0.6f
#define GAME_Y_MAX     5.6f
#define GAME_SPEED_MIN 10.0f
#define GAME_SPEED_MAX 24.0f

#define GAME_ROLL_DURATION 0.55f

#define GAME_HIGH_SCORES 8
#define GAME_NAME_LEN    3

enum game_phase {
	PHASE_ATTRACT = 0,
	PHASE_COUNTDOWN = 1,
	PHASE_FLYING = 2,
	PHASE_GAME_OVER = 3,
	PHASE_SIGNAL_LOST = 4,
	PHASE_NAME_ENTRY = 5,
	PHASE_RESET_CODE = 6,
};

/* Where the pilot inputs come from, for the prompts on screen */
enum control_source {
	CONTROL_RC,    /* radio sticks */
	CONTROL_KEYS,  /* keys, joystick or trackball of the board */
	CONTROL_TOUCH, /* touchscreen of the board */
};

/* Normalized pilot inputs */
struct controls {
	float roll;     /* -1 (left) .. 1 (right) */
	float pitch;    /* -1 (down) .. 1 (up) */
	float throttle; /* 0 .. 1 */
	float yaw;      /* -1 (left) .. 1 (right) */
	bool valid;     /* a pilot is connected and the link is alive */
	uint8_t source; /* enum control_source */
};

enum gate_state {
	GATE_PENDING,
	GATE_PASSED,
	GATE_PERFECT,
	GATE_MISSED,
};

struct gate {
	float x, y, z;
	float base_x;
	float half;     /* half of the opening size */
	float move_amp; /* lateral sway amplitude, 0 for static gates */
	float move_phase;
	float flash;    /* seconds of highlight left after a pass or a miss */
	uint16_t index; /* sequence number, used for alternating colors */
	uint8_t state;
};

struct bug {
	float x, y, z;
	float base_x, base_y;
	float wobble; /* sway amplitude */
	float phase;
	float splat;  /* seconds of splat animation left, 0 if alive */
	bool active;
};

enum particle_kind {
	PARTICLE_SPARK,    /* additive square */
	PARTICLE_CONFETTI, /* tumbling triangle */
	PARTICLE_STREAK,   /* wind line along the flight direction */
};

/* Particles live in world space so the camera flies through them */
struct particle {
	float x, y, z;
	float vx, vy, vz;
	float life, max_life;
	float size; /* world units, length along z for streaks */
	uint32_t color;
	uint8_t kind;
};

/* Popups are drawn relative to the kite, offsets in logical pixels */
struct popup {
	char text[16];
	float dx, dy;
	float life;
	uint32_t color;
	uint8_t scale;
};

/* Score 0 marks an empty slot */
struct high_score {
	uint32_t score;
	char name[GAME_NAME_LEN];
	uint8_t level;
};

enum reset_result {
	RESET_NONE,
	RESET_CLEARED,
	RESET_WRONG_CODE,
};

/* Three letters picked with the right stick, for a name or the reset code */
struct letter_entry {
	char text[GAME_NAME_LEN + 1];
	uint8_t pos;     /* letter being edited */
	float time_left; /* seconds before the entry ends on its own */
	uint8_t result;  /* enum reset_result, shown once the code is entered */
};

struct kite {
	float x, y, z;
	float vx, vy;
	float speed;    /* forward speed in units per second */
	float bank;     /* visual roll angle in radians */
	float roll_t;   /* seconds left in the current barrel roll */
	float roll_dir; /* -1 or 1 */
	float roll_cooldown;
	float hit_t;    /* seconds of hit shake left */
};

struct game {
	enum game_phase phase;
	float phase_t; /* seconds spent in the current phase */
	float time;    /* seconds since boot, for animations */

	struct kite kite;
	float cam_x, cam_y, cam_z;

	struct gate gates[GAME_MAX_GATES];
	uint16_t next_gate_index;
	float last_gate_x, last_gate_y, last_gate_z;

	struct bug bugs[GAME_MAX_BUGS];
	struct particle particles[GAME_MAX_PARTICLES];
	struct popup popups[GAME_MAX_POPUPS];

	float sun;          /* remaining daylight in seconds */
	float sun_display;  /* smoothed value used for drawing */
	uint32_t score;
	uint32_t best;
	uint16_t gates_passed;
	uint8_t combo;
	uint8_t level;
	float level_blend;  /* 0..1 transition towards the current level palette */
	float level_banner; /* seconds left showing the new level */
	bool new_best;
	bool armed;         /* throttle was seen low, launching is allowed */
	bool autopilot;
	uint8_t countdown;  /* last countdown number announced */
	bool yaw_centered;  /* rudder went back to centre since the last roll */
	float shake;        /* screen shake amplitude in pixels */
	float flash;        /* full screen flash intensity 0..1 */
	uint32_t rng;

	struct high_score scores[GAME_HIGH_SCORES];
	int8_t rank;        /* table position of the last run, -1 if it did not make it */
	bool ranked;        /* the last run is in the table */
	struct letter_entry entry;
	char last_name[GAME_NAME_LEN + 1];
	bool show_scores;   /* attract mode shows the high score table */
	float page_t;       /* seconds on the current attract mode page */
	float menu_hold;    /* seconds the reset stick command was held */

	uint8_t nav;        /* direction the sticks are held in, for menus */
	float nav_repeat;   /* seconds until the held direction repeats */
	bool nav_release;   /* ignore the sticks until they are centered */
	uint8_t konami;     /* Konami code progress */
	bool retro;         /* four shades of green, unlocked with the Konami code */
	float retro_banner; /* seconds left showing the retro mode banner */
};

/* Telemetry event codes, sent in the CRSF "Game" command frame (event << 8 | arg) */
enum game_event {
	EVT_COUNTDOWN = 0x01,
	EVT_GO = 0x02,
	EVT_GATE = 0x03,
	EVT_PERFECT = 0x04,
	EVT_MISS = 0x05,
	EVT_HIT = 0x06,
	EVT_LEVEL_UP = 0x07,
	EVT_GAME_OVER = 0x08,
	EVT_NEW_BEST = 0x09,
	EVT_BARREL_ROLL = 0x0A,
	EVT_SQUASH = 0x0B,
	EVT_HIGH_SCORE = 0x0C, /* argument: rank, 1 for the top score */
	EVT_RETRO = 0x0D,      /* argument: 1 when retro mode turns on, 0 when off */
};

/* Implemented by the telemetry module, called by the game logic */
void game_emit_event(enum game_event event, uint8_t arg);
void game_emit_points(int32_t points);

/* Implemented by the storage module, called by the game logic */
void game_store_scores(const struct high_score *scores, size_t count);

void game_init(struct game *g, uint32_t seed);
void game_update(struct game *g, const struct controls *ctl, float dt);
/* Takes the high score table read back from storage */
void game_set_scores(struct game *g, const struct high_score *scores, size_t count);

/* The run is over, the kite glides down */
static inline bool game_is_over(const struct game *g)
{
	return g->phase == PHASE_GAME_OVER || g->phase == PHASE_NAME_ENTRY;
}

static inline float game_speed_ratio(const struct game *g)
{
	/* 0 at minimum airspeed, 1 at full throttle */
	float r = (g->kite.speed - GAME_SPEED_MIN) / (GAME_SPEED_MAX - GAME_SPEED_MIN);

	return r < 0.0f ? 0.0f : (r > 1.0f ? 1.0f : r);
}

#endif /* KITE_RUSH_GAME_H_ */
