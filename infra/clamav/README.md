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
below, then sets `CLAMAV_HOST` + `CLAMAV_SHARED_SECRET` in Vercel env
(T140) and flips US2 ON (T145).

Until ship-day the dev workflow uses a Docker container locally — see
[**Local dev**](#local-dev) below.

## Prerequisites

- `flyctl` ≥ 0.3 installed (`brew install flyctl` or
  `iwr https://fly.io/install.ps1 -useb | iex` on PowerShell)
- `fly auth login` (account with deploy rights on the `chamber-os`
  organisation; see operator handbook)
- `openssl` for generating the shared secret

## Deploy (one-time, Phase 6 T139)

```bash
# Run from the F14 worktree root:
cd infra/clamav

# 1. Persistent volume for the signature DB (avoids ~250 MB redownload
#    on every machine restart; see fly.toml [[mounts]]):
fly volumes create clamav_data --region sin --size 1 --yes

# 2. Create the app — --copy-config reads ./fly.toml verbatim and
#    --no-deploy stops short of pushing an image so we can wire
#    secrets first:
fly launch --copy-config --name clamav-swecham --region sin --no-deploy

# 3. Wire the shared secret. NEVER commit this value; rotate per the
#    procedure below. Length MUST be ≥32 hex chars.
SECRET=$(openssl rand -hex 32)
fly secrets set CLAMAV_SHARED_SECRET="$SECRET" --app clamav-swecham
# Hand the SECRET value to the Vercel env step (T140) — it must
# match CLAMAV_SHARED_SECRET on the Chamber-OS deployment.

# 4. Deploy:
fly deploy --app clamav-swecham

# 5. Verify:
fly status --app clamav-swecham   # expect: "running"
fly logs --app clamav-swecham     # expect: "clamd[1]: Listening daemon"

# 6. Smoke-test from the Chamber-OS app:
pnpm tsx scripts/verify-clamav-connectivity.ts
# Expect: EICAR → infected; clean buffer → clean; p95 < 500 ms.
```

## Local dev

Skip Fly.io entirely — run clamd in Docker:

```bash
docker run -d --name clamav-dev -p 3310:3310 clamav/clamav:stable
# Wait ~60 s for freshclam to pull initial signatures, then:
docker logs clamav-dev | grep "Listening daemon"

# In .env.local:
CLAMAV_HOST="localhost"
CLAMAV_PORT="3310"
CLAMAV_SHARED_SECRET=""   # ignored in dev — adapter skips auth
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

## Rotate the shared secret

The shared secret lives in two places (Fly secret + Vercel env var)
and must rotate in both atomically. Order matters — set Vercel first
so the new app reads the new value before clamd starts rejecting old
auth headers.

```bash
NEW=$(openssl rand -hex 32)

# 1. Vercel env (run from Chamber-OS repo root):
vercel env rm CLAMAV_SHARED_SECRET production --yes
echo "$NEW" | vercel env add CLAMAV_SHARED_SECRET production
vercel deploy --prod    # picks up new env at boot

# 2. Fly secret:
fly secrets set CLAMAV_SHARED_SECRET="$NEW" --app clamav-swecham
# Fly auto-redeploys the machine; brief (~30 s) scan window where
# in-flight requests return `error` verdict — acceptable for routine
# rotation.

# 3. Smoke-test:
pnpm tsx scripts/verify-clamav-connectivity.ts
```

## References

- [`infra/clamav/Dockerfile`](./Dockerfile) — container build
- [`infra/clamav/fly.toml`](./fly.toml) — Fly.io app config
- [`scripts/verify-clamav-connectivity.ts`](../../scripts/verify-clamav-connectivity.ts) — self-test
- [`docs/runbooks/clamav-signature-stale.md`](../../docs/runbooks/clamav-signature-stale.md) — alert response (Phase 6 T124)
- [`docs/runbooks/clamav-daemon-down.md`](../../docs/runbooks/clamav-daemon-down.md) — alert response (Phase 6 T125)
- [`specs/014-email-broadcast-advance/plan.md`](../../specs/014-email-broadcast-advance/plan.md) § Constitution Check VII / Observability
