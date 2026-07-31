#!/usr/bin/env python3
"""Capture Go bridge TUI frames to PNG via a PTY + pyte."""

from __future__ import annotations

import os
import select
import signal
import struct
import time
from pathlib import Path

import pyte
from PIL import Image, ImageDraw, ImageFont

OUT = Path("/opt/cursor/artifacts/screenshots")
OUT.mkdir(parents=True, exist_ok=True)

COLS, ROWS = 100, 28
CELL_W, CELL_H = 9, 16


def ansi_color(fg: str | None, bg: str | None, bold: bool) -> tuple[tuple[int, int, int], tuple[int, int, int]]:
    palette = {
        "black": (20, 20, 20),
        "red": (220, 80, 80),
        "green": (80, 200, 120),
        "yellow": (230, 190, 80),
        "blue": (80, 140, 220),
        "magenta": (200, 100, 200),
        "cyan": (80, 200, 220),
        "white": (220, 220, 220),
        "default": (210, 210, 210),
        "brown": (230, 190, 80),
    }
    fg_rgb = palette.get(fg or "default", palette["default"])
    if bold and fg_rgb == palette["default"]:
        fg_rgb = (255, 255, 255)
    bg_rgb = (18, 18, 22) if not bg or bg == "default" else palette.get(bg, (18, 18, 22))
    return fg_rgb, bg_rgb


def render(screen: pyte.Screen, path: Path) -> None:
    img = Image.new("RGB", (COLS * CELL_W + 24, ROWS * CELL_H + 24), (18, 18, 22))
    draw = ImageDraw.Draw(img)
    try:
        font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf", 13)
    except OSError:
        font = ImageFont.load_default()

    for y in range(ROWS):
        for x in range(COLS):
            cell = screen.buffer[y][x]
            ch = cell.data or " "
            fg, bg = ansi_color(cell.fg, cell.bg, cell.bold)
            x0, y0 = 12 + x * CELL_W, 12 + y * CELL_H
            draw.rectangle([x0, y0, x0 + CELL_W, y0 + CELL_H], fill=bg)
            if ch.strip() or ch == " ":
                draw.text((x0, y0), ch, fill=fg, font=font)
    img.save(path)


def main() -> None:
    import pty
    import subprocess

    screen = pyte.Screen(COLS, ROWS)
    stream = pyte.Stream(screen)

    env = os.environ.copy()
    env.update(
        {
            "TOKEN": "demo",
            "PORT": "8742",
            "AUTO_SERIAL": "0",
            "TERM": "xterm-256color",
            "HOME": env.get("HOME", "/tmp"),
        }
    )

    master, slave = pty.openpty()
    # Set winsize
    winsize = struct.pack("HHHH", ROWS, COLS, 0, 0)
    import fcntl
    import termios

    fcntl.ioctl(slave, termios.TIOCSWINSZ, winsize)

    proc = subprocess.Popen(
        ["/tmp/zephyr-bridge"],
        stdin=slave,
        stdout=slave,
        stderr=slave,
        env=env,
        close_fds=True,
        start_new_session=True,
    )
    os.close(slave)

    deadline = time.time() + 3.0
    buf = b""
    try:
        while time.time() < deadline:
            r, _, _ = select.select([master], [], [], 0.2)
            if master in r:
                chunk = os.read(master, 65536)
                if not chunk:
                    break
                buf += chunk
                stream.feed(chunk.decode("utf-8", errors="ignore"))
            else:
                # idle — screen should be stable
                if b"Zephyr bridge" in buf or "Zephyr bridge" in "".join(
                    "".join(screen.buffer[y][x].data for x in range(COLS)) for y in range(min(5, ROWS))
                ):
                    time.sleep(0.3)
                    # drain
                    while select.select([master], [], [], 0.05)[0]:
                        chunk = os.read(master, 65536)
                        buf += chunk
                        stream.feed(chunk.decode("utf-8", errors="ignore"))
                    break

        render(screen, OUT / "12-go-bridge-tui.png")

        # Press ? for help
        os.write(master, b"?")
        time.sleep(0.5)
        while select.select([master], [], [], 0.1)[0]:
            chunk = os.read(master, 65536)
            stream.feed(chunk.decode("utf-8", errors="ignore"))
        render(screen, OUT / "13-go-bridge-tui-help.png")

        os.write(master, b"q")
        time.sleep(0.4)
    finally:
        try:
            os.killpg(proc.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
        try:
            proc.wait(timeout=2)
        except Exception:
            proc.kill()
        os.close(master)

    print("wrote", OUT / "12-go-bridge-tui.png")
    print("wrote", OUT / "13-go-bridge-tui-help.png")


if __name__ == "__main__":
    main()
