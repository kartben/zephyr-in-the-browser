# The uplink gateway: a ~200-line Node proxy in front of passt.
#
# The browser app tunnels the guest's Ethernet frames here over a WebSocket
# (QEMU stream framing: u32 big-endian length per frame, as a byte stream);
# passt turns them into real sockets on this container's network. One passt
# process per connection — see server.mjs for why that is load-bearing.
#
# passt is Linux-only, which a container makes invisible to macOS/Windows
# hosts: Docker Desktop runs it in its Linux VM. cloudflared is bundled but
# dormant unless TUNNEL=quick, for the one-command public wss:// URL.
#
# If the musl cloudflared smoke test below ever breaks on a new release, the
# pre-approved fallback is node:24-bookworm-slim + `apt-get install passt`
# and the cloudflared .deb.

# passt is built from source at a pinned release because every packaged
# version in Alpine 3.24 (and Debian stable) predates upstream commit
# f072bc0, first shipped in 2026_07_16: older passt drops any IPv4 frame
# whose L2 payload outruns its IP datagram — exactly what guests whose NICs
# pad short frames to the 60-byte Ethernet minimum produce (the Cortex-M3's
# stellaris MAC pads in silicon). Every short TCP segment (SYN, pure ACK,
# FIN) then vanishes without a log line while DNS and DHCP, always long
# enough, keep working: TCP through the gateway hangs and nothing says why.
# The web app also trims that padding client-side, but the gateway must not
# depend on every client being current.
# 2026_07_16 exactly: the first release with the fix, and the one Alpine's
# own edge package proves builds patch-free on musl (later tags grew a
# close_range() call musl has no wrapper for).
FROM node:24-alpine AS passt-build
ARG PASST_VERSION=2026_07_16.090d739
# coreutils: passt's seccomp.sh needs `fmt`, which busybox does not carry.
RUN apk add --no-cache build-base linux-headers git coreutils
RUN git clone --depth 1 --branch ${PASST_VERSION} https://passt.top/passt /passt \
    && make -C /passt passt VERSION=${PASST_VERSION} \
    && install -m 0755 /passt/passt /usr/local/bin/passt

FROM node:24-alpine

COPY --from=passt-build /usr/local/bin/passt /usr/local/bin/passt

# Pinned, multi-arch (TARGETARCH is amd64/arm64 under buildx).
ARG CLOUDFLARED_VERSION=2026.7.3
ARG TARGETARCH
ADD https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-${TARGETARCH} /usr/local/bin/cloudflared
# The --version runs are per-arch smoke tests: a static-linking or packaging
# regression fails the build here instead of a user's `docker run`.
RUN chmod +x /usr/local/bin/cloudflared && cloudflared --version && passt --version

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY server.mjs ./

ENV PORT=8737
EXPOSE 8737

# Hygiene, and one less failure mode: as root passt insists on switching to
# nobody inside its sandbox. Note the sandbox itself (userns + pivot_root)
# needs `docker run --security-opt seccomp=unconfined` either way — Docker's
# default profile blocks those syscalls, and server.mjs probes for that at
# startup and prints the fix.
USER node

LABEL org.opencontainers.image.source="https://github.com/kartben/zephyr-in-the-browser" \
      org.opencontainers.image.description="WebSocket → passt network gateway for zephyr-in-the-browser guests"

CMD ["node", "server.mjs"]
