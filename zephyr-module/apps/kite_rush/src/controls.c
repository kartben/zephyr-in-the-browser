/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <stdlib.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/display.h>
#include <zephyr/input/input.h>
#include <zephyr/kernel.h>
#include <zephyr/spinlock.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/util.h>

#include "controls.h"

#if DT_HAS_COMPAT_STATUS_OKAY(tbs_crsf)
static const struct device *const crsf_dev =
	DEVICE_DT_GET(DT_COMPAT_GET_ANY_STATUS_OKAY(tbs_crsf));
#else
static const struct device *const crsf_dev;
#endif

#if DT_HAS_CHOSEN(zephyr_touch)
static const struct device *const touch_dev = DEVICE_DT_GET(DT_CHOSEN(zephyr_touch));
#else
static const struct device *const touch_dev;
#endif

/*
 * Without a radio, the keys or the touchscreen of the board fly the kite: the
 * arrow keys (joystick, trackball) or a drag on the touchscreen move the right
 * stick, B and A move the rudder, and a press of the action key or a tap
 * starts a game, or does a barrel roll in flight.
 */
#define HAS_TOUCH       DT_HAS_CHOSEN(zephyr_touch)
#define HAS_KEYS        DT_HAS_COMPAT_STATUS_OKAY(gpio_keys)
#define DEFAULT_SOURCE  (HAS_TOUCH ? CONTROL_TOUCH : CONTROL_KEYS)
#define CRUISE_THROTTLE 0.6f

/* Without a sync for that long, the radio is considered gone */
#define LINK_TIMEOUT_MS 500
/* A trackball step steers that long, so steps run into each other */
#define KEY_HOLD_MS     120
/* Taps and action presses act for that long */
#define PULSE_MS        150
#define TAP_MS          300

enum key {
	KEY_UP,
	KEY_DOWN,
	KEY_LEFT,
	KEY_RIGHT,
	KEY_ACTION,
	KEY_B,
	KEY_A,
	KEY_COUNT,
};

/* Stick values in microseconds, as reported by RC input drivers */
static atomic_t axis_roll = ATOMIC_INIT(1500);
static atomic_t axis_pitch = ATOMIC_INIT(1500);
static atomic_t axis_throttle = ATOMIC_INIT(1000);
static atomic_t axis_yaw = ATOMIC_INIT(1500);
static atomic_t last_sync_ms;
static atomic_t link_seen;
static bool rc_pending;

static const struct game *game;
static int32_t disp_w, disp_h;
static int32_t touch_radius; /* drag for a full stick deflection, in pixels */

static struct k_spinlock lock;
static struct {
	int64_t held_until[KEY_COUNT]; /* INT64_MAX while pressed */
	int32_t x, y;                  /* last touch position */
	int32_t x0, y0;                /* where the finger came down */
	int64_t down_ms;
	bool down;                     /* in the report being received */
	bool pressed;                  /* as of the last complete report */
	bool touching;                 /* finger down on the screen */
	bool moved;
	int8_t strip_key;              /* key held below the screen, -1 if none */
	int64_t launch_until;
	int64_t yaw_until;
	float yaw_dir;
	uint32_t last_ms;              /* last local input */
	uint8_t source;
} local = {
	.strip_key = -1,
	.source = DEFAULT_SOURCE,
};

static uint8_t last_source = DEFAULT_SOURCE;

static bool held(enum key k, int64_t now)
{
	return now < local.held_until[k];
}

/* Starts a game from the title or game over screens, else a barrel roll (A or B in menus) */
static void action(int64_t now, float dir)
{
	if (game->phase == PHASE_ATTRACT || game->phase == PHASE_GAME_OVER) {
		local.launch_until = now + PULSE_MS;
	} else {
		local.yaw_until = now + PULSE_MS;
		local.yaw_dir = dir;
	}
}

static void press(enum key k, bool down, int64_t now)
{
	if (!down) {
		local.held_until[k] = now + KEY_HOLD_MS;
		return;
	}

	local.held_until[k] = INT64_MAX;
	if (k == KEY_ACTION) {
		action(now, held(KEY_LEFT, now) ? -1.0f : 1.0f);
	}
}

static int key_of(uint16_t code)
{
	switch (code) {
	case INPUT_KEY_UP:
		return KEY_UP;
	case INPUT_KEY_DOWN:
		return KEY_DOWN;
	case INPUT_KEY_LEFT:
		return KEY_LEFT;
	case INPUT_KEY_RIGHT:
		return KEY_RIGHT;
	case INPUT_KEY_ENTER:
	case INPUT_BTN_START:
		return KEY_ACTION;
	case INPUT_BTN_B:
		return KEY_B;
	case INPUT_BTN_A:
		return KEY_A;
	default:
		return -1;
	}
}

/* Some panels go past the bottom of the display, as buttons: B, action and A */
static void touch_down(int64_t now)
{
	if (local.y >= disp_h) {
		local.strip_key = local.x < disp_w / 3 ? KEY_B
				  : (local.x < 2 * disp_w / 3 ? KEY_ACTION : KEY_A);
		press((enum key)local.strip_key, true, now);
		return;
	}

	local.touching = true;
	local.moved = false;
	local.x0 = local.x;
	local.y0 = local.y;
	local.down_ms = now;
}

static void touch_up(int64_t now)
{
	if (local.strip_key >= 0) {
		press((enum key)local.strip_key, false, now);
		local.strip_key = -1;
	}

	if (local.touching && !local.moved && now - local.down_ms < TAP_MS) {
		action(now, local.x0 < disp_w / 2 ? -1.0f : 1.0f);
	}
	local.touching = false;
}

static void touch_event(struct input_event *evt, int64_t now)
{
	switch (evt->code) {
	case INPUT_ABS_X:
		local.x = IS_ENABLED(CONFIG_KITE_RUSH_ROTATE_180) ? disp_w - 1 - evt->value
								 : evt->value;
		break;
	case INPUT_ABS_Y:
		/* Touches below the picture stay there, as buttons */
		local.y = IS_ENABLED(CONFIG_KITE_RUSH_ROTATE_180) && evt->value < disp_h
				  ? disp_h - 1 - evt->value
				  : evt->value;
		break;
	case INPUT_BTN_TOUCH:
	case INPUT_BTN_LEFT:
		local.down = evt->value != 0;
		break;
	default:
		break;
	}

	/* Act on complete reports. Hovering, as a mouse does in QEMU, is not input */
	if (evt->sync == 0U || disp_w == 0 || (!local.down && !local.pressed)) {
		return;
	}

	if (!local.pressed) {
		touch_down(now);
	} else if (!local.down) {
		touch_up(now);
	} else if (abs(local.x - local.x0) > touch_radius / 4 ||
		   abs(local.y - local.y0) > touch_radius / 4) {
		local.moved = true;
	}

	local.pressed = local.down;
	local.last_ms = (uint32_t)now;
	local.source = CONTROL_TOUCH;
}

static void rc_event(struct input_event *evt)
{
	switch (evt->code) {
	case INPUT_ABS_RX:
		atomic_set(&axis_roll, evt->value);
		break;
	case INPUT_ABS_RY:
		atomic_set(&axis_pitch, evt->value);
		break;
	case INPUT_ABS_THROTTLE:
		atomic_set(&axis_throttle, evt->value);
		break;
	case INPUT_ABS_RUDDER:
		atomic_set(&axis_yaw, evt->value);
		break;
	default:
		return;
	}

	rc_pending = true;
}

static void input_cb(struct input_event *evt, void *user_data)
{
	int64_t now = k_uptime_get();
	k_spinlock_key_t key;
	int k;

	ARG_UNUSED(user_data);

	if (evt->dev != NULL && evt->dev == touch_dev) {
		key = k_spin_lock(&lock);
		touch_event(evt, now);
		k_spin_unlock(&lock, key);
		return;
	}

	if (evt->type == INPUT_EV_KEY && game != NULL) {
		k = key_of(evt->code);
		if (k >= 0) {
			key = k_spin_lock(&lock);
			press((enum key)k, evt->value != 0, now);
			local.last_ms = (uint32_t)now;
			local.source = CONTROL_KEYS;
			k_spin_unlock(&lock, key);
		}
	}

	if (evt->type == INPUT_EV_ABS) {
		rc_event(evt);
	}

	/* Without a receiver node, any device reporting the stick axes is the radio */
	if (evt->sync != 0U &&
	    (crsf_dev != NULL ? evt->dev == crsf_dev : rc_pending)) {
		atomic_set(&last_sync_ms, (atomic_val_t)(uint32_t)now);
		atomic_set(&link_seen, 1);
		rc_pending = false;
	}
}
INPUT_CALLBACK_DEFINE(NULL, input_cb, NULL);

static float stick(atomic_t *axis)
{
	float v = ((float)atomic_get(axis) - 1500.0f) / 500.0f;

	if (v > -0.04f && v < 0.04f) {
		return 0.0f;
	}

	return CLAMP(v, -1.0f, 1.0f);
}

static void read_radio(struct controls *ctl, bool alive)
{
	ctl->roll = stick(&axis_roll);
	ctl->pitch = stick(&axis_pitch);
	ctl->yaw = stick(&axis_yaw);
	ctl->throttle = CLAMP(((float)atomic_get(&axis_throttle) - 1000.0f) / 1000.0f, 0.0f, 1.0f);
	ctl->valid = alive;
	ctl->source = CONTROL_RC;
}

static void read_local(struct controls *ctl, int64_t now)
{
	bool flying = game->phase == PHASE_COUNTDOWN || game->phase == PHASE_FLYING ||
		      game->phase == PHASE_SIGNAL_LOST;
	k_spinlock_key_t key = k_spin_lock(&lock);
	float roll = 0.0f;
	float pitch = 0.0f;
	float yaw = 0.0f;

	roll += held(KEY_RIGHT, now) ? 1.0f : 0.0f;
	roll -= held(KEY_LEFT, now) ? 1.0f : 0.0f;
	pitch += held(KEY_UP, now) ? 1.0f : 0.0f;
	pitch -= held(KEY_DOWN, now) ? 1.0f : 0.0f;
	yaw += held(KEY_A, now) ? 1.0f : 0.0f;
	yaw -= held(KEY_B, now) ? 1.0f : 0.0f;

	/* The finger is a stick centered where it came down, taps do not steer */
	if (local.touching && local.moved) {
		roll += (float)(local.x - local.x0) / (float)touch_radius;
		pitch += (float)(local.y0 - local.y) / (float)touch_radius;
	}

	if (now < local.yaw_until) {
		yaw = local.yaw_dir;
	}

	if (flying) {
		ctl->throttle = CRUISE_THROTTLE;
	} else if (held(KEY_B, now) && held(KEY_UP, now)) {
		/* With B and up held, the stick command that opens the reset screen */
		ctl->throttle = 0.5f;
	} else {
		ctl->throttle = now < local.launch_until ? 1.0f : 0.0f;
	}

	ctl->roll = CLAMP(roll, -1.0f, 1.0f);
	ctl->pitch = CLAMP(pitch, -1.0f, 1.0f);
	ctl->yaw = CLAMP(yaw, -1.0f, 1.0f);
	ctl->valid = true;
	ctl->source = local.source;
	k_spin_unlock(&lock, key);
}

void controls_read(struct controls *ctl)
{
	int64_t now = k_uptime_get();
	uint32_t last_sync = (uint32_t)atomic_get(&last_sync_ms);
	bool alive = atomic_get(&link_seen) != 0 && (uint32_t)now - last_sync < LINK_TIMEOUT_MS;
	bool in_run = game->phase == PHASE_COUNTDOWN || game->phase == PHASE_FLYING ||
		      game->phase == PHASE_SIGNAL_LOST;

	/* A radio pilot who loses the link mid-run is waited for, unless someone takes over */
	if (alive || !(HAS_TOUCH || HAS_KEYS) ||
	    (in_run && last_source == CONTROL_RC && (int32_t)(local.last_ms - last_sync) < 0)) {
		read_radio(ctl, alive);
	} else {
		read_local(ctl, now);
	}

	if (IS_ENABLED(CONFIG_KITE_RUSH_INVERT_PITCH)) {
		ctl->pitch = -ctl->pitch;
	}

	last_source = ctl->source;
}

void controls_init(const struct game *g, const struct device *display)
{
	struct display_capabilities caps;

	game = g;
	display_get_capabilities(display, &caps);
	touch_radius = MIN(caps.x_resolution, caps.y_resolution) / 6;
	disp_h = caps.y_resolution;
	disp_w = caps.x_resolution;
}

const struct device *controls_receiver(void)
{
	return crsf_dev;
}
