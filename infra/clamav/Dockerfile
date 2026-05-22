# F7.1a US2 — ClamAV virus scanner + HTTP scan-wrapper container.
#
# Deployed to Fly.io `sin` region as the `clamav-swecham` app. Two
# processes run in the container:
#   1. clamd — the ClamAV daemon, bound to LOCALHOST only (127.0.0.1:3310).
#   2. scan-server.mjs — a tiny pure-Node HTTP wrapper on :8080 that the
#      Fly edge exposes publicly over HTTPS. It bearer-authenticates
#      callers and forwards bytes to clamd via the INSTREAM protocol.
#
# Why the wrapper (Option D, 2026-05-22): Fly's 6PN private network is
# IPv6-only and a Vercel serverless function cannot join it, so the
# Chamber-OS app cannot reach clamd directly. The public HTTPS wrapper
# is the bridge; clamd stays localhost-only (never publicly exposed).
# See specs/014-email-broadcast-advance/clamav-vercel-connectivity.md
# and infra/clamav/README.md.
#
# We extend `clamav/clamav:stable` (Alpine-based, Cisco-maintained) so
# freshclam + clamd are preconfigured; we only flip the TCP listener to
# localhost, add a Node runtime (via apk), and layer the wrapper on top.

FROM clamav/clamav:stable

# Node runtime for the scan-wrapper (http + net + crypto only — no npm
# install needed). clamav/clamav:stable is ALPINE-based (busybox /bin/sh,
# `apk` package manager — NOT Debian/apt), so install Node via apk.
# Alpine's `nodejs` package satisfies the wrapper's requirements
# (timingSafeEqual, Buffer.subarray, AbortController, etc.).
RUN apk add --no-cache nodejs

# clamd listens on LOCALHOST ONLY now — the in-container wrapper is the
# sole client. No 6PN / public exposure (Option D moved the public
# surface to the HTTPS wrapper). This also sidesteps the IPv4/IPv6
# dual-bind dance that the 6PN-exposed config required (2026-05-22):
# 127.0.0.1 is unambiguous for a same-container client.
RUN sed -i \
      -e 's/^#TCPSocket .*/TCPSocket 3310/' \
      -e 's/^#TCPAddr .*/TCPAddr 127.0.0.1/' \
      /etc/clamav/clamd.conf

# The HTTP wrapper + its launcher.
COPY scan-server.mjs /opt/scan-server.mjs
COPY start.sh /opt/start.sh
RUN chmod +x /opt/start.sh

# Public-facing port is the wrapper, not clamd.
EXPOSE 8080

# In-container liveness = clamd PONG (the wrapper is useless without it).
# Fly's service-level health check hits the wrapper's GET /healthz over
# HTTP (see fly.toml [[services.http_checks]]).
HEALTHCHECK --interval=30s --timeout=5s --start-period=90s --retries=3 \
  CMD clamdscan --ping 1 || exit 1

# Launch the wrapper (background) + hand off to the upstream clamav
# entrypoint (freshclam + clamd) in the foreground. See start.sh.
ENTRYPOINT ["/opt/start.sh"]
