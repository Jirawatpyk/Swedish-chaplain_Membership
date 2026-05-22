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
# clamd MUST listen on BOTH IPv6 and IPv4 — two `TCPAddr` directives
# (clamd binds a listener for each). Why both:
#   - IPv6 (`::`): Fly.io's 6PN private network is IPv6-only —
#     `clamav-swecham.internal` resolves to an `fdaa:…` address, so
#     `fly proxy` + Vercel-function clients arrive over IPv6.
#   - IPv4 (`0.0.0.0`): Fly's deploy port-scan + `[[services]] tcp_checks`
#     health probe + the in-container `clamdscan --ping` HEALTHCHECK all
#     connect over IPv4 localhost. Fly explicitly warns "configure your
#     app to listen on 0.0.0.0:3310" if IPv4 is missing.
# The clamav/clamav:stable base image has `net.ipv6.bindv6only=1`, so a
# lone `TCPAddr ::` binds IPv6-ONLY — that passed the IPv6 proxy probe
# but tripped Fly's IPv4 health warning. An earlier `TCPAddr 0.0.0.0`
# (IPv4-only) had the mirror bug: Fly health green but every 6PN/IPv6
# client got ECONNRESET. Binding both is the only config that satisfies
# Fly health (IPv4) AND real 6PN clients (IPv6). (Root-caused 2026-05-22.)
RUN sed -i \
      -e 's/^#TCPSocket .*/TCPSocket 3310/' \
      -e 's/^#TCPAddr .*/TCPAddr ::\nTCPAddr 0.0.0.0/' \
      /etc/clamav/clamd.conf

EXPOSE 3310

# Liveness probe used by Fly.io tcp_checks (15s interval, 5s timeout
# per fly.toml). `clamdscan --ping 1` sends a PING command to clamd
# and exits 0 on PONG; non-zero exit triggers Fly.io machine restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD clamdscan --ping 1 || exit 1
