/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Driver for the qemu-host-gpio MMIO device.
 *
 * The device models no real hardware: its input pins are driven by the QEMU
 * host and its output pins are observed by it. Under qemu-wasm the host is a
 * browser, so a page can raise a button on an input and light an LED from an
 * output the guest drives.
 *
 * Two registers carry the state. IN is written by the host and read here; OUT
 * is written here and read by the host. A DIR register records which pins the
 * guest has configured as outputs, so a read returns the driven level on those
 * and the host-supplied level on the rest.
 *
 * Interrupts are not modelled yet: pin_interrupt_configure() reports -ENOTSUP,
 * which is why this pairs with the shell's `gpio get`/`gpio set` rather than the
 * interrupt-driven button sample. Reads and writes are the whole feature.
 *
 * The register base is carried as a plain address rather than through the
 * DEVICE_MMIO helpers: those require their member at offset 0 of config/data,
 * and the GPIO API claims offset 0 of both for its own common structs — with
 * both in place, DEVICE_MMIO_GET() on the MMU-less Cortex-M3 returned the pin
 * mask as the base address. The device only exists on that machine, so an
 * identity-mapped physical address is all that is ever needed.
 */

#define DT_DRV_COMPAT qemu_host_gpio

#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/gpio/gpio_utils.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/sys_io.h>

LOG_MODULE_REGISTER(qemu_host_gpio, CONFIG_GPIO_LOG_LEVEL);

#define REG_ID    0x00
#define REG_NPINS 0x04
#define REG_IN    0x08
#define REG_OUT   0x0c
#define REG_DIR   0x10

/* "HGPI" */
#define HOST_GPIO_MAGIC 0x48475049U

struct qhg_config {
	/* Required first member for a GPIO controller. */
	struct gpio_driver_config common;
	mm_reg_t base;
};

struct qhg_data {
	/* Required first member for a GPIO controller. */
	struct gpio_driver_data common;
};

static int qhg_pin_configure(const struct device *dev, gpio_pin_t pin,
			     gpio_flags_t flags)
{
	const struct qhg_config *config = dev->config;
	mm_reg_t base = config->base;
	uint32_t dir = sys_read32(base + REG_DIR);
	uint32_t out = sys_read32(base + REG_OUT);

	if ((flags & (GPIO_INPUT | GPIO_OUTPUT)) == (GPIO_INPUT | GPIO_OUTPUT)) {
		/* This device drives a pin either in or out, not both at once. */
		return -ENOTSUP;
	}

	if (flags & GPIO_OUTPUT) {
		dir |= BIT(pin);
		if (flags & GPIO_OUTPUT_INIT_HIGH) {
			out |= BIT(pin);
		} else if (flags & GPIO_OUTPUT_INIT_LOW) {
			out &= ~BIT(pin);
		}
		sys_write32(out, base + REG_OUT);
	} else if (flags & GPIO_INPUT) {
		dir &= ~BIT(pin);
	} else {
		/* GPIO_DISCONNECTED: nothing to model, leave the pin as-is. */
		return 0;
	}

	sys_write32(dir, base + REG_DIR);

	return 0;
}

static int qhg_port_get_raw(const struct device *dev, gpio_port_value_t *value)
{
	const struct qhg_config *config = dev->config;
	mm_reg_t base = config->base;
	uint32_t dir = sys_read32(base + REG_DIR);
	uint32_t in = sys_read32(base + REG_IN);
	uint32_t out = sys_read32(base + REG_OUT);

	/* Output pins read back their driven level; inputs read the host's. */
	*value = (out & dir) | (in & ~dir);

	return 0;
}

static int qhg_port_set_masked_raw(const struct device *dev,
				   gpio_port_pins_t mask,
				   gpio_port_value_t value)
{
	const struct qhg_config *config = dev->config;
	mm_reg_t base = config->base;
	uint32_t out = sys_read32(base + REG_OUT);

	out = (out & ~mask) | (value & mask);
	sys_write32(out, base + REG_OUT);

	return 0;
}

static int qhg_port_set_bits_raw(const struct device *dev,
				 gpio_port_pins_t pins)
{
	const struct qhg_config *config = dev->config;
	mm_reg_t base = config->base;

	sys_write32(sys_read32(base + REG_OUT) | pins, base + REG_OUT);

	return 0;
}

static int qhg_port_clear_bits_raw(const struct device *dev,
				   gpio_port_pins_t pins)
{
	const struct qhg_config *config = dev->config;
	mm_reg_t base = config->base;

	sys_write32(sys_read32(base + REG_OUT) & ~pins, base + REG_OUT);

	return 0;
}

static int qhg_port_toggle_bits(const struct device *dev,
				gpio_port_pins_t pins)
{
	const struct qhg_config *config = dev->config;
	mm_reg_t base = config->base;

	sys_write32(sys_read32(base + REG_OUT) ^ pins, base + REG_OUT);

	return 0;
}

static int qhg_pin_interrupt_configure(const struct device *dev,
				       gpio_pin_t pin,
				       enum gpio_int_mode mode,
				       enum gpio_int_trig trig)
{
	ARG_UNUSED(dev);
	ARG_UNUSED(pin);
	ARG_UNUSED(trig);

	/* No IRQ line to the guest yet; disabling is the only supported mode. */
	if (mode == GPIO_INT_MODE_DISABLED) {
		return 0;
	}

	return -ENOTSUP;
}

static DEVICE_API(gpio, qhg_api) = {
	.pin_configure = qhg_pin_configure,
	.port_get_raw = qhg_port_get_raw,
	.port_set_masked_raw = qhg_port_set_masked_raw,
	.port_set_bits_raw = qhg_port_set_bits_raw,
	.port_clear_bits_raw = qhg_port_clear_bits_raw,
	.port_toggle_bits = qhg_port_toggle_bits,
	.pin_interrupt_configure = qhg_pin_interrupt_configure,
};

static int qhg_init(const struct device *dev)
{
	const struct qhg_config *config = dev->config;
	mm_reg_t base = config->base;
	uint32_t id;

	id = sys_read32(base + REG_ID);
	if (id != HOST_GPIO_MAGIC) {
		LOG_ERR("bad ID 0x%08x at %p (expected 0x%08x)", id,
			(void *)base, HOST_GPIO_MAGIC);
		return -ENODEV;
	}

	LOG_INF("host gpio at %p, %u pins", (void *)base,
		sys_read32(base + REG_NPINS));

	return 0;
}

#define QHG_DEFINE(inst)                                                      \
	static struct qhg_data qhg_data_##inst;                              \
	static const struct qhg_config qhg_config_##inst = {                 \
		.common = {                                                  \
			.port_pin_mask =                                     \
				GPIO_PORT_PIN_MASK_FROM_DT_INST(inst),       \
		},                                                           \
		.base = DT_INST_REG_ADDR(inst),                              \
	};                                                                   \
	DEVICE_DT_INST_DEFINE(inst, qhg_init, NULL, &qhg_data_##inst,         \
			      &qhg_config_##inst, POST_KERNEL,               \
			      CONFIG_GPIO_INIT_PRIORITY, &qhg_api);

DT_INST_FOREACH_STATUS_OKAY(QHG_DEFINE)
