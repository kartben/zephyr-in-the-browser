/*
 * Copyright (c) 2026 Benjamin Cabé <benjamin@zephyrproject.org>
 *
 * Exercises the vendored virtio,blk disk driver
 * (zephyr-module/drivers/vendor/virtio_blk.c, from
 * https://github.com/zephyrproject-rtos/zephyr/pull/112581).
 *
 * The device is a stock QEMU virtio-blk over a raw image the page allocates
 * blank in the Emscripten filesystem, so the first boot of a session finds an
 * unformatted disk and mkfs's it. There is no persistence across a page reload
 * yet — the counter restarting at 1 is the expected, and visible, consequence.
 *
 * Two layers on purpose:
 *
 *   1. The Disk Access API directly, so the driver's own feature negotiation
 *      (capacity, negotiated logical block size) is on the terminal even if
 *      the filesystem above it never comes up.
 *   2. FatFS on top, which is what actually drives sustained scatter-gather
 *      traffic through the virtqueue.
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <zephyr/kernel.h>
#include <zephyr/device.h>
#include <zephyr/drivers/disk.h>
#include <zephyr/fs/fs.h>
#include <zephyr/logging/log.h>
#include <zephyr/storage/disk_access.h>

LOG_MODULE_REGISTER(virtio_blk_fs, LOG_LEVEL_INF);

#define DISK_NODE  DT_NODELABEL(virtio_blk0)
#define FSTAB_NODE DT_NODELABEL(fatfs0)

BUILD_ASSERT(DT_NODE_HAS_STATUS(DISK_NODE, okay),
	     "no enabled virtio,blk node — build with -S virtio-blk");
BUILD_ASSERT(DT_NODE_HAS_STATUS(FSTAB_NODE, okay),
	     "no fatfs fstab entry — build with -S virtio-blk");

#define DISK_NAME  DT_PROP(DISK_NODE, disk_name)
#define MOUNT_ROOT FSTAB_ENTRY_DT_MOUNT_POINT(FSTAB_NODE)

#define BOOT_COUNT_PATH MOUNT_ROOT "/boot.cnt"
#define SESSION_LOG_PATH MOUNT_ROOT "/session.log"

/* One line every few seconds, so the disk keeps moving after the boot report. */
#define LOG_PERIOD_S 3

/* fat_fs.c defines the mount struct from the fstab node; this names it. */
FS_FSTAB_DECLARE_ENTRY(FSTAB_NODE);

static struct fs_mount_t *const mp = &FS_FSTAB_ENTRY(FSTAB_NODE);

/*
 * Capacity straight from the driver, before any filesystem exists. Sector size
 * is the interesting number: the driver reports what it negotiated with the
 * device (VIRTIO_BLK_F_BLK_SIZE) rather than the 512-byte protocol sector.
 */
static int report_disk(void)
{
	uint32_t sector_count = 0;
	uint32_t sector_size = 0;
	int rc;

	rc = disk_access_init(DISK_NAME);
	if (rc != 0) {
		LOG_ERR("disk_access_init(%s) failed: %d", DISK_NAME, rc);
		return rc;
	}

	rc = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_COUNT, &sector_count);
	if (rc != 0) {
		LOG_ERR("GET_SECTOR_COUNT failed: %d", rc);
		return rc;
	}

	rc = disk_access_ioctl(DISK_NAME, DISK_IOCTL_GET_SECTOR_SIZE, &sector_size);
	if (rc != 0) {
		LOG_ERR("GET_SECTOR_SIZE failed: %d", rc);
		return rc;
	}

	printk("disk %s: %u sectors x %u B = %llu KiB\n", DISK_NAME, sector_count, sector_size,
	       ((uint64_t)sector_count * sector_size) / 1024U);
	return 0;
}

/* Read, bump and write back the boot counter. Returns the new value, or < 0. */
static int bump_boot_count(void)
{
	struct fs_file_t file;
	uint32_t count = 0;
	int rc;

	fs_file_t_init(&file);

	rc = fs_open(&file, BOOT_COUNT_PATH, FS_O_CREATE | FS_O_RDWR);
	if (rc != 0) {
		LOG_ERR("open %s failed: %d", BOOT_COUNT_PATH, rc);
		return rc;
	}

	/* A short read is the first-boot case: the file was just created. */
	rc = fs_read(&file, &count, sizeof(count));
	if (rc < 0) {
		LOG_ERR("read %s failed: %d", BOOT_COUNT_PATH, rc);
		goto out;
	}
	if (rc != sizeof(count)) {
		count = 0;
	}

	count++;

	rc = fs_seek(&file, 0, FS_SEEK_SET);
	if (rc != 0) {
		LOG_ERR("seek %s failed: %d", BOOT_COUNT_PATH, rc);
		goto out;
	}

	rc = fs_write(&file, &count, sizeof(count));
	if (rc < 0) {
		LOG_ERR("write %s failed: %d", BOOT_COUNT_PATH, rc);
		goto out;
	}

	rc = (int)count;
out:
	(void)fs_close(&file);
	return rc;
}

static void list_volume(void)
{
	struct fs_dir_t dir;
	struct fs_dirent entry;
	int rc;

	fs_dir_t_init(&dir);

	rc = fs_opendir(&dir, MOUNT_ROOT);
	if (rc != 0) {
		LOG_ERR("opendir %s failed: %d", MOUNT_ROOT, rc);
		return;
	}

	/* The mount point already ends in the FatFS volume colon. */
	printk("%s\n", MOUNT_ROOT);
	while (fs_readdir(&dir, &entry) == 0 && entry.name[0] != '\0') {
		printk("  %-12s %s %zu B\n", entry.name,
		       entry.type == FS_DIR_ENTRY_DIR ? "<dir> " : "<file>", entry.size);
	}

	(void)fs_closedir(&dir);
}

/* Append one line, opening and closing each time so the data really lands. */
static int append_line(uint32_t seq)
{
	struct fs_file_t file;
	char line[64];
	int len;
	int rc;

	fs_file_t_init(&file);

	rc = fs_open(&file, SESSION_LOG_PATH, FS_O_CREATE | FS_O_WRITE | FS_O_APPEND);
	if (rc != 0) {
		return rc;
	}

	len = snprintk(line, sizeof(line), "%08u uptime=%llums\n", seq, k_uptime_get());
	rc = fs_write(&file, line, len);

	(void)fs_close(&file);
	return rc < 0 ? rc : 0;
}

int main(void)
{
	uint32_t seq = 0;
	int rc;

	printk("\n*** virtio-blk disk demo ***\n");

	rc = report_disk();
	if (rc != 0) {
		return 0;
	}

	/*
	 * The image starts blank, so the first mount of a session fails to find
	 * a filesystem and CONFIG_FS_FATFS_MOUNT_MKFS formats it in place. That
	 * is reported rather than hidden: it is the moment the driver's write
	 * path is first exercised.
	 */
	rc = fs_mount(mp);
	if (rc != 0) {
		LOG_ERR("mount %s failed: %d", mp->mnt_point, rc);
		return 0;
	}
	printk("mounted %s\n", mp->mnt_point);

	rc = bump_boot_count();
	if (rc < 0) {
		return 0;
	}
	printk("boot count: %d\n", rc);

	list_volume();

	printk("appending to %s every %d s\n", SESSION_LOG_PATH, LOG_PERIOD_S);

	while (1) {
		k_sleep(K_SECONDS(LOG_PERIOD_S));

		rc = append_line(seq);
		if (rc != 0) {
			LOG_ERR("append failed: %d", rc);
			return 0;
		}
		printk("wrote line %u\n", seq);
		seq++;
	}

	return 0;
}
