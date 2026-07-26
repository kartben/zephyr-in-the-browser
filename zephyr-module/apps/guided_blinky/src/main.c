/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Blinky, with the lesson attached.
 *
 * The code is stock samples/basic/blinky. What is added is the `@annotate`
 * comments — which read as ordinary comments, and are stripped out of the copy
 * the browser displays — and the SAMPLE_SHOW*() calls that decide when each one
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

/* @annotate led_alias [led]
 * The pin is named by devicetree, not by this file
 *
 * Nothing here says which pin the LED is on, or even which GPIO controller
 * drives it. `DT_ALIAS(led0)` resolves **at compile time** to whatever the
 * board's devicetree calls `led0` — a different node on every board this
 * builds for, with the same source.
 *
 * Open the devicetree viewer in the top bar to see the node this build
 * resolved to.
 */
#define LED0_NODE DT_ALIAS(led0)

/* @annotate led_spec [led]
 * `gpio_dt_spec` is a struct the compiler fills in
 *
 * `GPIO_DT_SPEC_GET` expands to a static initialiser holding three things: a
 * pointer to the controller device, the pin number, and the flags devicetree
 * gave it. There is no lookup at runtime and no string to parse — by the time
 * `main()` starts, this struct is already in flash.
 *
 * That is why the same binary cannot be pointed at a different pin without
 * rebuilding, and why a board port is a devicetree change rather than a code
 * change.
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

	/* @annotate driver_ready
	 * The driver is already running before `main()`
	 *
	 * Zephyr initialises devices during boot, in dependency order, well
	 * before the application starts. So this is not "start the driver" —
	 * it is a check that the controller devicetree *declared* actually has
	 * a driver bound to it and that the driver's init succeeded.
	 *
	 * A node with `status = "okay"` but no matching driver reaches exactly
	 * here and fails.
	 */
	if (!gpio_is_ready_dt(&led)) {
		return 0;
	}
	SAMPLE_SHOW(driver_ready);

	/* @annotate configure_output [led]
	 * Claiming the pin, before anything drives it
	 *
	 * `gpio_pin_configure_dt()` sets the direction and the initial level in
	 * one call. `GPIO_OUTPUT_ACTIVE` means "output, and start it active" —
	 * *active*, not *high*: if devicetree marked the pin `GPIO_ACTIVE_LOW`,
	 * the driver inverts it for you and this code does not change.
	 *
	 * The LED row in the device dock is still dark. Continue, and watch it.
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
		 * One call, no register write in sight. `gpio_pin_toggle_dt()`
		 * goes through the GPIO API to whichever driver the devicetree
		 * bound — memory-mapped registers on one board, a VIRTIO
		 * request to the browser on another. The sample cannot tell,
		 * and does not need to.
		 *
		 * The machine is stopped. Continue, and the LED lights.
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
		 * This is not a delay loop. The thread is taken off the run
		 * queue and a timer is armed to put it back, so the scheduler
		 * is free to run anything else — or to idle the core. In a
		 * one-thread sample there is nothing else, which is why the
		 * MIPS readout drops while this blinks.
		 *
		 * The blink is not wall-clock accurate here: the emulator runs
		 * the guest clock faster than real time on the interpreted
		 * boards.
		 */
		SAMPLE_ONCE(SAMPLE_SHOW(sleep_yields));
		k_msleep(SLEEP_TIME_MS);

		SAMPLE_ONCE(SAMPLE_END());
	}

	return 0;
}
