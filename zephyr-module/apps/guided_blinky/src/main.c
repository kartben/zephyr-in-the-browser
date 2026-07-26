/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Blinky, with the lesson attached.
 *
 * The code is stock samples/basic/blinky. What is added is the `@annotate`
 * comments, which read as ordinary comments and are stripped out of the copy
 * the browser displays, plus the SAMPLE_SHOW*() calls that decide when each one
 * appears. With CONFIG_SAMPLE_ANNOTATIONS off, all of it compiles away and this
 * is just blinky again.
 */

/* This translation unit owns the annotation table; see sample_annotation.h. */
#define SAMPLE_ANNOTATION_DEFINE_TABLE

#include <stdio.h>

#include <zephyr/drivers/gpio.h>
#include <zephyr/kernel.h>

#include <sample_annotation.h>
#include <sample_annotations_generated.h>

#define SLEEP_TIME_MS 1000

/* @annotate led_alias [gpio]
 * The pin is named by devicetree, not by this file
 *
 * Nothing in this file says which pin the LED is on, or which GPIO controller
 * drives it. `DT_ALIAS(led0)` resolves **at compile time** to whatever this
 * board's devicetree calls `led0`.
 *
 * That indirection is what lets one source file build for boards with
 * completely different GPIO hardware. Adding a board is a devicetree change
 * rather than a code change.
 */
#define LED0_NODE DT_ALIAS(led0)

/* @annotate led_spec [gpio]
 * `gpio_dt_spec` is filled in by the compiler
 *
 * `GPIO_DT_SPEC_GET` expands to a static initialiser holding three things: a
 * pointer to the controller device, the pin number, and the flags devicetree
 * gave that pin. Nothing is looked up at runtime and no string is parsed. By
 * the time `main()` starts, this struct is already in flash.
 *
 * Passing the whole spec to the `_dt` variants of the GPIO API keeps the pin
 * and its flags travelling together, so active-low handling cannot be honoured
 * at one call site and forgotten at another.
 */
static const struct gpio_dt_spec led = GPIO_DT_SPEC_GET(LED0_NODE, gpios);

int main(void)
{
	int ret;
	bool led_state = true;

	SAMPLE_SHOW_PAUSE(led_alias);
	SAMPLE_SHOW(led_spec);

	/* Which controller answered for `led0` depends on the board, and the
	 * name is worth showing because it is the one part of this that is not
	 * the same everywhere.
	 */
	SAMPLE_VALUE(led_spec, "%s pin %d", led.port->name, led.pin);

	/* @annotate driver_ready [gpio]
	 * Drivers are already running before `main()`
	 *
	 * Zephyr initialises devices during boot, in dependency order, well
	 * before the application starts. So this is not "start the driver". It
	 * asks whether the controller devicetree *declared* actually has a
	 * driver bound to it, and whether that driver's init succeeded.
	 *
	 * A node left `status = "okay"` for hardware no enabled driver matches
	 * reaches exactly this check and fails it.
	 */
	if (!gpio_is_ready_dt(&led)) {
		return 0;
	}
	SAMPLE_SHOW(driver_ready);

	/* @annotate configure_output [gpio]
	 * Claiming the pin, and what *active* means
	 *
	 * `gpio_pin_configure_dt()` sets the direction and the initial level in
	 * one call. `GPIO_OUTPUT_ACTIVE` means output, starting in its active
	 * state. *Active*, not *high*: if devicetree marked the pin
	 * `GPIO_ACTIVE_LOW`, the driver inverts the level for you and none of
	 * this code changes.
	 *
	 * Until this call the pin belongs to nobody. Configuring it is what
	 * claims it and fixes its direction.
	 */
	SAMPLE_SHOW_PAUSE(configure_output);
	ret = gpio_pin_configure_dt(&led, GPIO_OUTPUT_ACTIVE);
	if (ret < 0) {
		return 0;
	}

	while (1) {
		/* @annotate the_toggle [led]
		 * This is the line that does the work
		 *
		 * One call, and no register write in sight.
		 * `gpio_pin_toggle_dt()` goes through the GPIO API to whichever
		 * driver devicetree bound to the controller: memory-mapped
		 * registers on one board, a VIRTIO request on another. The
		 * sample cannot tell which, and does not need to.
		 *
		 * Toggling reads the current level and writes back the
		 * opposite, so it too goes through the active-low flag in the
		 * spec. It flips the logical level, not the electrical one.
		 */
		SAMPLE_ONCE(SAMPLE_SHOW_PAUSE(the_toggle));
		ret = gpio_pin_toggle_dt(&led);
		if (ret < 0) {
			return 0;
		}

		led_state = !led_state;
		printf("LED state: %s\n", led_state ? "ON" : "OFF");

		/* @annotate sleep_yields
		 * `k_msleep()` gives the CPU up
		 *
		 * This is not a delay loop. The calling thread comes off the
		 * run queue and a kernel timer is armed to put it back, so the
		 * scheduler is free to run other threads, or to idle the core
		 * until the timeout expires.
		 *
		 * It may only be called from a thread. Sleeping in an interrupt
		 * handler is a kernel error, which is why blinking from an ISR
		 * needs a `k_timer` or a work item instead.
		 *
		 * One caveat particular to running under emulation: the guest
		 * clock is not tied to real time on the interpreted boards, so
		 * this blinks faster than the one second it asks for.
		 */
		SAMPLE_ONCE(SAMPLE_SHOW(sleep_yields));
		k_msleep(SLEEP_TIME_MS);

		SAMPLE_ONCE(SAMPLE_END());
	}

	return 0;
}
