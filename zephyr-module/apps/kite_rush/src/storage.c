/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 * SPDX-License-Identifier: Apache-2.0
 */

#include <errno.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/settings/settings.h>
#include <zephyr/sys/util.h>

#include "storage.h"

LOG_MODULE_REGISTER(storage, LOG_LEVEL_INF);

/*
 * The high score table is one settings entry. Without the settings subsystem
 * the table only lives until the next reset.
 */
#define SCORES_KEY "kite_rush/scores"

struct load_ctx {
	struct high_score *scores;
	size_t size;
	bool found;
};

static int load_cb(const char *key, size_t len, settings_read_cb read_cb, void *cb_arg,
		   void *param)
{
	struct load_ctx *ctx = param;
	ssize_t ret;

	/* Only the exact key, and a table of the current layout */
	if (key != NULL || len != ctx->size) {
		return 0;
	}

	ret = read_cb(cb_arg, ctx->scores, ctx->size);
	if (ret == (ssize_t)ctx->size) {
		ctx->found = true;
	}

	return 0;
}

int storage_load_scores(struct high_score *scores, size_t count)
{
	struct load_ctx ctx = {
		.scores = scores,
		.size = count * sizeof(*scores),
	};
	int ret;

	if (!IS_ENABLED(CONFIG_SETTINGS)) {
		return -ENOENT;
	}

	ret = settings_subsys_init();
	if (ret < 0) {
		LOG_WRN("No settings storage (%d), high scores are not kept", ret);
		return ret;
	}

	ret = settings_load_subtree_direct(SCORES_KEY, load_cb, &ctx);
	if (ret < 0) {
		LOG_WRN("Cannot load the high scores (%d)", ret);
		return ret;
	}

	if (!ctx.found) {
		memset(scores, 0, ctx.size);
		return -ENOENT;
	}

	LOG_INF("High scores loaded, best %u by %.3s", scores[0].score, scores[0].name);

	return 0;
}

void game_store_scores(const struct high_score *scores, size_t count)
{
	int ret;

	if (!IS_ENABLED(CONFIG_SETTINGS)) {
		return;
	}

	ret = settings_save_one(SCORES_KEY, scores, count * sizeof(*scores));
	if (ret < 0) {
		LOG_WRN("Cannot save the high scores (%d)", ret);
	}
}
