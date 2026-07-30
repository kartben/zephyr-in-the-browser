# Out-of-tree Zephyr module providing the qemu,host-gpio, qemu,host-audio (I2S)
# and qemu,host-mic (DMIC) drivers, plus the browser_bridge shield
# (boards/shields/browser_bridge/), which wires the browser-fed peripherals into
# the QEMU boards. It also carries vendored copies of the not-yet-upstream
# virtio,gpu / virtio,gpio / virtio,spi / virtio,blk drivers, the auxdisplay
# shell, and a workqueue-based gpio-7-segment fix (drivers/vendor/).

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

set(VENDORED_VIRTIO_BLK drivers/vendor/virtio_blk.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/disk/virtio_blk.c)
  set(VENDORED_VIRTIO_BLK "")
endif()

set(VENDORED_AUXDISPLAY_SHELL drivers/vendor/auxdisplay_shell.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/auxdisplay/auxdisplay_shell.c)
  set(VENDORED_AUXDISPLAY_SHELL "")
endif()

# Not vendored — this one is written here, since Zephyr has no virtio I2C
# driver at all — but it takes the same guard, because it uses the Kconfig and
# file name upstream would and is meant to go there.
set(OWN_VIRTIO_I2C drivers/i2c_virtio.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/i2c/i2c_virtio.c)
  set(OWN_VIRTIO_I2C "")
endif()

# The module's public headers: qemu_host_audio.h for the audio API.
# Unconditional — this used to sit
# inside the CONFIG_QEMU_HOST_AUDIO block below, where it only resolved because
# the browser_bridge shield happens to instantiate a qemu,host-audio node on
# every board. Building without the shield turned a missing -I into an error
# that pointed at the application.
zephyr_include_directories(include)

# zephyr_library() is created once and shared by all the drivers.
if(CONFIG_QEMU_HOST_GPIO OR CONFIG_QEMU_HOST_AUDIO
   OR CONFIG_QEMU_HOST_MIC OR (CONFIG_VIRTIO_GPU_DISPLAY AND VENDORED_VIRTIO_GPU)
   OR (CONFIG_GPIO_VIRTIO AND VENDORED_VIRTIO_GPIO)
   OR (CONFIG_SPI_VIRTIO AND VENDORED_VIRTIO_SPI)
   OR (CONFIG_DISK_DRIVER_VIRTIO_BLK AND VENDORED_VIRTIO_BLK)
   OR (CONFIG_I2C_VIRTIO AND OWN_VIRTIO_I2C)
   OR (CONFIG_AUXDISPLAY_SHELL AND VENDORED_AUXDISPLAY_SHELL)
   OR CONFIG_AUXDISPLAY_GPIO_7SEG_WQ
   OR CONFIG_PM_DEMO_DEVICE)
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
  # spi_virtio.c uses the shared spi_context.h/spi_rtio.h helpers, which live in
  # the tree's drivers/spi and are not on the default include path for an
  # out-of-tree module source.
  zephyr_library_include_directories(${ZEPHYR_BASE}/drivers/spi)
endif()

if(CONFIG_DISK_DRIVER_VIRTIO_BLK AND VENDORED_VIRTIO_BLK)
  zephyr_library_sources(${VENDORED_VIRTIO_BLK})
  # Under CONFIG_MMU the driver calls arch_page_phys_get() to walk a buffer
  # page by page. That is declared only in kernel/include/kernel_arch_interface.h
  # -- a private kernel header -- and the driver does not include it, relying on
  # whatever the in-tree drivers/disk build happens to have already pulled in.
  # Out of tree neither the path nor the declaration is there.
  #
  # Forced from here rather than by editing the source, so the vendored copy
  # stays byte-identical to upstream and drift stays a one-line diff. Delete
  # this whole block, not just the guard, once the driver lands in-tree.
  zephyr_library_include_directories(
    ${ZEPHYR_BASE}/kernel/include
    ${ZEPHYR_BASE}/arch/${ARCH}/include
  )
  set_property(SOURCE ${VENDORED_VIRTIO_BLK} APPEND PROPERTY
    COMPILE_OPTIONS -include kernel_arch_interface.h)
endif()

if(CONFIG_AUXDISPLAY_SHELL AND VENDORED_AUXDISPLAY_SHELL)
  zephyr_library_sources(${VENDORED_AUXDISPLAY_SHELL})
endif()

# Always our copy while enabled: upstream ships a broken ISR refresh we replace.
# Unlike the other vendored drivers, absence of the in-tree file is not the
# gate — the in-tree file exists and must stay CONFIG_AUXDISPLAY_GPIO_7SEG=n.
if(CONFIG_AUXDISPLAY_GPIO_7SEG_WQ)
  zephyr_library_sources(drivers/vendor/auxdisplay_gpio_7seg.c)
endif()

if(CONFIG_QEMU_HOST_GPIO)
  zephyr_library_sources(drivers/qemu_host_gpio.c)
endif()

if(CONFIG_QEMU_HOST_AUDIO)
  zephyr_library_sources(drivers/qemu_host_audio.c)
endif()

if(CONFIG_QEMU_HOST_AUDIO_SHELL)
  zephyr_library_sources(drivers/qemu_host_audio_shell.c)
endif()

if(CONFIG_QEMU_HOST_MIC)
  zephyr_library_sources(drivers/qemu_host_mic.c)
endif()

if(CONFIG_PM_DEMO_DEVICE)
  zephyr_library_sources(drivers/pm_demo_device.c)
endif()

