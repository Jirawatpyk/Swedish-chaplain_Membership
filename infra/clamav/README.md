# ClamAV virus scanner — Fly.io deployment

F7.1a US2 (`<img>` upload + sanitiser allowlist) depends on a clamd
daemon reachable from Chamber-OS Vercel functions. The daemon scans
inline-image bytes (FR-013) before they touch Vercel Blob storage and
returns one of four verdicts: `clean` | `infected` | `error` | `timeout`.

This directory holds the deployable artefacts:

| File | Purpose |
|---|---|
| `Dockerfile` | Extends `clamav/clamav:stable` with TCP listener on 3310 |
| `fly.toml` | Fly.io app config — `clamav-swecham` in `sin`, shared-cpu-1x@256mb |
| `README.md` | This file — deploy, monitor, rotate procedures |

## When this is deployed

**Phase 1 (now)**: files exist; container is NOT deployed. The F7.1a
master kill-switch (`FEATURE_F71A_BROADCAST_ADVANCED=false`) keeps US2
dark, so the `CLAMAV_HOST` env var stays empty.

**Phase 6 ship-day (T139)**: operator follows the **Deploy** section
below, then sets `CLAMAV_HOST` in Vercel env (T140) and flips US2 ON
(T145).

Until ship-day the dev workflow uses a Docker container locally — see
[**Local dev**](#local-dev) below.

## Prerequisites

- `flyctl` ≥ 0.3 installed (`brew install flyctl` or
  `iwr https://fly.io/install.ps1 -useb | iex` on PowerShell)
- `fly auth login` (account with deploy rights on the `chamber-os`
  organisation; see operator handbook)

## Deploy (one-time, Phase 6 T139)

```bash
# Run from the F14 worktree root:
cd infra/clamav

# 1. Persistent volume for the signature DB (avoids ~250 MB redownload
#    on every machine restart; see fly.toml [[mounts]]):
fly volumes create clamav_data --region sin --size 1 --yes

# 2. Create the app — --copy-config reads ./fly.toml verbatim:
fly launch --copy-config --name clamav-swecham --region sin

# 3. Verify:
fly status --app clamav-swecham   # expect: "running"
fly logs --app clamav-swecham     # expect: "clamd[1]: Listening daemon"

# 4. Smoke-test from the Chamber-OS app:
pnpm verify:clamav
# Expect: EICAR → infected; clean buffer → clean; p95 < 500 ms.
```

## Security boundary

The ClamAV daemon listens on TCP/3310 with **NO application-layer
authentication**. Security relies entirely on Fly.io's 6PN private
network — `clamav-swecham.internal` is reachable ONLY from the
chamber-os Vercel functions on the same private network. There is no
public IP and no DNS leak.

An earlier `CLAMAV_SHARED_SECRET` env var was removed 2026-05-19
because the `clamscan@2.4` Node binding does not support auth headers
and this Dockerfile has no reverse proxy that could check them — the
secret was documented but never reached the daemon. If a stronger
security posture is needed in F7.1b (e.g., zero-trust without network
segmentation), introduce a sidecar (Caddy/Nginx) that validates an
`X-Auth-Secret` header AND swap `clamscan` for an HTTP wrapper.

## Local dev

Skip Fly.io entirely — run clamd in Docker:

```bash
docker run -d --name clamav-dev -p 3310:3310 clamav/clamav:stable
# Wait ~60 s for freshclam to pull initial signatures, then:
docker logs clamav-dev | grep "Listening daemon"

# In .env.local:
CLAMAV_HOST="localhost"
CLAMAV_PORT="3310"
```

## Monitor

| What | How |
|---|---|
| Container logs | `fly logs --app clamav-swecham` |
| Live shell | `fly ssh console --app clamav-swecham` |
| Signature age | `fly ssh console --app clamav-swecham --command "freshclam --version"` |
| Force refresh | `fly ssh console --app clamav-swecham --command "freshclam --debug"` |
| Restart machine | `fly machine restart <id> --app clamav-swecham` |

Two Vercel alerts (Phase 6 T123) page on degradation:

- `clamav.signature_age_hours > 48` → see
  [`docs/runbooks/clamav-signature-stale.md`](../../docs/runbooks/clamav-signature-stale.md)
- `clamav_daemon_unreachable > 2 min` → see
  [`docs/runbooks/clamav-daemon-down.md`](../../docs/runbooks/clamav-daemon-down.md)

## No secret rotation needed

There is no shared secret in this deployment (see Security boundary
above). To rotate the network boundary itself (rare): redeploy the
Fly.io app from this directory, or migrate to a different private
network topology.

## References

- [`infra/clamav/Dockerfile`](./Dockerfile) — container build
- [`infra/clamav/fly.toml`](./fly.toml) — Fly.io app config
- [`scripts/verify-clamav-connectivity.ts`](../../scripts/verify-clamav-connectivity.ts) — self-test
- [`docs/runbooks/clamav-signature-stale.md`](../../docs/runbooks/clamav-signature-stale.md) — alert response (Phase 6 T124)
- [`docs/runbooks/clamav-daemon-down.md`](../../docs/runbooks/clamav-daemon-down.md) — alert response (Phase 6 T125)
- [`specs/014-email-broadcast-advance/plan.md`](../../specs/014-email-broadcast-advance/plan.md) § Constitution Check VII / Observability
