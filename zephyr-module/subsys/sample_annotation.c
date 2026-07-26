/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Guest end of the sample annotation channel.
 *
 * Annotations travel to the browser as OSC 9700 escape sequences on the
 * console UART:
 *
 *     ESC ] 9700 ; v=1;k=show;a=3 ESC \
 *
 * The page registers an OSC handler for 9700 and consumes the sequence, so
 * nothing renders and the sample's own output stays clean. A terminal that has
 * never heard of us ignores an unknown OSC too, so an annotated sample is
 * still well-behaved on real hardware.
 *
 * Three things about the transport are load-bearing, and all three fail
 * silently if got wrong:
 *
 * 1. The record must not be interleaved with other console traffic. xterm's
 *    OSC parser swallows stray printable bytes *into* the payload, and a stray
 *    ESC ends the sequence early while still reporting success — so the page
 *    receives a truncated record it believes is complete. A k_mutex is not
 *    enough, because printk() goes through uart_console.c and takes no such
 *    lock; the write is wrapped in k_sched_lock() *and* irq_lock() instead.
 *    That is only tolerable because QEMU's PL011 / ns16550 / stellaris models
 *    never report a full TX FIFO, so uart_poll_out() returns immediately and
 *    the locked window is microseconds. On real hardware this would be a bad
 *    idea.
 *
 * 2. Payload bytes are escaped by whitelist. Inside an OSC string, xterm drops
 *    0x00-0x1f and 0x7f silently and never delivers 0x80-0xff at all, so a
 *    blacklist would leak exactly the bytes that vanish without trace.
 *
 * 3. The numeric ident has to be terminated by ';' or the whole sequence is
 *    discarded before the handler ever sees it.
 *
 * It writes straight to the console UART rather than through printk() so the
 * logging subsystem cannot split or reorder a record when it is in deferred
 * mode.
 */

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/init.h>
#include <zephyr/irq.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#include <sample_annotation.h>

#define CONSOLE_NODE DT_CHOSEN(zephyr_console)

static const struct device *const console_dev = DEVICE_DT_GET(CONSOLE_NODE);

/* Longest fixed record is the per-annotation table entry; values are capped
 * separately by CONFIG_SAMPLE_ANNOTATIONS_VALUE_LEN.
 */
#define RECORD_MAX (64 + CONFIG_SAMPLE_ANNOTATIONS_VALUE_LEN * 3)

static bool escape_needed(char c)
{
	if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') ||
	    (c >= '0' && c <= '9')) {
		return false;
	}
	return !(c == '.' || c == '_' || c == '~' || c == '-' || c == '/');
}

/** Percent-escape @p src into @p dst, stopping short rather than overflowing. */
static size_t escape_into(char *dst, size_t cap, const char *src)
{
	static const char HEX[] = "0123456789ABCDEF";
	size_t out = 0;

	for (; *src != '\0'; src++) {
		unsigned char c = (unsigned char)*src;

		if (!escape_needed((char)c)) {
			if (out + 1 >= cap) {
				break;
			}
			dst[out++] = (char)c;
		} else {
			if (out + 3 >= cap) {
				break;
			}
			dst[out++] = '%';
			dst[out++] = HEX[c >> 4];
			dst[out++] = HEX[c & 0x0f];
		}
	}
	dst[out] = '\0';
	return out;
}

/**
 * Push one complete record onto the console.
 *
 * @p body is everything between the ident and the terminator, already escaped.
 */
static void emit(const char *body)
{
	static const char PREFIX[] = "\033]9700;";
	static const char SUFFIX[] = "\033\\";
	unsigned int key;

	if (!device_is_ready(console_dev)) {
		return;
	}

	/* Hold off both the scheduler and interrupts so nothing else can write
	 * a byte into the middle of the sequence. See the note at the top.
	 */
	k_sched_lock();
	key = irq_lock();

	for (const char *p = PREFIX; *p != '\0'; p++) {
		uart_poll_out(console_dev, (unsigned char)*p);
	}
	for (const char *p = body; *p != '\0'; p++) {
		uart_poll_out(console_dev, (unsigned char)*p);
	}
	for (const char *p = SUFFIX; *p != '\0'; p++) {
		uart_poll_out(console_dev, (unsigned char)*p);
	}

	irq_unlock(key);
	k_sched_unlock();
}

void sample_annotation_show(uint16_t id, bool pause)
{
	char body[RECORD_MAX];

	(void)snprintk(body, sizeof(body), "v=1;k=%s;a=%u",
		       pause ? "pause" : "show", (unsigned int)id);
	emit(body);
}

void sample_annotation_reveal(const char *panel)
{
	char body[RECORD_MAX];
	char safe[32];

	(void)escape_into(safe, sizeof(safe), panel);
	(void)snprintk(body, sizeof(body), "v=1;k=reveal;t=%s", safe);
	emit(body);
}

void sample_annotation_value(uint16_t id, const char *text)
{
	char body[RECORD_MAX];
	char safe[CONFIG_SAMPLE_ANNOTATIONS_VALUE_LEN * 3 + 1];

	(void)escape_into(safe, sizeof(safe), text);
	(void)snprintk(body, sizeof(body), "v=1;k=value;a=%u;d=%s",
		       (unsigned int)id, safe);
	emit(body);
}

void sample_annotation_end(void)
{
	emit("v=1;k=end");
}

/**
 * Announce every annotation this build linked in, before main() runs.
 *
 * The page needs the whole set up front to draw a walkthrough outline — "step
 * 2 of 6", with the steps still to come greyed out. One small record per
 * entry, then a closing count, so nothing has to be sized against the number
 * of annotations.
 */
static int sample_annotation_announce(void)
{
	char body[RECORD_MAX];
	unsigned int count = 0;

	STRUCT_SECTION_FOREACH(sample_annotation, ann) {
		(void)snprintk(body, sizeof(body), "v=1;k=ann;a=%u;l=%u",
			       (unsigned int)ann->id, (unsigned int)ann->line);
		emit(body);
		count++;
	}

	(void)snprintk(body, sizeof(body), "v=1;k=table;n=%u", count);
	emit(body);
	return 0;
}

/* APPLICATION, so the console driver is long since up and the page has the
 * outline before the sample prints its first line.
 */
SYS_INIT(sample_annotation_announce, APPLICATION,
	 CONFIG_APPLICATION_INIT_PRIORITY);
