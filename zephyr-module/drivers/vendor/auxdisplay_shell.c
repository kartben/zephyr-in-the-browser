/*
 * SPDX-FileCopyrightText: Copyright The Zephyr Project Contributors
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#include <string.h>
#include <zephyr/drivers/auxdisplay.h>
#include <zephyr/shell/shell.h>

#define AUXD_ARGV_DEVICE 1
#define AUXD_ARGV_ARG0   2
#define AUXD_ARGV_ARG1   3
#define AUXD_ARGV_TEXT   2
#define AUXD_ARGV_X      3
#define AUXD_ARGV_Y      4

static int get_auxdisplay_device(const struct shell *sh, const char *name,
				 const struct device **dev)
{
	*dev = shell_device_get_binding(name);
	if (!device_is_ready(*dev)) {
		shell_error(sh, "Auxiliary display device not %s",
			    *dev == NULL ? "found" : "ready");
		return -ENODEV;
	}

	return 0;
}

static int report_error(const struct shell *sh, const char *feature, int err)
{
	if (err == -ENOSYS || err == -ENOTSUP) {
		shell_error(sh, "Device does not support %s", feature);
	} else {
		shell_error(sh, "Failed to %s (err %d)", feature, err);
	}

	return err;
}

static int parse_on_off(const struct shell *sh, const char *arg, bool *enabled)
{
	int err = 0;

	*enabled = shell_strtobool(arg, 0, &err);
	if (err < 0) {
		shell_error(sh, "Invalid value '%s', use on/off", arg);
		return -EINVAL;
	}

	return 0;
}

static int parse_u8(const struct shell *sh, const char *arg, uint8_t *value)
{
	unsigned long val;
	int err = 0;

	val = shell_strtoul(arg, 0, &err);
	if (err < 0 || val > UINT8_MAX) {
		shell_error(sh, "Invalid level '%s'", arg);
		return -EINVAL;
	}

	*value = (uint8_t)val;
	return 0;
}

static int parse_i16(const struct shell *sh, const char *arg, const char *name, int16_t *value)
{
	long val;
	int err = 0;

	val = shell_strtol(arg, 0, &err);
	if (err < 0 || val < INT16_MIN || val > INT16_MAX) {
		shell_error(sh, "Error parsing %s position", name);
		return -EINVAL;
	}

	*value = (int16_t)val;
	return 0;
}

static bool light_is_supported(const struct auxdisplay_light *light)
{
	return !(light->minimum == AUXDISPLAY_LIGHT_NOT_SUPPORTED &&
		 light->maximum == AUXDISPLAY_LIGHT_NOT_SUPPORTED);
}

static void print_light_caps(const struct shell *sh, const char *name,
			     const struct auxdisplay_light *light)
{
	if (light_is_supported(light)) {
		shell_print(sh, "%s: %u .. %u", name, light->minimum, light->maximum);
	} else {
		shell_print(sh, "%s: unsupported", name);
	}
}

static int cmd_clear(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev;
	int err;

	ARG_UNUSED(argc);

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	err = auxdisplay_clear(dev);
	if (err < 0) {
		return report_error(sh, "clear", err);
	}

	return 0;
}

static int cmd_size(const struct shell *sh, size_t argc, char **argv)
{
	struct auxdisplay_capabilities capabilities;
	const struct device *dev;
	int err;

	ARG_UNUSED(argc);

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	err = auxdisplay_capabilities_get(dev, &capabilities);
	if (err < 0) {
		return report_error(sh, "capabilities", err);
	}

	shell_print(sh, "%u rows, %u columns", capabilities.rows, capabilities.columns);
	shell_print(sh, "mode: 0x%x", capabilities.mode);
	print_light_caps(sh, "brightness", &capabilities.brightness);
	print_light_caps(sh, "backlight", &capabilities.backlight);
	shell_print(sh, "custom characters: %u (%ux%u)", capabilities.custom_characters,
		    capabilities.custom_character_width, capabilities.custom_character_height);

	return 0;
}

static int cmd_write(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev;
	int16_t x = 0;
	int16_t y = 0;
	size_t len;
	int err;

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	if (argc > AUXD_ARGV_X) {
		err = parse_i16(sh, argv[AUXD_ARGV_X], "X", &x);
		if (err < 0) {
			return err;
		}

		if (argc > AUXD_ARGV_Y) {
			err = parse_i16(sh, argv[AUXD_ARGV_Y], "Y", &y);
			if (err < 0) {
				return err;
			}
		}

		err = auxdisplay_cursor_position_set(dev, AUXDISPLAY_POSITION_ABSOLUTE, x, y);
		if (err < 0) {
			return report_error(sh, "cursor position", err);
		}
	}

	len = strlen(argv[AUXD_ARGV_TEXT]);
	if (len > UINT16_MAX) {
		shell_error(sh, "Text too long");
		return -EINVAL;
	}

	err = auxdisplay_write(dev, (const uint8_t *)argv[AUXD_ARGV_TEXT], (uint16_t)len);
	if (err < 0) {
		return report_error(sh, "write", err);
	}

	return 0;
}

static int cmd_on(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev;
	int err;

	ARG_UNUSED(argc);

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	err = auxdisplay_display_on(dev);
	if (err < 0) {
		return report_error(sh, "display on", err);
	}

	return 0;
}

static int cmd_off(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev;
	int err;

	ARG_UNUSED(argc);

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	err = auxdisplay_display_off(dev);
	if (err < 0) {
		return report_error(sh, "display off", err);
	}

	return 0;
}

static int cmd_cursor(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev;
	bool enabled;
	int err;

	ARG_UNUSED(argc);

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	err = parse_on_off(sh, argv[AUXD_ARGV_ARG0], &enabled);
	if (err < 0) {
		return err;
	}

	err = auxdisplay_cursor_set_enabled(dev, enabled);
	if (err < 0) {
		return report_error(sh, "cursor", err);
	}

	return 0;
}

static int cmd_blink(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev;
	bool enabled;
	int err;

	ARG_UNUSED(argc);

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	err = parse_on_off(sh, argv[AUXD_ARGV_ARG0], &enabled);
	if (err < 0) {
		return err;
	}

	err = auxdisplay_position_blinking_set_enabled(dev, enabled);
	if (err < 0) {
		return report_error(sh, "blink", err);
	}

	return 0;
}

static int cmd_brightness(const struct shell *sh, size_t argc, char **argv)
{
	struct auxdisplay_capabilities capabilities;
	const struct device *dev;
	uint8_t brightness;
	int err;

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	if (argc > AUXD_ARGV_ARG0) {
		err = parse_u8(sh, argv[AUXD_ARGV_ARG0], &brightness);
		if (err < 0) {
			return err;
		}

		err = auxdisplay_brightness_set(dev, brightness);
		if (err < 0) {
			return report_error(sh, "brightness", err);
		}

		return 0;
	}

	err = auxdisplay_brightness_get(dev, &brightness);
	if (err < 0) {
		return report_error(sh, "brightness", err);
	}

	shell_print(sh, "brightness: %u", brightness);

	err = auxdisplay_capabilities_get(dev, &capabilities);
	if (err == 0 && light_is_supported(&capabilities.brightness)) {
		shell_print(sh, "range: %u .. %u", capabilities.brightness.minimum,
			    capabilities.brightness.maximum);
	}

	return 0;
}

static int cmd_backlight(const struct shell *sh, size_t argc, char **argv)
{
	struct auxdisplay_capabilities capabilities;
	const struct device *dev;
	uint8_t backlight;
	int err;

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	if (argc > AUXD_ARGV_ARG0) {
		err = parse_u8(sh, argv[AUXD_ARGV_ARG0], &backlight);
		if (err < 0) {
			return err;
		}

		err = auxdisplay_backlight_set(dev, backlight);
		if (err < 0) {
			return report_error(sh, "backlight", err);
		}

		return 0;
	}

	err = auxdisplay_backlight_get(dev, &backlight);
	if (err < 0) {
		return report_error(sh, "backlight", err);
	}

	shell_print(sh, "backlight: %u", backlight);

	err = auxdisplay_capabilities_get(dev, &capabilities);
	if (err == 0 && light_is_supported(&capabilities.backlight)) {
		shell_print(sh, "range: %u .. %u", capabilities.backlight.minimum,
			    capabilities.backlight.maximum);
	}

	return 0;
}

static int cmd_cursor_pos(const struct shell *sh, size_t argc, char **argv)
{
	const struct device *dev;
	int16_t x;
	int16_t y;
	int err;

	err = get_auxdisplay_device(sh, argv[AUXD_ARGV_DEVICE], &dev);
	if (err < 0) {
		return err;
	}

	if (argc > AUXD_ARGV_ARG0) {
		if (argc < 4) {
			shell_error(sh, "Both X and Y positions are required");
			return -EINVAL;
		}

		err = parse_i16(sh, argv[AUXD_ARGV_ARG0], "X", &x);
		if (err < 0) {
			return err;
		}

		err = parse_i16(sh, argv[AUXD_ARGV_ARG1], "Y", &y);
		if (err < 0) {
			return err;
		}

		err = auxdisplay_cursor_position_set(dev, AUXDISPLAY_POSITION_ABSOLUTE, x, y);
		if (err < 0) {
			return report_error(sh, "cursor position", err);
		}

		return 0;
	}

	err = auxdisplay_cursor_position_get(dev, &x, &y);
	if (err < 0) {
		return report_error(sh, "cursor position", err);
	}

	shell_print(sh, "cursor: x=%d y=%d", x, y);

	return 0;
}

static bool device_is_auxdisplay(const struct device *dev)
{
	return DEVICE_API_IS(auxdisplay, dev);
}

static void on_off_get(size_t idx, struct shell_static_entry *entry)
{
	entry->handler = NULL;
	entry->help = NULL;
	entry->subcmd = NULL;

	switch (idx) {
	case 0:
		entry->syntax = "on";
		break;
	case 1:
		entry->syntax = "off";
		break;
	default:
		entry->syntax = NULL;
		break;
	}
}

SHELL_DYNAMIC_CMD_CREATE(dsub_on_off, on_off_get);

/* Device name autocompletion support */
static void device_name_get(size_t idx, struct shell_static_entry *entry)
{
	const struct device *dev = shell_device_filter(idx, device_is_auxdisplay);

	entry->syntax = (dev != NULL) ? dev->name : NULL;
	entry->handler = NULL;
	entry->help = NULL;
	entry->subcmd = NULL;
}

SHELL_DYNAMIC_CMD_CREATE(dsub_device_name, device_name_get);

static void device_name_get_on_off(size_t idx, struct shell_static_entry *entry)
{
	const struct device *dev = shell_device_filter(idx, device_is_auxdisplay);

	entry->syntax = (dev != NULL) ? dev->name : NULL;
	entry->handler = NULL;
	entry->help = NULL;
	entry->subcmd = &dsub_on_off;
}

SHELL_DYNAMIC_CMD_CREATE(dsub_device_name_on_off, device_name_get_on_off);

/* clang-format off */
SHELL_STATIC_SUBCMD_SET_CREATE(
	auxdisplay_cmds,
	SHELL_CMD_ARG(backlight, &dsub_device_name,
		      SHELL_HELP("Get or set backlight level", "<device> [level]"),
		      cmd_backlight, 2, 1),
	SHELL_CMD_ARG(blink, &dsub_device_name_on_off,
		      SHELL_HELP("Enable or disable cursor position blink",
				 "<device> <on|off>"),
		      cmd_blink, 3, 0),
	SHELL_CMD_ARG(brightness, &dsub_device_name,
		      SHELL_HELP("Get or set brightness level", "<device> [level]"),
		      cmd_brightness, 2, 1),
	SHELL_CMD_ARG(clear, &dsub_device_name,
		      SHELL_HELP("Clear the auxiliary display", "<device>"),
		      cmd_clear, 2, 0),
	SHELL_CMD_ARG(cursor, &dsub_device_name_on_off,
		      SHELL_HELP("Enable or disable the cursor", "<device> <on|off>"),
		      cmd_cursor, 3, 0),
	SHELL_CMD_ARG(cursor_pos, &dsub_device_name,
		      SHELL_HELP("Get or set absolute cursor position",
				 "<device> [<x> <y>]"),
		      cmd_cursor_pos, 2, 2),
	SHELL_CMD_ARG(off, &dsub_device_name,
		      SHELL_HELP("Turn the display off", "<device>"),
		      cmd_off, 2, 0),
	SHELL_CMD_ARG(on, &dsub_device_name,
		      SHELL_HELP("Turn the display on", "<device>"),
		      cmd_on, 2, 0),
	SHELL_CMD_ARG(size, &dsub_device_name,
		      SHELL_HELP("Show auxiliary display capabilities", "<device>"),
		      cmd_size, 2, 0),
	SHELL_CMD_ARG(write, &dsub_device_name,
		      SHELL_HELP("Write text to the auxiliary display",
				 "<device> <text> [x] [y]"),
		      cmd_write, 3, 2),
	SHELL_SUBCMD_SET_END
);
/* clang-format on */

SHELL_CMD_REGISTER(auxdisplay, &auxdisplay_cmds, "Auxiliary display shell commands", NULL);
