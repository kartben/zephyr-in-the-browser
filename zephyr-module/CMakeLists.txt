# Out-of-tree Zephyr module providing the qemu,host-gpio, qemu,host-audio (I2S)
# and qemu,host-mic (DMIC) drivers, plus the browser_bridge shield
# (boards/shields/browser_bridge/), which wires the browser-fed peripherals into
# the QEMU boards. It also carries vendored copies of the not-yet-upstream
# virtio,gpu driver, the auxdisplay shell, and a workqueue-based gpio-7-segment
# fix (drivers/vendor/). The virtio,gpio / virtio,i2c / virtio,spi drivers were
# vendored here until they landed in mainline; the Zephyr tree ships them now.

# Vendored drivers, built only while Zephyr itself lacks them: an in-tree copy
# would define the same symbols and break the link. See drivers/vendor/VENDOR.md.
set(VENDORED_VIRTIO_GPU drivers/vendor/display_virtio_gpu.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/display/display_virtio_gpu.c)
  set(VENDORED_VIRTIO_GPU "")
endif()

set(VENDORED_AUXDISPLAY_SHELL drivers/vendor/auxdisplay_shell.c)
if(EXISTS ${ZEPHYR_BASE}/drivers/auxdisplay/auxdisplay_shell.c)
  set(VENDORED_AUXDISPLAY_SHELL "")
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
   OR (CONFIG_AUXDISPLAY_SHELL AND VENDORED_AUXDISPLAY_SHELL)
   OR CONFIG_AUXDISPLAY_GPIO_7SEG_WQ
   OR CONFIG_PM_DEMO_DEVICE)
  zephyr_library()
endif()

if(CONFIG_VIRTIO_GPU_DISPLAY AND VENDORED_VIRTIO_GPU)
  zephyr_library_sources(${VENDORED_VIRTIO_GPU})
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

