# Native multi-arch Go bridge — no passt, no Node.
# Network uses embedded gvisor-tap-vsock (works on Linux/macOS/Windows hosts
# when run outside Docker; the image itself is Linux).

FROM golang:1.25-bookworm AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY . .
RUN CGO_ENABLED=0 go build -o /zephyr-bridge ./cmd/zephyr-bridge

FROM debian:bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /zephyr-bridge /usr/local/bin/zephyr-bridge
ENV PORT=8740 NO_TUI=1
EXPOSE 8740
USER nobody
ENTRYPOINT ["zephyr-bridge"]

LABEL org.opencontainers.image.source="https://github.com/kartben/zephyr-in-the-browser" \
      org.opencontainers.image.description="Desktop bridge: serial CTF + gvisor net + GDB for zephyr-in-the-browser"
