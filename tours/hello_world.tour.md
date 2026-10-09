---
tour: Hello Zephyr: application anatomy
sample: samples/hello_world
---

This first lesson is about the shape of a Zephyr application before it is about
an API.

The stock **Hello World** sample is intentionally tiny, but it already has the
same core pieces as a much larger application:

```text
samples/hello_world/
├── CMakeLists.txt
├── prj.conf
└── src/
    └── main.c
```

`CMakeLists.txt` makes this directory a Zephyr application and adds
`src/main.c` to the `app` target. `prj.conf` is the application's Kconfig
fragment; in this sample it is deliberately empty because no extra software
features need to be selected.

As applications grow, the same directory can also contain files such as
`app.overlay`, board-specific configuration, an application `Kconfig`, tests,
and more source files. The important idea is that the **application drives the
build**: Zephyr and the application are configured and linked into the final
firmware image together.

## Your application starts in `main()`

```tour
at: main.c:/int main/ | main.c:9
highlight: /int main/ + 5
threads: yes
```

There is no generated application class or framework callback to implement.
The application provides an ordinary C `main()` function.

Zephyr runs it in the **main thread**. Look at the thread list on this card: even
this one-function program is already running in the kernel's thread context.
Later lessons will create more threads and make the scheduler visible in Trace.

The source file itself is just application code. The Zephyr-specific build
machinery lives outside `main.c` in `CMakeLists.txt` and the configuration
files.

## Configuration becomes C symbols

```tour
at: main.c:/printf/ | main.c:11
highlight: /CONFIG_BOARD_TARGET/
```

The program prints `CONFIG_BOARD_TARGET`. Symbols beginning with `CONFIG_` come
from the build's **Kconfig configuration**.

This one describes the board target chosen for the build. The same mechanism is
used by applications to enable subsystems, choose logging levels, size stacks,
and set application-specific options.

Notice the separation of responsibilities:

- **CMake** decides what source participates in the application build.
- **Kconfig** selects and configures software features.
- **Devicetree** will describe hardware; a later lesson introduces it on its own.
- **C code** consumes the resulting configuration through generated definitions
  and Zephyr APIs.

When you continue, `printf()` writes the familiar line to the terminal and
`main()` returns. That is enough for a complete Zephyr application.

For a local Zephyr workspace, the equivalent next step is to build this
application with `west build -b <board> samples/hello_world` and inspect the
`build/zephyr/` output. In the browser, the ELF is already built and loaded for
you; the code and configuration model are the same.
