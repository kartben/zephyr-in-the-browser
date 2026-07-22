# Out-of-tree Zephyr module providing the qemu,host-sensor and qemu,host-gpio
# drivers. zephyr_library() is created once and shared by both.
if(CONFIG_QEMU_HOST_SENSOR OR CONFIG_QEMU_HOST_GPIO)
  zephyr_library()
endif()

if(CONFIG_QEMU_HOST_SENSOR)
  zephyr_library_sources(drivers/qemu_host_sensor.c)
endif()

if(CONFIG_QEMU_HOST_GPIO)
  zephyr_library_sources(drivers/qemu_host_gpio.c)
endif()
