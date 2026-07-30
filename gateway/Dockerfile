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

FROM node:24-alpine

RUN apk add --no-cache passt

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
