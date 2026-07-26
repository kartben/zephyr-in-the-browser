# Out-of-tree Zephyr module providing the qemu,host-gpio, qemu,host-audio (I2S)
# and qemu,host-mic (DMIC) drivers, plus the browser_bridge shield
# (boards/shields/browser_bridge/), which wires the browser-fed peripherals into
# the QEMU boards. It also carries vendored copies of the not-yet-upstream
# virtio,gpu display and virtio,gpio drivers (drivers/vendor/).

# Vendored drivers, built only while Zephyr itself lacks them: an in-tree copy
# would define the same symbols and break the link. See drivers/vendor/VENDOR.md.
set(VENDORED_VIRTIO_GPU drivers/vendor/display_virtio_gpu.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/display/display_virtio_gpu.c)
  set(VENDORED_VIRTIO_GPU "")
endif()

set(VENDORED_VIRTIO_GPIO drivers/vendor/gpio_virtio.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/gpio/gpio_virtio.c)
  set(VENDORED_VIRTIO_GPIO "")
endif()

set(VENDORED_VIRTIO_SPI drivers/vendor/spi_virtio.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/spi/spi_virtio.c)
  set(VENDORED_VIRTIO_SPI "")
endif()

# Not vendored — this one is written here, since Zephyr has no virtio I2C
# driver at all — but it takes the same guard, because it uses the Kconfig and
# file name upstream would and is meant to go there.
set(OWN_VIRTIO_I2C drivers/i2c_virtio.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/i2c/i2c_virtio.c)
  set(OWN_VIRTIO_I2C "")
endif()

# zephyr_library() is created once and shared by all the drivers.
if(CONFIG_QEMU_HOST_GPIO OR CONFIG_QEMU_HOST_AUDIO
   OR CONFIG_QEMU_HOST_MIC OR (CONFIG_VIRTIO_GPU_DISPLAY AND VENDORED_VIRTIO_GPU)
   OR (CONFIG_GPIO_VIRTIO AND VENDORED_VIRTIO_GPIO)
   OR (CONFIG_SPI_VIRTIO AND VENDORED_VIRTIO_SPI)
   OR (CONFIG_I2C_VIRTIO AND OWN_VIRTIO_I2C))
  zephyr_library()
endif()

if(CONFIG_I2C_VIRTIO AND OWN_VIRTIO_I2C)
  zephyr_library_sources(${OWN_VIRTIO_I2C})
endif()

if(CONFIG_VIRTIO_GPU_DISPLAY AND VENDORED_VIRTIO_GPU)
  zephyr_library_sources(${VENDORED_VIRTIO_GPU})
endif()

if(CONFIG_GPIO_VIRTIO AND VENDORED_VIRTIO_GPIO)
  zephyr_library_sources(${VENDORED_VIRTIO_GPIO})
endif()

if(CONFIG_SPI_VIRTIO AND VENDORED_VIRTIO_SPI)
  zephyr_library_sources(${VENDORED_VIRTIO_SPI})
endif()
if(CONFIG_QEMU_HOST_GPIO)
  zephyr_library_sources(drivers/qemu_host_gpio.c)
endif()

if(CONFIG_QEMU_HOST_AUDIO)
  zephyr_library_sources(drivers/qemu_host_audio.c)
  # The audio driver has a public API (qemu_host_audio.h) for applications.
  zephyr_include_directories(include)
endif()

if(CONFIG_QEMU_HOST_AUDIO_SHELL)
  zephyr_library_sources(drivers/qemu_host_audio_shell.c)
endif()

if(CONFIG_QEMU_HOST_MIC)
  zephyr_library_sources(drivers/qemu_host_mic.c)
endif()
