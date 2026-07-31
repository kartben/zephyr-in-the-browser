# The Dockerfile builds passt from source (same pin as gateway/) then adds
# serialport. USB serial needs --device on Linux; Docker Desktop on Mac/Windows
# typically cannot see adapters — run native `npm start` there.

FROM node:24-alpine AS passt-build
ARG PASST_VERSION=2026_07_16.090d739
RUN apk add --no-cache build-base linux-headers git coreutils
RUN git clone --depth 1 --branch ${PASST_VERSION} https://passt.top/passt /passt \
    && make -C /passt passt VERSION=${PASST_VERSION} \
    && install -m 0755 /passt/passt /usr/local/bin/passt

FROM node:24-bookworm-slim

COPY --from=passt-build /usr/local/bin/passt /usr/local/bin/passt

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY protocol.mjs serial.mjs gdbProxy.mjs net.mjs server.mjs tui.mjs cli.mjs ./

ENV PORT=8740
ENV NO_TUI=1
EXPOSE 8740

USER node

LABEL org.opencontainers.image.source="https://github.com/kartben/zephyr-in-the-browser" \
      org.opencontainers.image.description="Uber bridge: serial CTF + passt net + GDB for zephyr-in-the-browser"

CMD ["node", "cli.mjs"]
