# Zephyr tutorial curriculum

This document sketches a progressive, browser-first curriculum for learning the
main Zephyr concepts and APIs in **Zephyr in the Browser**.

The goal is not to mirror the upstream sample tree. Each lesson should introduce
one or two new ideas, reuse earlier concepts, and give the learner something they
can see in the terminal, device dock, Trace, or Debug views.

Prefer a **stock upstream Zephyr sample + guided tour** when it already tells the
right story. Add a small repo-local application under `zephyr-module/` when a
purpose-built example makes the progression clearer.

## Lesson shape

Each lesson should have the same rough structure:

- **What you will learn** — 2–4 concrete outcomes.
- **What the application does** — one paragraph and a small diagram when useful.
- **Application anatomy** — the files involved (`CMakeLists.txt`, `prj.conf`,
  `src/`, and overlays when relevant).
- **Key concepts** — only the concepts introduced in this lesson.
- **Walk through the code** — source in execution order, not API-reference order.
- **Run it in the browser** — what to click and what to observe.
- **How it works** — the deeper explanation after the learner has seen it run.
- **Things to try** — 2–3 small changes or questions.
- **Going further** — links to the relevant Zephyr documentation and samples.

Every lesson should have one obvious **aha!** moment that the browser makes
visible.

## Group 1 — Foundations

### 1. Hello Zephyr: application structure and `main()`

**Browser strategy:** stock `samples/hello_world` + guided tour.

**Code / concepts**

- Show the conventional application layout:
  - `CMakeLists.txt`
  - `prj.conf`
  - `src/main.c`
- Explain that a Zephyr build is application-centric: the application pulls in
  Zephyr and both are linked into one image.
- `find_package(Zephyr ...)`, `project()`, and `target_sources(app ...)`.
- `prj.conf` as the application's Kconfig fragment; it can legitimately be
  empty.
- `main()` runs as the main thread.
- Print a line and return.

**README / lesson outline**

- What is a Zephyr application?
- The minimum application directory.
- What CMake configures vs what Kconfig configures.
- Where `main()` comes from and what context it runs in.
- Build/run locally with `west build` as a bridge from browser to real hardware.
- Run in browser and stop at `main()`.
- Things to try: change the string; add a Kconfig option; inspect the generated
  configuration.

**Aha:** the learner sees that there is no special IDE project or generated
boilerplate: a Zephyr application is a small, ordinary source tree that drives
the build.

### 2. Time, logging, and configuration

**Browser strategy:** small repo-local application.

**Code / concepts**

- `LOG_MODULE_REGISTER()` and `LOG_INF()`.
- `k_sleep()` / `K_SECONDS()`.
- A custom application Kconfig symbol for the print interval.
- Read the selected value through `CONFIG_*`.

**README / lesson outline**

- Why use Zephyr logging instead of scattering `printf()` calls.
- Logging levels and compile-time configuration.
- Kernel timeouts and sleeping vs busy waiting.
- How `prj.conf` selects software features.
- Things to try: change log level and interval.

**Aha:** a configuration-only change alters application behavior without
changing C source.

### 3. Threads and scheduling

**Browser strategy:** purpose-built app, with a traced twin.

**Code / concepts**

- Main thread plus two `K_THREAD_DEFINE()` workers.
- Stack size and priority.
- Preemptive vs cooperative priorities.
- `k_sleep()` to make scheduling easy to observe.

**README / lesson outline**

- What a Zephyr thread is.
- Main thread vs application-created threads.
- Thread stacks.
- Priority numbering and scheduling.
- Cooperative vs preemptive execution.
- Use Trace to watch the scheduler.
- Things to try: swap priorities; make one thread cooperative.

**Aha:** Trace makes a priority change visible as a different execution
schedule.

## Group 2 — Synchronization and asynchronous work

### 4. Synchronizing threads

**Browser strategy:** small repo-local application, with Trace/Debug object views.

**Code / concepts**

- Producer and consumer threads.
- `k_sem_take()` / `k_sem_give()`.
- Shared statistics protected by `k_mutex`.
- `K_FOREVER`, `K_NO_WAIT`, and finite timeouts.

**README / lesson outline**

- Race conditions and synchronization.
- Semaphore vs mutex.
- Timeout semantics.
- Priority inheritance at a conceptual level.
- What can be called from ISR context.
- Use Debug → Objects to inspect live semaphores and mutexes.

**Aha:** the browser can show the mutex owner and semaphore count while the
program is stopped.

### 5. Passing data with message queues

**Browser strategy:** stock `samples/kernel/msg_queue` + guided tour; it is
already packaged by the browser.

**Code / concepts**

- `K_MSGQ_DEFINE()`.
- Fixed-size messages.
- `k_msgq_put()`, `k_msgq_put_front()`, and `k_msgq_get()`.
- Producer/consumer decoupling and queue-full behavior.

**README / lesson outline**

- Passing data vs sharing mutable state.
- Message queue storage and copy semantics.
- Blocking and non-blocking operations.
- When to choose message queues, FIFO, queue, or pipe.
- Use Trace/Debug to inspect producers, consumers, and queue state.

**Aha:** the queue is visible as a live kernel object, not just an abstract API.

### 6. Timers and workqueues

**Browser strategy:** purpose-built app.

**Code / concepts**

- `k_timer` for periodic expiry.
- `k_work` and `k_work_delayable`.
- Timer/ISR-like callback does the minimum and submits work.
- System workqueue vs creating another thread.

**README / lesson outline**

- Why callbacks should stay short.
- Deferred work pattern.
- Timer vs sleeping thread.
- Immediate vs delayable work.
- When a dedicated thread is justified.

**Aha:** Trace shows the callback causing work to execute later in the system
workqueue thread.

## Group 3 — Zephyr's hardware model

### 7. Devicetree: describing hardware

**Browser strategy:** purpose-built app plus a minimal overlay.

**Code / concepts**

- Nodes, properties, labels, aliases, and `status`.
- `app.overlay` as application-specific hardware description.
- `DT_ALIAS()`, `DT_NODELABEL()`, `DT_PROP()`, and status checks.
- Inspect the running flattened devicetree in the browser.

**README / lesson outline**

- What devicetree is and is not.
- Board DTS/DTSI vs application overlay.
- `compatible`, properties, aliases, chosen nodes.
- Build-time nature of DT macros.
- Where to inspect generated `zephyr.dts` locally.

**Aha:** change a property in the overlay, rebuild, and the C code observes the
new value without containing a board-specific constant.

### 8. Devices, GPIO, and interrupts

**Browser strategy:** stock `samples/basic/blinky` and `samples/basic/button`,
using the existing guided tours and browser GPIO/LED panels.

**Code / concepts**

- Zephyr device model at a user-facing level.
- `gpio_dt_spec` and `GPIO_DT_SPEC_GET()`.
- `gpio_is_ready_dt()` and GPIO configuration.
- GPIO interrupt callback.
- Hand non-trivial work off to a work item.

**README / lesson outline**

- How a devicetree node becomes a device used by an application.
- Why `*_dt_spec` helpers are useful.
- GPIO input/output and interrupt configuration.
- ISR restrictions and deferred work.
- Use the dock to press the virtual button and watch the LED/pin state.

**Aha:** clicking a browser button causes a real Zephyr GPIO interrupt inside
the emulated guest.

### 9. Sensors and subsystem APIs

**Browser strategy:** a browser-backed stock sensor sample such as LSM6DSO,
plus a focused tour.

**Code / concepts**

- Obtain the sensor device from devicetree.
- Read and decode sensor data using the current Sensor API.
- Configure an attribute such as sampling rate.
- Keep application logic independent of the concrete driver.

**README / lesson outline**

- Driver implementation vs subsystem API.
- Binding/`compatible`/driver relationship.
- Sensor channels and values.
- Reading, decoding, and attributes.
- Move the browser's virtual IMU and watch stock Zephyr driver output change.

**Aha:** browser sliders or physical-device tilt feed bytes through the emulated
bus and stock Zephyr driver before the application sees the measurement.

## Group 4 — Application architecture

### 10. Events and decoupled components with Zbus

**Browser strategy:** purpose-built multi-component app.

**Code / concepts**

- A sensor-like publisher.
- `ZBUS_CHAN_DEFINE()`.
- Listener/subscriber or observer consumers.
- Logger and application-logic consumers that do not know the producer.

**README / lesson outline**

- Threads are execution contexts, not an application architecture by themselves.
- Producers, channels, and consumers.
- Zbus message ownership/lifetime.
- Zbus vs kernel message queue.
- Add a consumer without changing the producer.

**Aha:** a new subscriber receives the same events with no change to the
publisher.

### 11. Persistent configuration

**Browser strategy:** purpose-built app backed by the browser's persistent SPI
flash model.

**Code / concepts**

- Settings subsystem.
- Load a sampling interval at boot.
- Change it at runtime and save it.
- Reboot/reload and retain the value.

**README / lesson outline**

- Raw flash vs storage subsystems.
- Settings handlers and backends.
- Flash partitions/devicetree at a high level.
- What survives reset and why.

**Aha:** change a setting, reload the browser, and see the emulated firmware load
it again from persisted flash.

### 12. Shell: inspect and control the application

**Browser strategy:** purpose-built app or extension of the settings lesson.

**Code / concepts**

- Add application shell commands.
- `status` / `sample` / `interval get` / `interval set` / `config save`.
- Reuse the same application functions used by the rest of the firmware.

**README / lesson outline**

- Enabling the shell with Kconfig.
- Registering commands and parsing arguments.
- Shell backends.
- Built-in diagnostic commands.
- Keeping command handling separate from core application logic.

**Aha:** the learner changes live firmware state interactively from the browser
terminal.

## Group 5 — Connected applications

### 13. Networking and sockets

**Browser strategy:** stock Zephyr socket samples using the existing browser
network model.

**Code / concepts**

- Network interface and IP configuration.
- BSD/POSIX socket API.
- DNS + TCP client or a small echo exchange.
- Handle connection and I/O errors.

**README / lesson outline**

- Network device vs network interface.
- IPv4/IPv6 at a conceptual level.
- Socket lifecycle.
- Blocking I/O and timeouts.
- Use the Network panel to inspect packets and connections.

**Aha:** the learner sees the exact Ethernet/IP/TCP traffic generated by the
socket calls.

### 14. Build a small connected device

**Browser strategy:** purpose-built capstone application.

**Code / concepts**

- Combine sensor input, Zbus, settings, shell, and networking.
- Publish measurements (for example over MQTT or HTTP).
- Receive a configuration update and persist it.
- Reconnect using delayable work rather than a fragile busy loop.

**README / lesson outline**

- Architecture diagram first.
- Component responsibilities.
- Network lifecycle and retry strategy.
- Persistent configuration.
- Threading/workqueue model.
- Exercises that add a second sensor or remote command.

**Aha:** several previously isolated Zephyr APIs now form a small but credible
embedded product architecture.

## Group 6 — Advanced development workflow

### 15. Driver model and testing

This can be split into two lessons later if the series grows beyond 15.

**Browser strategy:** repo-local fake/simple device driver plus ztest.

**Code / concepts**

- Small custom devicetree binding.
- `DT_DRV_COMPAT`, config/data structures, and device instantiation.
- Implement a narrow subsystem API or a deliberately tiny custom API.
- Application consumes the device through the public API.
- Extract pure application logic and test it with ztest/Twister.

**README / lesson outline**

- Binding vs driver vs device instance.
- Compile-time instance generation.
- Configuration data vs runtime data.
- Initialization.
- Why application code should not reach into driver internals.
- ztest suites/assertions and Twister platform execution.

**Aha:** the same application-facing pattern used for Zephyr's stock devices also
works for a device the learner just implemented, and the logic can be tested
without running the full product.

## Why this ordering

- **Application structure comes first.** The learner should understand what
  `CMakeLists.txt`, `prj.conf`, and `src/` are before encountering layers of API
  macros.
- **Kernel concepts precede hardware APIs.** Threads, synchronization, queues,
  and workqueues are useful everywhere and make later callback/ISR patterns make
  sense.
- **Devicetree gets its own lesson.** Teaching `GPIO_DT_SPEC_GET()` before
  devicetree makes the macro look like unexplained magic.
- **Drivers come late.** Driver-instantiation macros are much easier to grasp
  after the learner has already consumed devices through subsystem APIs.
- **The capstone combines earlier lessons.** The series should feel cumulative,
  not like 15 unrelated sample directories.

## Browser integration model

Use the browser's existing strengths deliberately:

- **Guided tours** for code that already exists upstream. Tours can stop the
  unmodified guest at meaningful lines and expose registers, memory, kernel
  objects, source, devicetree, and relevant device panels.
- **Trace** for scheduling, synchronization, queues, and workqueue lessons.
- **Debug → Objects** for live kernel objects such as threads, mutexes,
  semaphores, and message queues.
- **Device dock** for GPIO, sensors, storage, displays, and other hardware-facing
  lessons.
- **Network panel** for socket-level lessons.
- **Repo-local applications** only where a minimal, purpose-built program tells
  the lesson more clearly than an upstream sample.

The browser should eventually expose the lessons as a distinct ordered
**Learn Zephyr** path rather than relying only on the flat application picker.
That UI can come after the lesson metadata and first few tutorials stabilize.

## References

- Zephyr application development:
  <https://docs.zephyrproject.org/latest/develop/application/index.html>
- Kernel services:
  <https://docs.zephyrproject.org/latest/kernel/services/>
- Workqueues:
  <https://docs.zephyrproject.org/latest/kernel/services/threads/workqueue.html>
- Message queues:
  <https://docs.zephyrproject.org/latest/kernel/services/data_passing/message_queues.html>
