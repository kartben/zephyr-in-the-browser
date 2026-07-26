/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Teaching annotations for Zephyr samples.
 *
 * A sample carries its explanations in ordinary block comments, next to the
 * construct each one is about:
 *
 *     |* @annotate led_from_devicetree [led]
 *      * The pin comes from devicetree
 *      *
 *      * `DT_ALIAS(led0)` resolves at compile time to whatever this board's
 *      * devicetree calls `led0` — the sample never names a pin.
 *      *|
 *     #define LED0_NODE DT_ALIAS(led0)
 *
 * and fires them from statements, which is the only place a macro can run:
 *
 *     SAMPLE_SHOW_PAUSE(led_from_devicetree);
 *
 * The split is not stylistic. A macro sitting above a `#define` is at file
 * scope and would never execute, so the anchor (where the explanation points)
 * and the trigger (when it appears) have to be different things.
 *
 * tools/extract-annotations.py turns those comments into annotations.json for
 * the browser and a generated header for the firmware. The prose never reaches
 * the guest: each annotation costs four bytes of ROM here — an id and the line
 * it points at — and the record that goes out over the console is just the id.
 *
 * Everything below compiles to nothing when CONFIG_SAMPLE_ANNOTATIONS is off,
 * which is the default. An annotated sample is byte-identical to an
 * unannotated one unless someone asks for the lesson.
 */

#ifndef SAMPLE_ANNOTATION_H_
#define SAMPLE_ANNOTATION_H_

#include <stdbool.h>
#include <stdint.h>

#include <zephyr/sys/iterable_sections.h>
#include <zephyr/sys/printk.h>
#include <zephyr/toolchain.h>

#ifdef __cplusplus
extern "C" {
#endif

/**
 * One annotation as the firmware knows it.
 *
 * @p line is not used by the guest; it travels so the page can tell an
 * annotations.json that has drifted from the binary sitting next to it. The
 * two are separate build artifacts fetched over separate requests, so that
 * really can happen.
 */
struct sample_annotation {
	uint16_t id;
	uint16_t line;
};

#ifdef CONFIG_SAMPLE_ANNOTATIONS

/** Emit an annotation. When @p pause, the page freezes the machine on it. */
void sample_annotation_show(uint16_t id, bool pause);

/** Point the device dock at a panel without saying anything. */
void sample_annotation_reveal(const char *panel);

/** Attach a live value to an annotation the reader is looking at. */
void sample_annotation_value(uint16_t id, const char *text);

/** The walkthrough is over; the sample runs free from here. */
void sample_annotation_end(void);

/**
 * Instantiate one table entry. Emitted by the generated header, and only in
 * the translation unit that defines SAMPLE_ANNOTATION_DEFINE_TABLE — the
 * header is included by every file that fires an annotation, but the table
 * itself must exist exactly once.
 */
#define SAMPLE_ANNOTATION_ENTRY(_id, _key, _line)                              \
	const STRUCT_SECTION_ITERABLE(sample_annotation, _sample_ann_##_key) = \
		{                                                              \
			.id = (_id),                                           \
			.line = (_line),                                       \
		};

#define SAMPLE_SHOW(_key) sample_annotation_show(SAMPLE_ANN_##_key, false)
#define SAMPLE_SHOW_PAUSE(_key) sample_annotation_show(SAMPLE_ANN_##_key, true)
#define SAMPLE_REVEAL(_panel) sample_annotation_reveal(#_panel)
#define SAMPLE_END() sample_annotation_end()

/**
 * Format a value and attach it to @p _key's popup.
 *
 * The formatted text is the one thing here that costs real bytes, so it is
 * capped at CONFIG_SAMPLE_ANNOTATIONS_VALUE_LEN and truncated rather than
 * growing a buffer.
 */
#define SAMPLE_VALUE(_key, ...)                                                \
	do {                                                                   \
		char _sa_buf[CONFIG_SAMPLE_ANNOTATIONS_VALUE_LEN];             \
		(void)snprintk(_sa_buf, sizeof(_sa_buf), __VA_ARGS__);         \
		sample_annotation_value(SAMPLE_ANN_##_key, _sa_buf);           \
	} while (false)

/**
 * Run @p _stmt only the first time control reaches it.
 *
 * Most annotations sit inside the sample's main loop, and a popup that
 * reappeared on every iteration would be unusable.
 */
#define SAMPLE_ONCE(_stmt)                                                     \
	do {                                                                   \
		static bool _sa_done;                                          \
		if (!_sa_done) {                                               \
			_sa_done = true;                                       \
			_stmt;                                                 \
		}                                                              \
	} while (false)

#else /* !CONFIG_SAMPLE_ANNOTATIONS */

/*
 * The feature off: every macro vanishes, including the table. `_key` and the
 * arguments are deliberately left unevaluated — an annotation must not be able
 * to change what the sample does.
 */
#define SAMPLE_ANNOTATION_ENTRY(_id, _key, _line)
#define SAMPLE_SHOW(_key)                                                      \
	do {                                                                   \
	} while (false)
#define SAMPLE_SHOW_PAUSE(_key)                                                \
	do {                                                                   \
	} while (false)
#define SAMPLE_REVEAL(_panel)                                                  \
	do {                                                                   \
	} while (false)
#define SAMPLE_END()                                                           \
	do {                                                                   \
	} while (false)
#define SAMPLE_VALUE(_key, ...)                                                \
	do {                                                                   \
	} while (false)
#define SAMPLE_ONCE(_stmt) _stmt

#endif /* CONFIG_SAMPLE_ANNOTATIONS */

#ifdef __cplusplus
}
#endif

#endif /* SAMPLE_ANNOTATION_H_ */
