# Out-of-tree Zephyr module providing the qemu,host-sensor driver.
if(CONFIG_QEMU_HOST_SENSOR)
  zephyr_library()
  zephyr_library_sources(drivers/qemu_host_sensor.c)
endif()
