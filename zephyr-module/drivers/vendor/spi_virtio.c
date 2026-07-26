/*
 * Copyright (c) 2026 Benjamin Cabé <benjamin@zephyrproject.org>
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT virtio_spi

#include <zephyr/device.h>
#include <zephyr/drivers/spi.h>
#include <zephyr/drivers/virtio.h>
#include <zephyr/drivers/virtio/virtqueue.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/util.h>
#include <string.h>

#include "spi_context.h"
#include "spi_rtio.h"

LOG_MODULE_REGISTER(spi_virtio, CONFIG_SPI_LOG_LEVEL);

/*
 * Driver for the virtio SPI controller device, as defined in the "SPI Controller
 * Device" section of the Virtual I/O Device (VIRTIO) specification.
 */

/** The device exposes a single request virtqueue */
#define VIRTIO_SPI_REQUESTQ_IDX 0
/** Requests are made of the head, up to two payload buffers and the result */
#define VIRTIO_SPI_REQ_MAX_BUFS 4
/** Size of the request virtqueue, one request is in flight at a time */
#define VIRTIO_SPI_REQUESTQ_SIZE VIRTIO_SPI_REQ_MAX_BUFS

/** Size of the scratch buffer used for transfers that only generate clocks */
#define VIRTIO_SPI_DUMMY_TX_SIZE 64

/* virtio_spi_transfer_head::mode bits */
#define VIRTIO_SPI_CPHA           BIT(0)
#define VIRTIO_SPI_CPOL           BIT(1)
#define VIRTIO_SPI_CS_HIGH        BIT(2)
#define VIRTIO_SPI_MODE_LSB_FIRST BIT(3)
#define VIRTIO_SPI_MODE_LOOP      BIT(4)

/* virtio_spi_config::mode_func_supported bits */
#define VIRTIO_SPI_MF_SUPPORT_CPHA_0    BIT(0)
#define VIRTIO_SPI_MF_SUPPORT_CPHA_1    BIT(1)
#define VIRTIO_SPI_MF_SUPPORT_CPOL_0    BIT(2)
#define VIRTIO_SPI_MF_SUPPORT_CPOL_1    BIT(3)
#define VIRTIO_SPI_MF_SUPPORT_CS_HIGH   BIT(4)
#define VIRTIO_SPI_MF_SUPPORT_LSB_FIRST BIT(5)
#define VIRTIO_SPI_MF_SUPPORT_LOOPBACK  BIT(6)

/* virtio_spi_config::{tx,rx}_nbits_supported bits, SINGLE is always supported */
#define VIRTIO_SPI_RX_TX_SUPPORT_DUAL  BIT(0)
#define VIRTIO_SPI_RX_TX_SUPPORT_QUAD  BIT(1)
#define VIRTIO_SPI_RX_TX_SUPPORT_OCTAL BIT(2)

/* virtio_spi_transfer_result::result values */
#define VIRTIO_SPI_TRANS_OK  0
#define VIRTIO_SPI_PARAM_ERR 1
#define VIRTIO_SPI_TRANS_ERR 2

/** Device specific configuration space, read-only for the driver */
struct virtio_spi_config {
	uint8_t cs_max_number;
	uint8_t cs_change_supported;
	uint8_t tx_nbits_supported;
	uint8_t rx_nbits_supported;
	uint32_t bits_per_word_mask;
	uint32_t mode_func_supported;
	uint32_t max_freq_hz;
	uint32_t max_word_delay_ns;
	uint32_t max_cs_setup_ns;
	uint32_t max_cs_hold_ns;
	uint32_t max_cs_inactive_ns;
} __packed;

/** Device readable part of a request, describing a single SPI transfer */
struct virtio_spi_transfer_head {
	uint8_t chip_select_id;
	uint8_t bits_per_word;
	uint8_t cs_change;
	uint8_t tx_nbits;
	uint8_t rx_nbits;
	uint8_t reserved[3];
	uint32_t mode;
	uint32_t freq;
	uint32_t word_delay_ns;
	uint32_t cs_setup_ns;
	uint32_t cs_delay_hold_ns;
	uint32_t cs_change_delay_inactive_ns;
} __packed;

/** Device writeable part of a request */
struct virtio_spi_transfer_result {
	uint8_t result;
} __packed;

struct spi_virtio_dev_config {
	const struct device *vdev;
};

struct spi_virtio_data {
	struct spi_context ctx;
	struct virtq *vq;
	struct k_sem xfer_done;
	/** Number of bytes per data frame for the current configuration */
	uint8_t dfs;

	/* Cached content of the device specific configuration space */
	uint8_t cs_max_number;
	bool cs_change_supported;
	uint8_t tx_nbits_supported;
	uint8_t rx_nbits_supported;
	uint32_t bits_per_word_mask;
	uint32_t mode_func_supported;
	uint32_t max_freq_hz;

	/* Request buffers shared with the device */
	struct virtio_spi_transfer_head head;
	struct virtio_spi_transfer_result result;
};

/*
 * Zero filled scratch buffer used to clock out data when neither a TX nor an RX
 * buffer was provided for a part of the transfer. It is only ever read by the
 * device, so a single instance shared by all the controllers is enough.
 */
static uint8_t spi_virtio_dummy_tx[VIRTIO_SPI_DUMMY_TX_SIZE];

static int spi_virtio_read_device_config(const struct device *dev)
{
	const struct spi_virtio_dev_config *cfg = dev->config;
	struct spi_virtio_data *data = dev->data;
	volatile const struct virtio_spi_config *devcfg =
		virtio_get_device_specific_config(cfg->vdev);

	if (devcfg == NULL) {
		LOG_ERR("device specific config is not available");
		return -ENODEV;
	}

	data->cs_max_number = devcfg->cs_max_number;
	data->cs_change_supported = devcfg->cs_change_supported != 0;
	data->tx_nbits_supported = devcfg->tx_nbits_supported;
	data->rx_nbits_supported = devcfg->rx_nbits_supported;
	data->bits_per_word_mask = sys_le32_to_cpu(devcfg->bits_per_word_mask);
	data->mode_func_supported = sys_le32_to_cpu(devcfg->mode_func_supported);
	data->max_freq_hz = sys_le32_to_cpu(devcfg->max_freq_hz);

	if (data->cs_max_number == 0) {
		LOG_ERR("device reports no chip select");
		return -EINVAL;
	}

	LOG_DBG("cs_max_number %u, cs_change %s, mode_func 0x%08x, max_freq %u Hz",
		data->cs_max_number, data->cs_change_supported ? "supported" : "unsupported",
		data->mode_func_supported, data->max_freq_hz);

	return 0;
}

static int spi_virtio_configure(const struct device *dev, const struct spi_config *spi_cfg)
{
	struct spi_virtio_data *data = dev->data;
	struct virtio_spi_transfer_head *head = &data->head;
	const spi_operation_t operation = spi_cfg->operation;
	uint32_t mode_required;
	uint32_t mode = 0;
	uint8_t nbits_required = 0;
	uint8_t nbits;
	uint8_t word_size;

	if (spi_context_configured(&data->ctx, spi_cfg)) {
		return 0;
	}

	if (SPI_OP_MODE_GET(operation) != SPI_OP_MODE_MASTER) {
		LOG_ERR("slave mode is not supported");
		return -ENOTSUP;
	}

	if (spi_cfg->slave >= data->cs_max_number) {
		LOG_ERR("chip select %u is out of range, device supports %u", spi_cfg->slave,
			data->cs_max_number);
		return -EINVAL;
	}

	word_size = SPI_WORD_SIZE_GET(operation);
	if (word_size == 0 || word_size > 32) {
		LOG_ERR("unsupported word size %u", word_size);
		return -ENOTSUP;
	}
	/* A mask of 0 means that the device doesn't restrict the word size */
	if (data->bits_per_word_mask != 0 &&
	    (data->bits_per_word_mask & BIT(word_size - 1)) == 0) {
		LOG_ERR("device doesn't support %u bits per word", word_size);
		return -ENOTSUP;
	}

	if (operation & SPI_MODE_CPHA) {
		mode |= VIRTIO_SPI_CPHA;
		mode_required = VIRTIO_SPI_MF_SUPPORT_CPHA_1;
	} else {
		mode_required = VIRTIO_SPI_MF_SUPPORT_CPHA_0;
	}

	if (operation & SPI_MODE_CPOL) {
		mode |= VIRTIO_SPI_CPOL;
		mode_required |= VIRTIO_SPI_MF_SUPPORT_CPOL_1;
	} else {
		mode_required |= VIRTIO_SPI_MF_SUPPORT_CPOL_0;
	}

	if (operation & SPI_CS_ACTIVE_HIGH) {
		mode |= VIRTIO_SPI_CS_HIGH;
		mode_required |= VIRTIO_SPI_MF_SUPPORT_CS_HIGH;
	}

	if (operation & SPI_TRANSFER_LSB) {
		mode |= VIRTIO_SPI_MODE_LSB_FIRST;
		mode_required |= VIRTIO_SPI_MF_SUPPORT_LSB_FIRST;
	}

	if (operation & SPI_MODE_LOOP) {
		mode |= VIRTIO_SPI_MODE_LOOP;
		mode_required |= VIRTIO_SPI_MF_SUPPORT_LOOPBACK;
	}

	if ((data->mode_func_supported & mode_required) != mode_required) {
		LOG_ERR("device doesn't support mode 0x%08x", mode);
		return -ENOTSUP;
	}

	switch (operation & SPI_LINES_MASK) {
	case SPI_LINES_SINGLE:
		nbits = 1;
		break;
	case SPI_LINES_DUAL:
		nbits = 2;
		nbits_required = VIRTIO_SPI_RX_TX_SUPPORT_DUAL;
		break;
	case SPI_LINES_QUAD:
		nbits = 4;
		nbits_required = VIRTIO_SPI_RX_TX_SUPPORT_QUAD;
		break;
	case SPI_LINES_OCTAL:
		nbits = 8;
		nbits_required = VIRTIO_SPI_RX_TX_SUPPORT_OCTAL;
		break;
	default:
		return -EINVAL;
	}

	if ((data->tx_nbits_supported & nbits_required) != nbits_required ||
	    (data->rx_nbits_supported & nbits_required) != nbits_required) {
		LOG_ERR("device doesn't support %u-bit transfers", nbits);
		return -ENOTSUP;
	}

	/* A maximum frequency of 0 means that the device doesn't restrict the speed */
	if (data->max_freq_hz != 0 && spi_cfg->frequency > data->max_freq_hz) {
		LOG_ERR("frequency %u Hz is above the maximum of %u Hz", spi_cfg->frequency,
			data->max_freq_hz);
		return -ENOTSUP;
	}

	/*
	 * The Zephyr SPI API has no notion of the delays the device can be asked
	 * to introduce, so the corresponding fields are left cleared.
	 */
	memset(head, 0, sizeof(*head));
	head->chip_select_id = spi_cfg->slave;
	head->bits_per_word = word_size;
	head->tx_nbits = nbits;
	head->rx_nbits = nbits;
	head->mode = sys_cpu_to_le32(mode);
	head->freq = sys_cpu_to_le32(spi_cfg->frequency);

	data->dfs = DIV_ROUND_UP(word_size, 8);
	/* There is no uint24_t, buffers holding such words are uint32_t based */
	if (data->dfs == 3) {
		data->dfs = 4;
	}

	data->ctx.config = spi_cfg;

	return 0;
}

static void spi_virtio_done_cb(void *opaque, uint32_t used_len)
{
	struct spi_virtio_data *data = opaque;

	ARG_UNUSED(used_len);

	k_sem_give(&data->xfer_done);
}

/*
 * Performs a single SPI transfer. Depending on which buffers are provided this
 * is a half duplex read, a half duplex write or a full duplex transfer, and the
 * request is built accordingly. The buffers of a full duplex transfer must be of
 * the same length.
 */
static int spi_virtio_transfer(const struct device *dev, const uint8_t *tx_buf, uint8_t *rx_buf,
			       size_t len, bool cs_change)
{
	const struct spi_virtio_dev_config *cfg = dev->config;
	struct spi_virtio_data *data = dev->data;
	struct virtq_buf bufs[VIRTIO_SPI_REQ_MAX_BUFS];
	uint16_t device_readable_count;
	uint16_t buf_count = 0;
	int ret;

	data->head.cs_change = cs_change ? 1 : 0;
	data->result.result = VIRTIO_SPI_TRANS_ERR;

	bufs[buf_count++] = (struct virtq_buf){.addr = &data->head, .len = sizeof(data->head)};
	if (tx_buf != NULL) {
		/* Only read by the device, hence discarding the const qualifier */
		bufs[buf_count++] = (struct virtq_buf){.addr = (uint8_t *)tx_buf, .len = len};
	}
	device_readable_count = buf_count;

	if (rx_buf != NULL) {
		bufs[buf_count++] = (struct virtq_buf){.addr = rx_buf, .len = len};
	}
	bufs[buf_count++] =
		(struct virtq_buf){.addr = &data->result, .len = sizeof(data->result)};

	ret = virtq_add_buffer_chain(data->vq, bufs, buf_count, device_readable_count,
				     spi_virtio_done_cb, data, K_FOREVER);
	if (ret != 0) {
		LOG_ERR("failed to add buffer chain: %d", ret);
		return ret;
	}

	virtio_notify_virtqueue(cfg->vdev, VIRTIO_SPI_REQUESTQ_IDX);

	k_sem_take(&data->xfer_done, K_FOREVER);

	switch (data->result.result) {
	case VIRTIO_SPI_TRANS_OK:
		return 0;
	case VIRTIO_SPI_PARAM_ERR:
		LOG_ERR("device rejected the transfer parameters");
		return -EINVAL;
	default:
		LOG_ERR("transfer failed, result %u", data->result.result);
		return -EIO;
	}
}

static int spi_virtio_transfer_chunk(const struct device *dev, const uint8_t *tx_buf,
				     uint8_t *rx_buf, size_t len, bool cs_change)
{
	int ret;

	if (tx_buf != NULL || rx_buf != NULL) {
		return spi_virtio_transfer(dev, tx_buf, rx_buf, len, cs_change);
	}

	/*
	 * Neither buffer is backed by memory, the transfer only has to clock out
	 * data that is then discarded. Zeros are sent out of the scratch buffer,
	 * in as many transfers as needed to cover the requested length.
	 */
	while (len > 0) {
		size_t chunk = MIN(len, sizeof(spi_virtio_dummy_tx));

		len -= chunk;

		ret = spi_virtio_transfer(dev, spi_virtio_dummy_tx, NULL, chunk,
					  cs_change && len == 0);
		if (ret != 0) {
			return ret;
		}
	}

	return 0;
}

static int spi_virtio_transceive(const struct device *dev, const struct spi_config *spi_cfg,
				 const struct spi_buf_set *tx_bufs,
				 const struct spi_buf_set *rx_bufs)
{
	struct spi_virtio_data *data = dev->data;
	struct spi_context *ctx = &data->ctx;
	int ret;

	spi_context_lock(ctx, false, NULL, NULL, spi_cfg);

	ret = spi_virtio_configure(dev, spi_cfg);
	if (ret != 0) {
		goto out;
	}

	spi_context_buffers_setup(ctx, tx_bufs, rx_bufs, data->dfs);
	spi_context_cs_control(ctx, true);

	while (spi_context_tx_on(ctx) || spi_context_rx_on(ctx)) {
		size_t frames = spi_context_max_continuous_chunk(ctx);
		size_t len = frames * data->dfs;
		size_t left = MAX(spi_context_tx_len_left(ctx, data->dfs),
				  spi_context_rx_len_left(ctx, data->dfs));
		bool cs_change;

		/*
		 * Ask the device to deassert the chip select once the last
		 * transfer of the message is done, unless the caller wants to
		 * keep it asserted. Devices that don't support toggling the chip
		 * select take care of it on their own.
		 */
		cs_change = (len >= left) && !(spi_cfg->operation & SPI_HOLD_ON_CS) &&
			    data->cs_change_supported;

		ret = spi_virtio_transfer_chunk(dev, ctx->tx_buf, ctx->rx_buf, len, cs_change);
		if (ret != 0) {
			break;
		}

		spi_context_update_tx(ctx, data->dfs, frames);
		spi_context_update_rx(ctx, data->dfs, frames);
	}

	spi_context_cs_control(ctx, false);

out:
	spi_context_release(ctx, ret);

	return ret;
}

#ifdef CONFIG_SPI_ASYNC
static int spi_virtio_transceive_async(const struct device *dev, const struct spi_config *spi_cfg,
				       const struct spi_buf_set *tx_bufs,
				       const struct spi_buf_set *rx_bufs, spi_callback_t cb,
				       void *userdata)
{
	return -ENOTSUP;
}
#endif /* CONFIG_SPI_ASYNC */

static int spi_virtio_release(const struct device *dev, const struct spi_config *spi_cfg)
{
	struct spi_virtio_data *data = dev->data;

	ARG_UNUSED(spi_cfg);

	spi_context_unlock_unconditionally(&data->ctx);

	return 0;
}

static DEVICE_API(spi, spi_virtio_api) = {
	.transceive = spi_virtio_transceive,
#ifdef CONFIG_SPI_ASYNC
	.transceive_async = spi_virtio_transceive_async,
#endif /* CONFIG_SPI_ASYNC */
#ifdef CONFIG_SPI_RTIO
	.iodev_submit = spi_rtio_iodev_default_submit,
#endif /* CONFIG_SPI_RTIO */
	.release = spi_virtio_release,
};

static uint16_t spi_virtio_enum_queues_cb(uint16_t q_index, uint16_t q_size_max, void *opaque)
{
	ARG_UNUSED(opaque);

	if (q_index == VIRTIO_SPI_REQUESTQ_IDX) {
		return MIN(VIRTIO_SPI_REQUESTQ_SIZE, q_size_max);
	}

	return 0;
}

static int spi_virtio_init(const struct device *dev)
{
	const struct spi_virtio_dev_config *cfg = dev->config;
	struct spi_virtio_data *data = dev->data;
	int ret;

	k_sem_init(&data->xfer_done, 0, 1);

	/* The device doesn't offer any device specific feature bit */
	ret = virtio_commit_feature_bits(cfg->vdev);
	if (ret != 0) {
		return ret;
	}

	ret = spi_virtio_read_device_config(dev);
	if (ret != 0) {
		return ret;
	}

	ret = virtio_init_virtqueues(cfg->vdev, 1, spi_virtio_enum_queues_cb, NULL);
	if (ret != 0) {
		LOG_ERR("virtio_init_virtqueues failed: %d", ret);
		return ret;
	}

	data->vq = virtio_get_virtqueue(cfg->vdev, VIRTIO_SPI_REQUESTQ_IDX);
	if (data->vq == NULL) {
		LOG_ERR("failed to get virtqueue %d", VIRTIO_SPI_REQUESTQ_IDX);
		return -ENODEV;
	}

	if (data->vq->num < VIRTIO_SPI_REQ_MAX_BUFS) {
		LOG_ERR("request virtqueue is too small (%u descriptors)", data->vq->num);
		return -ENOTSUP;
	}

	virtio_finalize_init(cfg->vdev);

	ret = spi_context_cs_configure_all(&data->ctx);
	if (ret < 0) {
		LOG_ERR("failed to configure CS pins: %d", ret);
		return ret;
	}

	spi_context_unlock_unconditionally(&data->ctx);

	return 0;
}

#define SPI_VIRTIO_INIT(inst)                                                                      \
	static struct spi_virtio_data spi_virtio_data_##inst = {                                   \
		SPI_CONTEXT_INIT_LOCK(spi_virtio_data_##inst, ctx),                                \
		SPI_CONTEXT_INIT_SYNC(spi_virtio_data_##inst, ctx),                                \
		SPI_CONTEXT_CS_GPIOS_INITIALIZE(DT_DRV_INST(inst), ctx)                            \
	};                                                                                         \
	static const struct spi_virtio_dev_config spi_virtio_dev_config_##inst = {                 \
		.vdev = DEVICE_DT_GET(DT_INST_PARENT(inst)),                                       \
	};                                                                                         \
	SPI_DEVICE_DT_INST_DEFINE(inst, spi_virtio_init, NULL, &spi_virtio_data_##inst,            \
				  &spi_virtio_dev_config_##inst, POST_KERNEL,                      \
				  CONFIG_SPI_INIT_PRIORITY, &spi_virtio_api);

DT_INST_FOREACH_STATUS_OKAY(SPI_VIRTIO_INIT)
