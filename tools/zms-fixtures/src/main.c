/*
 * Writes ZMS images for the page's ZMS viewer tests (src/lib/zmsBrowse.ts),
 * then prints each partition as hex for tools/zms-fixtures/dump.mjs to save.
 *
 * raw:      4 sectors of 1 KiB, enough rounds of writes to wrap through
 *           garbage collection twice, a delete, and an entry GC carries over.
 * settings: settings on ZMS: keys saved, overwritten and deleted.
 *
 * With CONFIG_ZMS_FIXTURES_BUSY (busy.conf + busy.overlay), only a settings
 * store in Kite Rush's geometry, rewritten until it has wrapped round.
 */

#include <stdio.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/kvss/zms.h>
#include <zephyr/settings/settings.h>
#include <zephyr/storage/flash_map.h>

#define RAW_PARTITION slot1_partition

static void dump(const char *name, uint8_t area_id)
{
	const struct flash_area *fa;
	uint8_t buf[32];

	if (flash_area_open(area_id, &fa) != 0) {
		printk("ZMSDUMP %s open failed\n", name);
		return;
	}
	for (off_t off = 0; off < fa->fa_size; off += sizeof(buf)) {
		flash_area_read(fa, off, buf, sizeof(buf));
		printk("ZMSDUMP %s %04lx ", name, (long)off);
		for (size_t i = 0; i < sizeof(buf); i++) {
			printk("%02x", buf[i]);
		}
		printk("\n");
	}
	flash_area_close(fa);
}

static int write_raw(void)
{
	static struct zms_fs fs;
	const struct flash_area *fa;
	char text[24];
	uint8_t blob[40];
	uint8_t big[200];
	int rc;

	rc = flash_area_open(PARTITION_ID(RAW_PARTITION), &fa);
	if (rc) {
		return rc;
	}
	fs.flash_device = fa->fa_dev;
	fs.offset = fa->fa_off;
	fs.sector_size = 1024;
	fs.sector_count = 4;
	flash_area_close(fa);

	rc = zms_mount(&fs);
	if (rc) {
		printk("zms_mount: %d\n", rc);
		return rc;
	}

	for (size_t i = 0; i < sizeof(big); i++) {
		big[i] = (uint8_t)i;
	}
	/* Written once, early: garbage collection has to carry it forward */
	zms_write(&fs, 0x12345678, big, sizeof(big));
	zms_write(&fs, 4, "keep me", 7);

	for (uint32_t round = 0; round < 70; round++) {
		snprintf(text, sizeof(text), "round %u", round);
		zms_write(&fs, 1, text, strlen(text) + 1);
		zms_write(&fs, 2, &round, sizeof(round));
		if (round < 20) {
			memset(blob, (int)round, sizeof(blob));
			zms_write(&fs, 3, blob, sizeof(blob));
		} else if (round == 20) {
			zms_delete(&fs, 3);
		}
	}

	printk("raw free space %zd\n", zms_calc_free_space(&fs));
	return 0;
}

#if defined(CONFIG_ZMS_FIXTURES_BUSY)
struct high_score {
	uint32_t score;
	char name[3];
	uint8_t level;
};

static int write_busy(void)
{
	static const struct high_score scores[8] = {
		{26585, "KAR", 7}, {21430, "ZEP", 6}, {18120, "BOT", 5}, {14735, "BOT", 5},
		{12960, "ANA", 4}, {9870, "BOT", 3}, {7340, "LEO", 3}, {5060, "BOT", 2},
	};
	char text[24];
	int rc;

	rc = settings_subsys_init();
	if (rc) {
		printk("settings_subsys_init: %d\n", rc);
		return rc;
	}
	settings_save_one("kite_rush/scores", scores, sizeof(scores));
	settings_save_one("player/name", "KAR", 3);
	settings_save_one("tmp/gone", "bye", 3);
	settings_delete("tmp/gone");
	for (uint32_t round = 0; round < 3000; round++) {
		settings_save_one("game/level", &round, sizeof(round));
		if (round % 3 == 0) {
			snprintf(text, sizeof(text), "t=%u ms", round * 16);
			settings_save_one("game/time", text, strlen(text));
		}
	}
	return 0;
}
#endif

#if defined(CONFIG_SETTINGS) && !defined(CONFIG_ZMS_FIXTURES_BUSY)
static int write_settings(void)
{
	uint32_t boots;
	uint8_t scores[64];
	int rc;

	rc = settings_subsys_init();
	if (rc) {
		printk("settings_subsys_init: %d\n", rc);
		return rc;
	}

	settings_save_one("app/name", "zephyr", 6);
	for (boots = 1; boots <= 3; boots++) {
		settings_save_one("app/boots", &boots, sizeof(boots));
	}
	for (size_t i = 0; i < sizeof(scores); i++) {
		scores[i] = (uint8_t)(0xa0 + i);
	}
	settings_save_one("kite_rush/scores", scores, sizeof(scores));
	settings_save_one("tmp/gone", "bye", 3);
	settings_delete("tmp/gone");
	return 0;
}
#endif

int main(void)
{
#if defined(CONFIG_ZMS_FIXTURES_BUSY)
	if (write_busy() == 0) {
		dump("busy", PARTITION_ID(storage_partition));
	}
	printk("ZMSDUMP done\n");
	return 0;
#endif
	if (write_raw() == 0) {
		dump("raw", PARTITION_ID(RAW_PARTITION));
	}
#if defined(CONFIG_SETTINGS) && !defined(CONFIG_ZMS_FIXTURES_BUSY)
	if (write_settings() == 0) {
		dump("settings", PARTITION_ID(storage_partition));
	}
#endif
	printk("ZMSDUMP done\n");
	return 0;
}
