# Out-of-tree Zephyr module providing the qemu,host-sensor, qemu,host-gpio,
# qemu,host-audio (I2S) and qemu,host-mic (DMIC) drivers, plus the
# browser_bridge shield (boards/shields/browser_bridge/), which wires the
# browser-fed peripherals into the QEMU boards. It also carries a vendored
# copy of the not-yet-upstream virtio,gpu display driver (drivers/vendor/).

# Vendored driver, built only while Zephyr itself lacks one: an in-tree copy
# would define the same symbols and break the link. See drivers/vendor/VENDOR.md.
set(VENDORED_VIRTIO_GPU drivers/vendor/display_virtio_gpu.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/display/display_virtio_gpu.c)
  set(VENDORED_VIRTIO_GPU "")
endif()

# zephyr_library() is created once and shared by all the drivers.
if(CONFIG_QEMU_HOST_SENSOR OR CONFIG_QEMU_HOST_GPIO OR CONFIG_QEMU_HOST_AUDIO
   OR CONFIG_QEMU_HOST_MIC OR (CONFIG_VIRTIO_GPU_DISPLAY AND VENDORED_VIRTIO_GPU))
  zephyr_library()
endif()

if(CONFIG_VIRTIO_GPU_DISPLAY AND VENDORED_VIRTIO_GPU)
  zephyr_library_sources(${VENDORED_VIRTIO_GPU})
endif()

if(CONFIG_QEMU_HOST_SENSOR)
  zephyr_library_sources(drivers/qemu_host_sensor.c)
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
