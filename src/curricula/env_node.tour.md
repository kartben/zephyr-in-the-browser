---
tour: Environmental node
sample: zephyr-module/apps/env_node
curriculum: Environmental node
---

This path builds a field station: two sensors, a clock, a two-line display,
and a JSON page on the LAN.

The lessons follow the order you would write the application. The image
already contains every file. A desk step shows a build file; a live step
stops the guest.

### What you are running

## Meet the node

```tour
file: README
panel: sensor
```

This station reads pressure, temperature, and light, stamps the reading,
writes two lines on the **text display**, and serves JSON at
`http://192.0.2.1/`.

The **device dock** already names the parts. Move a slider after a live
step to see the next sample change.

## The application is more than main.c

```tour
file: CMakeLists.txt
highlight: /target_sources/ + 4
```

`find_package(Zephyr)` and `project()` are the application skeleton.
`target_sources` is how you add a `.c` file.

```cmake
target_sources(app PRIVATE
  src/main.c
  src/sensors.c
  src/display.c
  src/net.c
)
```

`sensors.c` is in the image because it is listed here. The page does not
rebuild Zephyr.

## Hardware is named in devicetree

```tour
file: env-node.overlay
dts: /lps22hh@5c/ + 4
panel: i2c
```

The overlay names the chips on the I²C bus. **Devicetree** describes the
parts; **Kconfig** selects the software that talks to them.

Look up `lps22hh@5c` in the running tree. The driver binds from that node,
not from a pin number in `main.c`.

### Sensing with RTIO

## An iodev per sensor

```tour
at: sensors.c:/SENSOR_DT_READ_IODEV/ | sensors.c:24
highlight: /SENSOR_DT_READ_IODEV/ + 6
panel: sensor
```

Fetch and get (`sensor_sample_fetch`, then `sensor_channel_get`) reads one
device at a time. This node uses **RTIO** instead: each sensor is an
iodev, and one context holds the queues.

`SENSOR_DT_READ_IODEV` names the LPS22HH and the ISL29035.
`RTIO_DEFINE_WITH_MEMPOOL` is the submission queue, the completion queue,
and the buffers.

## Submit both reads

```tour
at: sensors.c:/sensor_read_async_mempool/ | sensors.c:48
highlight: /sensor_read_async_mempool/ + 4
panel: sensor
```

`sensor_read_async_mempool` starts a read. Call it once per iodev. The
**thread** does not wait for the pressure chip before it starts the light
chip.

Watch the sensor rows in the **device dock**. Both addresses sit on the
same I²C bus.

## Completions and decode

```tour
at: sensors.c:/rtio_cqe_consume_block/ | sensors.c:62
highlight: /rtio_cqe_consume_block/ + 8
panel: sensor
```

`rtio_cqe_consume_block` waits for a completion. That is a queue event,
not a callback.

`sensor_get_decoder` then `sensor_decode` turn the buffer into q31
values. The same thread that submitted the reads picks them up.

## Time belongs on the reading

```tour
at: sensors.c:/rtc_get_time/ | sensors.c:80
highlight: /rtc_get_time/
panel: i2c
```

`rtc_get_time` stamps the decoded sample. A reading without a clock is a
poll. A reading with a clock is a record.

The RTC row in the **device dock** is the PCF8523.

### Show it, serve it

## Write the display

```tour
at: display.c:/auxdisplay_write/ | display.c:28
highlight: /auxdisplay_write/ + 2
panel: auxdisplay
```

`auxdisplay_write` puts the latest reading on the JHD1313. Two lines:
temperature and pressure on the first, light and time on the second.

This is not "Hello World." It is the sample you just decoded.

## LED means a fresh sample

```tour
at: main.c:/led_on/ | main.c:36
panel: led
```

The LED turns on around the sample path. Same GPIO vocabulary as Blinky,
now a status bit: a new reading landed.

## A press demands a sample

```tour
at: main.c:/button_input_cb/ | main.c:44
highlight: /INPUT_CALLBACK_DEFINE/
panel: keys
```

SW0 submits the sampling work. Same idea as the Button sample, wired to
the RTIO loop instead of only a printk.

Continue, then press **SW0** in **GPIO Keys**.

## The LAN gets JSON

```tour
at: net.c:/http/ | net.c:40
panel: net
```

The HTTP handler returns the latest reading as JSON. Open **Network** and
fetch `http://192.0.2.1/`.

### How the image was configured

## Kconfig selected the subsystems

```tour
file: prj.conf
highlight: /CONFIG_SENSOR/
```

```kconfig
CONFIG_SENSOR=y
CONFIG_SENSOR_ASYNC_API=y
CONFIG_RTIO=y
CONFIG_RTC=y
CONFIG_AUXDISPLAY=y
CONFIG_NETWORKING=y
```

Kconfig is which software is compiled in. The overlay is which parts are
present.

## The whole loop

```tour
at: sensors.c:/sample_once/ | sensors.c:40
threads: yes
panel: sensor
```

One **thread** submits both reads, consumes the completions, stamps the
time, and hands the reading to the display and the HTTP handler.

The **device dock** and the **terminal** show the same sample.

## What you would add next

```tour
file: README
```

Logging to flash, a humidity part, and sleeping on a fuel gauge are
gallery apps, not the next lesson here.

LittleFS, Fuel gauge, and the short Blinky / Button tours are the
optional next apps.
