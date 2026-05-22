#!/bin/sh
# F7.1a US2 — container launcher for the ClamAV + scan-wrapper image.
#
# Starts the pure-Node HTTP scan-wrapper in the background, then hands
# off to the upstream clamav/clamav:stable entrypoint (`/init`, which
# runs freshclam + clamd) as the FOREGROUND process so the container
# lifecycle + Fly health tracks clamd.
#
# Ordering note: the wrapper is started first but tolerates clamd not
# being ready yet — GET /healthz returns 503 and POST /scan returns a
# fail-closed `unreachable` verdict until clamd's localhost socket
# opens (~40-60s while the signature DB loads). No race to manage.
set -e

echo "[start.sh] launching scan-wrapper (node /opt/scan-server.mjs) in background"
node /opt/scan-server.mjs &

echo "[start.sh] handing off to upstream clamav entrypoint (/init)"
exec /init
