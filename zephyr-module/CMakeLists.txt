# Out-of-tree Zephyr module providing the qemu,host-sensor, qemu,host-gpio and
# qemu,host-audio drivers, plus the browser_bridge shield
# (boards/shields/browser_bridge/), which wires the browser-fed peripherals
# into the QEMU boards.
# zephyr_library() is created once and shared by all the drivers.
if(CONFIG_QEMU_HOST_SENSOR OR CONFIG_QEMU_HOST_GPIO OR CONFIG_QEMU_HOST_AUDIO)
  zephyr_library()
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
