/*
 * Copyright (c) 2026 The Zephyr Project Contributors
 *
 * SPDX-License-Identifier: Apache-2.0
 */

#define DT_DRV_COMPAT virtio_gpu

#include <errno.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/drivers/display.h>
#include <zephyr/drivers/virtio.h>
#include <zephyr/drivers/virtio/virtqueue.h>
#include <zephyr/kernel.h>
#include <zephyr/logging/log.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/device_mmio.h>
#include <zephyr/sys/minmax.h>
#include <zephyr/sys/util.h>

LOG_MODULE_REGISTER(display_virtio_gpu, CONFIG_DISPLAY_LOG_LEVEL);

BUILD_ASSERT(IS_POWER_OF_TWO(CONFIG_VIRTIO_GPU_DISPLAY_QUEUE_SIZE),
	     "VIRTIO GPU queue size must be a power of two");

#define VIRTIO_GPU_CONTROLQ_IDX 0
#define VIRTIO_GPU_QUEUE_COUNT  2

#define VIRTIO_GPU_MAX_SCANOUTS 16
#define VIRTIO_GPU_RESOURCE_ID  1
#define VIRTIO_GPU_BPP          4

#define VIRTIO_GPU_FLAG_FENCE BIT(0)

enum virtio_gpu_ctrl_type {
	VIRTIO_GPU_CMD_GET_DISPLAY_INFO = 0x0100,
	VIRTIO_GPU_CMD_RESOURCE_CREATE_2D,
	VIRTIO_GPU_CMD_RESOURCE_UNREF,
	VIRTIO_GPU_CMD_SET_SCANOUT,
	VIRTIO_GPU_CMD_RESOURCE_FLUSH,
	VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D,
	VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING,

	VIRTIO_GPU_RESP_OK_NODATA = 0x1100,
	VIRTIO_GPU_RESP_OK_DISPLAY_INFO,
};

enum virtio_gpu_format {
	VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM = 1,
};

struct virtio_gpu_ctrl_hdr {
	uint32_t type;
	uint32_t flags;
	uint64_t fence_id;
	uint32_t ctx_id;
	uint8_t ring_idx;
	uint8_t padding[3];
} __packed;

struct virtio_gpu_rect {
	uint32_t x;
	uint32_t y;
	uint32_t width;
	uint32_t height;
} __packed;

struct virtio_gpu_display_one {
	struct virtio_gpu_rect r;
	uint32_t enabled;
	uint32_t flags;
} __packed;

struct virtio_gpu_resp_display_info {
	struct virtio_gpu_ctrl_hdr hdr;
	struct virtio_gpu_display_one pmodes[VIRTIO_GPU_MAX_SCANOUTS];
} __packed;

struct virtio_gpu_resource_create_2d {
	struct virtio_gpu_ctrl_hdr hdr;
	uint32_t resource_id;
	uint32_t format;
	uint32_t width;
	uint32_t height;
} __packed;

struct virtio_gpu_set_scanout {
	struct virtio_gpu_ctrl_hdr hdr;
	struct virtio_gpu_rect r;
	uint32_t scanout_id;
	uint32_t resource_id;
} __packed;

struct virtio_gpu_resource_flush {
	struct virtio_gpu_ctrl_hdr hdr;
	struct virtio_gpu_rect r;
	uint32_t resource_id;
	uint32_t padding;
} __packed;

struct virtio_gpu_transfer_to_host_2d {
	struct virtio_gpu_ctrl_hdr hdr;
	struct virtio_gpu_rect r;
	uint64_t offset;
	uint32_t resource_id;
	uint32_t padding;
} __packed;

struct virtio_gpu_mem_entry {
	uint64_t addr;
	uint32_t length;
	uint32_t padding;
} __packed;

struct virtio_gpu_resource_attach_backing_one {
	struct virtio_gpu_ctrl_hdr hdr;
	uint32_t resource_id;
	uint32_t nr_entries;
	struct virtio_gpu_mem_entry entry;
} __packed;

struct virtio_gpu_cmd_ctx {
	struct k_sem done;
	uint32_t used_len;
};

struct virtio_gpu_dirty {
	uint32_t x1;
	uint32_t y1;
	uint32_t x2;
	uint32_t y2;
	bool valid;
};

struct virtio_gpu_config {
	const struct device *vdev;
	uintptr_t fb_phys;
	size_t fb_size;
	uint32_t scanout;
	uint16_t width;
	uint16_t height;
};

struct virtio_gpu_data {
	struct virtq *controlq;
	struct k_mutex lock;
	struct virtio_gpu_dirty dirty;
	mm_reg_t fb_map;
	uint8_t *fb;
	uint64_t next_fence_id;
	uint32_t pitch;
	uint16_t width;
	uint16_t height;
	bool blanked;
};

static void virtio_gpu_cmd_done(void *opaque, uint32_t used_len)
{
	struct virtio_gpu_cmd_ctx *ctx = opaque;

	ctx->used_len = used_len;
	k_sem_give(&ctx->done);
}

static void virtio_gpu_init_hdr(struct virtio_gpu_data *data, struct virtio_gpu_ctrl_hdr *hdr,
				enum virtio_gpu_ctrl_type type)
{
	memset(hdr, 0, sizeof(*hdr));
	hdr->type = sys_cpu_to_le32(type);
	hdr->flags = sys_cpu_to_le32(VIRTIO_GPU_FLAG_FENCE);
	hdr->fence_id = sys_cpu_to_le64(++data->next_fence_id);
}

static int virtio_gpu_exec(const struct device *dev, void *request, size_t request_size,
			   void *response, size_t response_size,
			   enum virtio_gpu_ctrl_type expected_response)
{
	const struct virtio_gpu_config *cfg = dev->config;
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_cmd_ctx ctx;
	struct virtio_gpu_ctrl_hdr *req_hdr = request;
	struct virtio_gpu_ctrl_hdr *resp_hdr = response;
	uint8_t *bounce;
	uint8_t *bounce_response;
	struct virtq_buf bufs[] = {
		{.addr = NULL, .len = request_size},
		{.addr = NULL, .len = response_size},
	};
	uint32_t response_type;
	int ret;

	if (request_size > SIZE_MAX - response_size) {
		return -EOVERFLOW;
	}

	/*
	 * Callers put requests and responses on thread stacks, which are not
	 * necessarily part of the permanent physical mapping used for virtio
	 * DMA. Bounce both through the kernel heap, as the virtiofs client does.
	 */
	bounce = k_malloc(request_size + response_size);
	if (bounce == NULL) {
		return -ENOMEM;
	}

	bounce_response = bounce + request_size;
	memcpy(bounce, request, request_size);
	memset(bounce_response, 0, response_size);
	bufs[0].addr = bounce;
	bufs[1].addr = bounce_response;

	k_sem_init(&ctx.done, 0, 1);
	ctx.used_len = 0;

	ret = virtq_add_buffer_chain(data->controlq, bufs, ARRAY_SIZE(bufs), 1, virtio_gpu_cmd_done,
				     &ctx, K_NO_WAIT);
	if (ret != 0) {
		k_free(bounce);
		return ret;
	}

	virtio_notify_virtqueue(cfg->vdev, VIRTIO_GPU_CONTROLQ_IDX);

	k_sem_take(&ctx.done, K_FOREVER);
	memcpy(response, bounce_response, response_size);
	k_free(bounce);

	if (ctx.used_len < sizeof(*resp_hdr)) {
		LOG_ERR("short response to command %#x: %u", sys_le32_to_cpu(req_hdr->type),
			ctx.used_len);
		return -EIO;
	}

	response_type = sys_le32_to_cpu(resp_hdr->type);
	if (response_type != expected_response) {
		LOG_ERR("command %#x failed with response %#x", sys_le32_to_cpu(req_hdr->type),
			response_type);
		return -EIO;
	}

	if ((sys_le32_to_cpu(resp_hdr->flags) & VIRTIO_GPU_FLAG_FENCE) == 0 ||
	    resp_hdr->fence_id != req_hdr->fence_id) {
		LOG_ERR("command %#x returned an invalid fence", sys_le32_to_cpu(req_hdr->type));
		return -EIO;
	}

	return 0;
}

static void virtio_gpu_set_rect(struct virtio_gpu_rect *dst, uint32_t x, uint32_t y, uint32_t width,
				uint32_t height)
{
	dst->x = sys_cpu_to_le32(x);
	dst->y = sys_cpu_to_le32(y);
	dst->width = sys_cpu_to_le32(width);
	dst->height = sys_cpu_to_le32(height);
}

static int virtio_gpu_get_display_info(const struct device *dev,
				       struct virtio_gpu_resp_display_info *response)
{
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_ctrl_hdr request;

	virtio_gpu_init_hdr(data, &request, VIRTIO_GPU_CMD_GET_DISPLAY_INFO);

	return virtio_gpu_exec(dev, &request, sizeof(request), response, sizeof(*response),
			       VIRTIO_GPU_RESP_OK_DISPLAY_INFO);
}

static int virtio_gpu_create_resource(const struct device *dev)
{
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_resource_create_2d request;
	struct virtio_gpu_ctrl_hdr response;

	memset(&request, 0, sizeof(request));
	virtio_gpu_init_hdr(data, &request.hdr, VIRTIO_GPU_CMD_RESOURCE_CREATE_2D);
	request.resource_id = sys_cpu_to_le32(VIRTIO_GPU_RESOURCE_ID);
	request.format = sys_cpu_to_le32(VIRTIO_GPU_FORMAT_B8G8R8A8_UNORM);
	request.width = sys_cpu_to_le32(data->width);
	request.height = sys_cpu_to_le32(data->height);

	return virtio_gpu_exec(dev, &request, sizeof(request), &response, sizeof(response),
			       VIRTIO_GPU_RESP_OK_NODATA);
}

static int virtio_gpu_attach_backing(const struct device *dev, uint32_t fb_size)
{
	const struct virtio_gpu_config *cfg = dev->config;
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_resource_attach_backing_one request;
	struct virtio_gpu_ctrl_hdr response;

	memset(&request, 0, sizeof(request));
	virtio_gpu_init_hdr(data, &request.hdr, VIRTIO_GPU_CMD_RESOURCE_ATTACH_BACKING);
	request.resource_id = sys_cpu_to_le32(VIRTIO_GPU_RESOURCE_ID);
	request.nr_entries = sys_cpu_to_le32(1);
	request.entry.addr = sys_cpu_to_le64(cfg->fb_phys);
	request.entry.length = sys_cpu_to_le32(fb_size);

	return virtio_gpu_exec(dev, &request, sizeof(request), &response, sizeof(response),
			       VIRTIO_GPU_RESP_OK_NODATA);
}

static int virtio_gpu_set_scanout(const struct device *dev, bool enable)
{
	const struct virtio_gpu_config *cfg = dev->config;
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_set_scanout request;
	struct virtio_gpu_ctrl_hdr response;

	memset(&request, 0, sizeof(request));
	virtio_gpu_init_hdr(data, &request.hdr, VIRTIO_GPU_CMD_SET_SCANOUT);
	virtio_gpu_set_rect(&request.r, 0, 0, data->width, data->height);
	request.scanout_id = sys_cpu_to_le32(cfg->scanout);
	request.resource_id = sys_cpu_to_le32(enable ? VIRTIO_GPU_RESOURCE_ID : 0);

	return virtio_gpu_exec(dev, &request, sizeof(request), &response, sizeof(response),
			       VIRTIO_GPU_RESP_OK_NODATA);
}

static int virtio_gpu_transfer(const struct device *dev, const struct virtio_gpu_dirty *dirty)
{
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_transfer_to_host_2d request;
	struct virtio_gpu_ctrl_hdr response;
	uint32_t width = dirty->x2 - dirty->x1;
	uint32_t height = dirty->y2 - dirty->y1;
	uint64_t offset = ((uint64_t)dirty->y1 * data->pitch + dirty->x1) * VIRTIO_GPU_BPP;

	memset(&request, 0, sizeof(request));
	virtio_gpu_init_hdr(data, &request.hdr, VIRTIO_GPU_CMD_TRANSFER_TO_HOST_2D);
	virtio_gpu_set_rect(&request.r, dirty->x1, dirty->y1, width, height);
	request.offset = sys_cpu_to_le64(offset);
	request.resource_id = sys_cpu_to_le32(VIRTIO_GPU_RESOURCE_ID);

	return virtio_gpu_exec(dev, &request, sizeof(request), &response, sizeof(response),
			       VIRTIO_GPU_RESP_OK_NODATA);
}

static int virtio_gpu_flush(const struct device *dev, const struct virtio_gpu_dirty *dirty)
{
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_resource_flush request;
	struct virtio_gpu_ctrl_hdr response;

	memset(&request, 0, sizeof(request));
	virtio_gpu_init_hdr(data, &request.hdr, VIRTIO_GPU_CMD_RESOURCE_FLUSH);
	virtio_gpu_set_rect(&request.r, dirty->x1, dirty->y1, dirty->x2 - dirty->x1,
			    dirty->y2 - dirty->y1);
	request.resource_id = sys_cpu_to_le32(VIRTIO_GPU_RESOURCE_ID);

	return virtio_gpu_exec(dev, &request, sizeof(request), &response, sizeof(response),
			       VIRTIO_GPU_RESP_OK_NODATA);
}

static int virtio_gpu_update(const struct device *dev)
{
	struct virtio_gpu_data *data = dev->data;
	int ret;

	if (!data->dirty.valid || data->blanked) {
		return 0;
	}

	ret = virtio_gpu_transfer(dev, &data->dirty);
	if (ret != 0) {
		return ret;
	}

	ret = virtio_gpu_flush(dev, &data->dirty);
	if (ret == 0) {
		data->dirty.valid = false;
	}

	return ret;
}

static void virtio_gpu_mark_dirty(struct virtio_gpu_data *data, uint32_t x, uint32_t y,
				  uint32_t width, uint32_t height)
{
	if (!data->dirty.valid) {
		data->dirty.x1 = x;
		data->dirty.y1 = y;
		data->dirty.x2 = x + width;
		data->dirty.y2 = y + height;
		data->dirty.valid = true;
		return;
	}

	data->dirty.x1 = MIN(data->dirty.x1, x);
	data->dirty.y1 = MIN(data->dirty.y1, y);
	data->dirty.x2 = MAX(data->dirty.x2, x + width);
	data->dirty.y2 = MAX(data->dirty.y2, y + height);
}

static int virtio_gpu_blanking_on(const struct device *dev)
{
	struct virtio_gpu_data *data = dev->data;
	int ret;

	k_mutex_lock(&data->lock, K_FOREVER);
	ret = virtio_gpu_set_scanout(dev, false);
	if (ret == 0) {
		data->blanked = true;
	}
	k_mutex_unlock(&data->lock);

	return ret;
}

static int virtio_gpu_blanking_off(const struct device *dev)
{
	struct virtio_gpu_data *data = dev->data;
	int ret;

	k_mutex_lock(&data->lock, K_FOREVER);
	ret = virtio_gpu_set_scanout(dev, true);
	if (ret == 0) {
		data->blanked = false;
		ret = virtio_gpu_update(dev);
	}
	k_mutex_unlock(&data->lock);

	return ret;
}

static int virtio_gpu_write(const struct device *dev, uint16_t x, uint16_t y,
			    const struct display_buffer_descriptor *desc, const void *buf)
{
	struct virtio_gpu_data *data = dev->data;
	const uint8_t *src = buf;
	uint8_t *dst;
	size_t required_size;
	int ret = 0;

	if (buf == NULL || desc->width == 0 || desc->height == 0 || desc->pitch < desc->width ||
	    x >= data->width || y >= data->height || desc->width > data->width - x ||
	    desc->height > data->height - y) {
		return -EINVAL;
	}

	required_size = (size_t)desc->pitch * desc->height * VIRTIO_GPU_BPP;
	if (desc->buf_size < required_size) {
		return -EINVAL;
	}

	k_mutex_lock(&data->lock, K_FOREVER);

	dst = data->fb + ((size_t)y * data->pitch + x) * VIRTIO_GPU_BPP;
	for (uint32_t row = 0; row < desc->height; row++) {
		memcpy(dst, src, (size_t)desc->width * VIRTIO_GPU_BPP);
		dst += (size_t)data->pitch * VIRTIO_GPU_BPP;
		src += (size_t)desc->pitch * VIRTIO_GPU_BPP;
	}

	virtio_gpu_mark_dirty(data, x, y, desc->width, desc->height);
	if (!desc->frame_incomplete) {
		ret = virtio_gpu_update(dev);
	}

	k_mutex_unlock(&data->lock);

	return ret;
}

static int virtio_gpu_read(const struct device *dev, uint16_t x, uint16_t y,
			   const struct display_buffer_descriptor *desc, void *buf)
{
	struct virtio_gpu_data *data = dev->data;
	const uint8_t *src;
	uint8_t *dst = buf;
	size_t required_size;

	if (buf == NULL || desc->width == 0 || desc->height == 0 || desc->pitch < desc->width ||
	    x >= data->width || y >= data->height || desc->width > data->width - x ||
	    desc->height > data->height - y) {
		return -EINVAL;
	}

	required_size = (size_t)desc->pitch * desc->height * VIRTIO_GPU_BPP;
	if (desc->buf_size < required_size) {
		return -EINVAL;
	}

	k_mutex_lock(&data->lock, K_FOREVER);

	src = data->fb + ((size_t)y * data->pitch + x) * VIRTIO_GPU_BPP;
	for (uint32_t row = 0; row < desc->height; row++) {
		memcpy(dst, src, (size_t)desc->width * VIRTIO_GPU_BPP);
		src += (size_t)data->pitch * VIRTIO_GPU_BPP;
		dst += (size_t)desc->pitch * VIRTIO_GPU_BPP;
	}

	k_mutex_unlock(&data->lock);

	return 0;
}

static void virtio_gpu_get_capabilities(const struct device *dev, struct display_capabilities *caps)
{
	struct virtio_gpu_data *data = dev->data;

	memset(caps, 0, sizeof(*caps));
	caps->x_resolution = data->width;
	caps->y_resolution = data->height;
	caps->supported_pixel_formats = PIXEL_FORMAT_ARGB_8888;
	caps->current_pixel_format = PIXEL_FORMAT_ARGB_8888;
	caps->current_orientation = DISPLAY_ORIENTATION_NORMAL;
}

static int virtio_gpu_set_pixel_format(const struct device *dev, enum display_pixel_format format)
{
	ARG_UNUSED(dev);

	return format == PIXEL_FORMAT_ARGB_8888 ? 0 : -ENOTSUP;
}

static int virtio_gpu_set_orientation(const struct device *dev,
				      enum display_orientation orientation)
{
	ARG_UNUSED(dev);

	return orientation == DISPLAY_ORIENTATION_NORMAL ? 0 : -ENOTSUP;
}

static uint16_t virtio_gpu_enum_queues(uint16_t queue_idx, uint16_t max_size, void *unused)
{
	ARG_UNUSED(queue_idx);
	ARG_UNUSED(unused);

	return MIN(CONFIG_VIRTIO_GPU_DISPLAY_QUEUE_SIZE, max_size);
}

static int virtio_gpu_init(const struct device *dev)
{
	const struct virtio_gpu_config *cfg = dev->config;
	struct virtio_gpu_data *data = dev->data;
	struct virtio_gpu_resp_display_info display_info;
	struct virtio_gpu_display_one *mode;
	struct virtio_gpu_dirty full_frame;
	uint32_t width;
	uint32_t height;
	uint64_t required_size;
	int ret;

	if (!device_is_ready(cfg->vdev)) {
		return -ENODEV;
	}
	if (cfg->scanout >= VIRTIO_GPU_MAX_SCANOUTS) {
		return -EINVAL;
	}

	k_mutex_init(&data->lock);

	ret = virtio_commit_feature_bits(cfg->vdev);
	if (ret != 0) {
		return ret;
	}

	ret = virtio_init_virtqueues(cfg->vdev, VIRTIO_GPU_QUEUE_COUNT, virtio_gpu_enum_queues,
				     NULL);
	if (ret != 0) {
		LOG_ERR("failed to initialize virtqueues: %d", ret);
		return ret;
	}

	data->controlq = virtio_get_virtqueue(cfg->vdev, VIRTIO_GPU_CONTROLQ_IDX);
	if (data->controlq == NULL) {
		return -ENODEV;
	}

	virtio_finalize_init(cfg->vdev);

	ret = virtio_gpu_get_display_info(dev, &display_info);
	if (ret != 0) {
		return ret;
	}

	mode = &display_info.pmodes[cfg->scanout];
	width = sys_le32_to_cpu(mode->r.width);
	height = sys_le32_to_cpu(mode->r.height);
	if (sys_le32_to_cpu(mode->enabled) == 0 || width == 0 || height == 0 ||
	    width > UINT16_MAX || height > UINT16_MAX) {
		LOG_ERR("scanout %u is unavailable", cfg->scanout);
		return -ENODEV;
	}
	if (width != cfg->width || height != cfg->height) {
		LOG_ERR("scanout %u is %ux%u, expected %ux%u", cfg->scanout, width, height,
			cfg->width, cfg->height);
		return -EINVAL;
	}

	required_size = (uint64_t)width * height * VIRTIO_GPU_BPP;
	if (required_size > cfg->fb_size || required_size > UINT32_MAX) {
		LOG_ERR("scanout %ux%u needs %llu bytes, framebuffer has %zu", width, height,
			required_size, cfg->fb_size);
		return -ENOMEM;
	}

	data->width = width;
	data->height = height;
	data->pitch = width;

	device_map(&data->fb_map, cfg->fb_phys, required_size, K_MEM_CACHE_NONE);
	data->fb = (uint8_t *)data->fb_map;
	memset(data->fb, 0, required_size);

	ret = virtio_gpu_create_resource(dev);
	if (ret != 0) {
		return ret;
	}

	ret = virtio_gpu_attach_backing(dev, required_size);
	if (ret != 0) {
		return ret;
	}

	ret = virtio_gpu_set_scanout(dev, true);
	if (ret != 0) {
		return ret;
	}

	full_frame = (struct virtio_gpu_dirty){
		.x1 = 0,
		.y1 = 0,
		.x2 = width,
		.y2 = height,
		.valid = true,
	};
	data->dirty = full_frame;
	ret = virtio_gpu_update(dev);
	if (ret != 0) {
		return ret;
	}

	LOG_INF("scanout %u initialized at %ux%u", cfg->scanout, width, height);
	return 0;
}

static DEVICE_API(display, virtio_gpu_api) = {
	.blanking_on = virtio_gpu_blanking_on,
	.blanking_off = virtio_gpu_blanking_off,
	.write = virtio_gpu_write,
	.read = virtio_gpu_read,
	.get_capabilities = virtio_gpu_get_capabilities,
	.set_pixel_format = virtio_gpu_set_pixel_format,
	.set_orientation = virtio_gpu_set_orientation,
};

#define VIRTIO_GPU_DEFINE(inst)                                                                    \
	static struct virtio_gpu_data virtio_gpu_data_##inst;                                      \
	static const struct virtio_gpu_config virtio_gpu_config_##inst = {                         \
		.vdev = DEVICE_DT_GET(DT_PARENT(DT_DRV_INST(inst))),                               \
		.fb_phys = DT_REG_ADDR(DT_INST_PHANDLE(inst, memory_region)),                      \
		.fb_size = DT_REG_SIZE(DT_INST_PHANDLE(inst, memory_region)),                      \
		.scanout = DT_INST_PROP(inst, scanout),                                            \
		.width = DT_INST_PROP(inst, width),                                                \
		.height = DT_INST_PROP(inst, height),                                              \
	};                                                                                         \
	DEVICE_DT_INST_DEFINE(inst, virtio_gpu_init, NULL, &virtio_gpu_data_##inst,                \
			      &virtio_gpu_config_##inst, POST_KERNEL,                              \
			      CONFIG_DISPLAY_INIT_PRIORITY, &virtio_gpu_api);

DT_INST_FOREACH_STATUS_OKAY(VIRTIO_GPU_DEFINE)
