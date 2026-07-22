/*
 * Copyright (c) 2026
 * SPDX-License-Identifier: Apache-2.0
 *
 * Driver for the qemu-host-sensor MMIO device.
 *
 * The device carries no emulated hardware behind it: sample values are written
 * by the QEMU host. Under qemu-wasm the host is a browser, so page JavaScript
 * can drive these readings from real Web sensor APIs or from simulated ones.
 *
 * Values arrive already shaped as struct sensor_value -- an integer part and
 * millionths -- so nothing needs rescaling here.
 */

#define DT_DRV_COMPAT qemu_host_sensor

#include <zephyr/device.h>
#include <zephyr/drivers/sensor.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/device_mmio.h>

LOG_MODULE_REGISTER(qemu_host_sensor, CONFIG_SENSOR_LOG_LEVEL);

#define REG_ID     0x00
#define REG_NCHAN  0x04
#define REG_SELECT 0x08
#define REG_VAL1   0x0c
#define REG_VAL2   0x10

/* "HSEN" */
#define HOST_SENSOR_MAGIC 0x4853454eU

/* Must not exceed the device's channel count. */
#define HOST_SENSOR_MAX_CHANNELS 8

struct qhs_config {
	DEVICE_MMIO_ROM;
};

struct qhs_data {
	DEVICE_MMIO_RAM;
	uint32_t nchan;
	struct sensor_value cache[HOST_SENSOR_MAX_CHANNELS];
};

/*
 * Which host channel backs each Zephyr sensor channel. Chosen so the obvious
 * browser APIs line up: DeviceOrientation/Motion on the accelerometer axes,
 * AmbientLightSensor on light, Battery on state-of-charge.
 */
static int qhs_channel_index(enum sensor_channel chan)
{
	switch (chan) {
	case SENSOR_CHAN_ACCEL_X:
		return 0;
	case SENSOR_CHAN_ACCEL_Y:
		return 1;
	case SENSOR_CHAN_ACCEL_Z:
		return 2;
	case SENSOR_CHAN_AMBIENT_TEMP:
		return 3;
	case SENSOR_CHAN_LIGHT:
		return 4;
	case SENSOR_CHAN_HUMIDITY:
		return 5;
	case SENSOR_CHAN_PRESS:
		return 6;
	case SENSOR_CHAN_GAUGE_STATE_OF_CHARGE:
		return 7;
	default:
		return -1;
	}
}

static void qhs_read_channel(const struct device *dev, uint32_t index,
			     struct sensor_value *out)
{
	mm_reg_t base = DEVICE_MMIO_GET(dev);

	sys_write32(index, base + REG_SELECT);
	out->val1 = (int32_t)sys_read32(base + REG_VAL1);
	out->val2 = (int32_t)sys_read32(base + REG_VAL2);
}

static int qhs_sample_fetch(const struct device *dev, enum sensor_channel chan)
{
	struct qhs_data *data = dev->data;
	uint32_t i;

	if (chan == SENSOR_CHAN_ALL) {
		for (i = 0; i < data->nchan; i++) {
			qhs_read_channel(dev, i, &data->cache[i]);
		}
		return 0;
	}

	if (chan == SENSOR_CHAN_ACCEL_XYZ) {
		for (i = 0; i < 3 && i < data->nchan; i++) {
			qhs_read_channel(dev, i, &data->cache[i]);
		}
		return 0;
	}

	int index = qhs_channel_index(chan);

	if (index < 0 || (uint32_t)index >= data->nchan) {
		return -ENOTSUP;
	}

	qhs_read_channel(dev, index, &data->cache[index]);

	return 0;
}

static int qhs_channel_get(const struct device *dev, enum sensor_channel chan,
			   struct sensor_value *val)
{
	struct qhs_data *data = dev->data;

	/*
	 * The three-axis composite is what accelerometer samples actually ask
	 * for (sensor_channel_get(..., SENSOR_CHAN_ACCEL_XYZ, val[3])); the
	 * per-axis cases below only cover shell-style single reads.
	 */
	if (chan == SENSOR_CHAN_ACCEL_XYZ) {
		if (data->nchan < 3) {
			return -ENOTSUP;
		}
		val[0] = data->cache[0];
		val[1] = data->cache[1];
		val[2] = data->cache[2];
		return 0;
	}

	int index = qhs_channel_index(chan);

	if (index < 0 || (uint32_t)index >= data->nchan) {
		return -ENOTSUP;
	}

	*val = data->cache[index];

	return 0;
}

static DEVICE_API(sensor, qhs_api) = {
	.sample_fetch = qhs_sample_fetch,
	.channel_get = qhs_channel_get,
};

static int qhs_init(const struct device *dev)
{
	struct qhs_data *data = dev->data;
	mm_reg_t base;
	uint32_t id;

	DEVICE_MMIO_MAP(dev, K_MEM_CACHE_NONE);
	base = DEVICE_MMIO_GET(dev);

	id = sys_read32(base + REG_ID);
	if (id != HOST_SENSOR_MAGIC) {
		LOG_ERR("bad ID 0x%08x at %p (expected 0x%08x)", id,
			(void *)base, HOST_SENSOR_MAGIC);
		return -ENODEV;
	}

	data->nchan = sys_read32(base + REG_NCHAN);
	if (data->nchan > HOST_SENSOR_MAX_CHANNELS) {
		LOG_WRN("device reports %u channels, using %u", data->nchan,
			HOST_SENSOR_MAX_CHANNELS);
		data->nchan = HOST_SENSOR_MAX_CHANNELS;
	}

	LOG_INF("host sensor at %p, %u channels", (void *)base, data->nchan);

	return 0;
}

#define QHS_DEFINE(inst)                                                      \
	static struct qhs_data qhs_data_##inst;                               \
	static const struct qhs_config qhs_config_##inst = {                  \
		DEVICE_MMIO_ROM_INIT(DT_DRV_INST(inst)),                      \
	};                                                                    \
	SENSOR_DEVICE_DT_INST_DEFINE(inst, qhs_init, NULL, &qhs_data_##inst,  \
				     &qhs_config_##inst, POST_KERNEL,         \
				     CONFIG_SENSOR_INIT_PRIORITY, &qhs_api);

DT_INST_FOREACH_STATUS_OKAY(QHS_DEFINE)
