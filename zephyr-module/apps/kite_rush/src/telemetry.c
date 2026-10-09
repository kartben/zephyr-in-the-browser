/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <math.h>
#include <string.h>

#include <zephyr/input/input_crsf.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>

#include "telemetry.h"

/*
 * Game state goes back to the radio in CRSF "Game" frames (type 0x3C,
 * extended header). Sub-commands 0x01 (add points) and 0x02 (command code)
 * follow the CRSF specification, 0x10 carries the full state for the radio
 * dashboard. EdgeTX hands these frames to Lua via crossfireTelemetryPop().
 */
#define CRSF_TYPE_GAME        0x3C
#define CRSF_ADDR_RADIO       0xEA
#define CRSF_ADDR_FC          0xC8
#define GAME_SUB_ADD_POINTS   0x01
#define GAME_SUB_COMMAND      0x02
#define GAME_SUB_STATE        0x10
#define GAME_STATE_VERSION    1

#define STATE_PERIOD_ACTIVE_MS 200
#define STATE_PERIOD_IDLE_MS   500
#define FLIGHT_MODE_PERIOD_MS  1000
#define ATTITUDE_PERIOD_MS     200

static const struct device *crsf_dev;
static int64_t last_state;
static int64_t last_flight_mode;
static int64_t last_attitude;
static enum game_phase last_phase = (enum game_phase)-1;

static void send_frame(uint8_t type, uint8_t *payload, size_t len)
{
	if (!IS_ENABLED(CONFIG_INPUT_CRSF) || crsf_dev == NULL) {
		return;
	}

	(void)input_crsf_send_telemetry(crsf_dev, type, payload, len);
}

static void send_game(uint8_t sub, const uint8_t *data, size_t len)
{
	uint8_t buf[3 + 24];

	if (len > sizeof(buf) - 3U) {
		return;
	}

	buf[0] = CRSF_ADDR_RADIO;
	buf[1] = CRSF_ADDR_FC;
	buf[2] = sub;
	memcpy(&buf[3], data, len);
	send_frame(CRSF_TYPE_GAME, buf, len + 3U);
}

void game_emit_event(enum game_event event, uint8_t arg)
{
	uint8_t data[2];

	sys_put_be16((uint16_t)(((uint16_t)event << 8) | arg), data);
	send_game(GAME_SUB_COMMAND, data, sizeof(data));
}

void game_emit_points(int32_t points)
{
	uint8_t data[2];

	sys_put_be16((uint16_t)(int16_t)CLAMP(points, INT16_MIN, INT16_MAX), data);
	send_game(GAME_SUB_ADD_POINTS, data, sizeof(data));
}

static void send_state(const struct game *g)
{
	uint8_t d[22];
	float roll = g->kite.bank * 57.3f;
	float alt = (g->kite.y - GAME_Y_MIN) / (GAME_Y_MAX - GAME_Y_MIN) * 100.0f;
	uint8_t flags = 0;

	if (g->armed) {
		flags |= BIT(0);
	}
	if (g->kite.roll_cooldown <= 0.0f) {
		flags |= BIT(1);
	}

	d[0] = (uint8_t)g->phase;
	d[1] = g->level;
	sys_put_be32(g->score, &d[2]);
	sys_put_be32(g->best, &d[6]);
	sys_put_be16((uint16_t)(MAX(g->sun, 0.0f) * 10.0f), &d[10]);
	sys_put_be16((uint16_t)(GAME_SUN_MAX * 10.0f), &d[12]);
	d[14] = g->combo;
	d[15] = (uint8_t)(game_speed_ratio(g) * 100.0f);
	sys_put_be16(g->gates_passed, &d[16]);
	d[18] = (uint8_t)(int8_t)CLAMP((int)roll, -90, 90);
	d[19] = (uint8_t)CLAMP((int)alt, 0, 100);
	d[20] = flags;
	d[21] = GAME_STATE_VERSION;

	send_game(GAME_SUB_STATE, d, sizeof(d));
}

static void send_flight_mode(const struct game *g)
{
	static const char *const names[] = {
		[PHASE_ATTRACT] = "KITE RUSH",
		[PHASE_COUNTDOWN] = "READY",
		[PHASE_FLYING] = "FLYING",
		[PHASE_GAME_OVER] = "GAME OVER",
		[PHASE_SIGNAL_LOST] = "NO SIGNAL",
		[PHASE_NAME_ENTRY] = "HIGH SCORE",
		[PHASE_RESET_CODE] = "KITE RUSH",
	};
	char text[16];

	strncpy(text, names[g->phase], sizeof(text) - 1U);
	text[sizeof(text) - 1U] = '\0';
	send_frame(CRSF_TYPE_FLIGHT_MODE, (uint8_t *)text, strlen(text) + 1U);
}

static void send_attitude(const struct game *g)
{
	struct crsf_payload_attitude att = {
		.pitch_rad = (int16_t)sys_cpu_to_be16(
			(uint16_t)(int16_t)(atan2f(g->kite.vy, g->kite.speed) * 10000.0f)),
		.roll_rad = (int16_t)sys_cpu_to_be16((uint16_t)(int16_t)(g->kite.bank * 10000.0f)),
		.yaw_rad = (int16_t)sys_cpu_to_be16(
			(uint16_t)(int16_t)(atan2f(g->kite.vx, g->kite.speed) * 10000.0f)),
	};

	send_frame(CRSF_TYPE_ATTITUDE, (uint8_t *)&att, sizeof(att));
}

void telemetry_init(const struct device *crsf)
{
	crsf_dev = crsf;
}

void telemetry_update(const struct game *g, int64_t now_ms)
{
	bool active = g->phase == PHASE_FLYING || g->phase == PHASE_COUNTDOWN;
	int64_t period = active ? STATE_PERIOD_ACTIVE_MS : STATE_PERIOD_IDLE_MS;

	if (now_ms - last_state >= period || g->phase != last_phase) {
		last_state = now_ms;
		send_state(g);
	}

	if (now_ms - last_flight_mode >= FLIGHT_MODE_PERIOD_MS || g->phase != last_phase) {
		last_flight_mode = now_ms;
		send_flight_mode(g);
	}

	if (g->phase == PHASE_FLYING && now_ms - last_attitude >= ATTITUDE_PERIOD_MS) {
		last_attitude = now_ms;
		send_attitude(g);
	}

	last_phase = g->phase;
}
