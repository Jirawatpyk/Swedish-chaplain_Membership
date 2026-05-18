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
RUN sed -i \
      -e 's/^#TCPSocket .*/TCPSocket 3310/' \
      -e 's/^#TCPAddr .*/TCPAddr 0.0.0.0/' \
      /etc/clamav/clamd.conf

EXPOSE 3310

# Liveness probe used by Fly.io tcp_checks (15s interval, 5s timeout
# per fly.toml). `clamdscan --ping 1` sends a PING command to clamd
# and exits 0 on PONG; non-zero exit triggers Fly.io machine restart.
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --retries=3 \
  CMD clamdscan --ping 1 || exit 1
