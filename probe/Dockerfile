# Probe bridge: WebSocket ↔ USB-serial CTF (+ optional GDB TCP proxy).
#
# USB serial needs the host device node passed in, e.g.
#   docker run --rm -p 8740:8740 --device=/dev/ttyACM0 \
#     -e SERIAL=/dev/ttyACM0 ghcr.io/kartben/zephyr-in-the-browser/probe
# On macOS/Windows, prefer a native `npm start` in probe/ — Docker Desktop
# does not pass USB serial cleanly.

FROM node:24-bookworm-slim

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY protocol.mjs serial.mjs gdbProxy.mjs server.mjs tui.mjs cli.mjs ./

ENV PORT=8740
ENV NO_TUI=1
EXPOSE 8740

USER node

LABEL org.opencontainers.image.source="https://github.com/kartben/zephyr-in-the-browser" \
      org.opencontainers.image.description="WebSocket probe bridge (serial CTF + GDB) for zephyr-in-the-browser"

CMD ["node", "cli.mjs"]
