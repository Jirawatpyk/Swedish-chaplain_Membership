# F7.1a US2 — ClamAV virus scanner container.
#
# Deployed to Fly.io `sin` region as the `clamav-swecham` app. The
# clamav-virus-scanner adapter (src/modules/broadcasts/infrastructure/
# clamav-virus-scanner.ts, Phase 2 T025) talks to this container over
# the Fly 6PN private network on TCP/3310. See infra/clamav/README.md
# for deploy + monitor procedures and docs/runbooks/clamav-*.md for
# incident response.
#
# Why we extend the upstream image instead of authoring from scratch:
# the official `clamav/clamav:stable` ships with freshclam configured
# and clamd ready to launch — we only need to flip the TCP listener
# (off by default) and expose the port. Build is reproducible because
# we pin to `:stable` (Cisco-maintained rolling tag); freshclam pulls
# fresh signatures at container start regardless of image age.

FROM clamav/clamav:stable

# Enable clamd TCP listener (default config listens on the Unix socket
# only — Fly.io VMs talk over TCP, not shared volumes). Replace the
# commented `#TCPSocket` / `#TCPAddr` directives shipped in the base
# image's `/etc/clamav/clamd.conf` with active values.
#
# TCPAddr MUST be `::` (IPv6 any), NOT `0.0.0.0` (IPv4 any). Fly.io's
# 6PN private network is IPv6-only — `clamav-swecham.internal` resolves
# to an `fdaa:…` IPv6 address, so a Vercel function / `fly proxy`
# connection arrives over IPv6. An IPv4-only `0.0.0.0` listener accepts
# the local TCP health check (IPv4) but RESETS every 6PN/IPv6 client
# connection (ECONNRESET on the first command) — the daemon looks
# "healthy" (Fly tcp_check is a SYN handshake) yet no real client can
# scan. `::` on Linux with the default `net.ipv6.bindv6only=0` is
# dual-stack: it serves IPv6 6PN clients AND IPv4-mapped localhost,
# so the in-container `clamdscan --ping` health probe still works.
# (Root-caused 2026-05-22 — first deploy reset all proxy connections.)
RUN sed -i \
      -e 's/^#TCPSocket .*/TCPSocket 3310/' \
      -e 's/^#TCPAddr .*/TCPAddr ::/' \
      /etc/clamav/clamd.conf

EXPOSE 3310

# Liveness probe used by Fly.io tcp_checks (15s interval, 5s timeout
# per fly.toml). `clamdscan --ping 1` sends a PING command to clamd
# and exits 0 on PONG; non-zero exit triggers Fly.io machine restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD clamdscan --ping 1 || exit 1
