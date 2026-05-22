# Quickstart: F7.1a — Email Broadcast Advanced (Pagination + Image Embedding + Multi-Template)

**Branch**: `014-email-broadcast-advance` | **Date**: 2026-05-17 (Strategy B split + US7 promote-back on 2026-05-18)
**Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md) | **Research**: [research.md](./research.md) | **Data Model**: [data-model.md](./data-model.md)

This document gets a developer from `git clone` to running F7.1a locally with **3 user stories** (US1 pagination + US2 image embedding + US7 multi-template library) ship-ready behind 4 feature flags.

---

## 1. Prerequisites

Same as the main project (per root `README.md` and the F7 MVP `specs/010-email-broadcast/quickstart.md`):

- **Node.js 22 LTS** (`nvm install 22` recommended)
- **pnpm** (NOT npm — `pnpm-lock.yaml` is canonical)
- **PowerShell 7+** (for the Spec Kit scripts)
- **Git** (with `git worktree` support if you want to keep F7.1 + another branch checked out simultaneously per the project's parallel-worktree pattern)
- **Vercel CLI** (`npm i -g vercel`) — for `vercel env pull` to sync env vars

**F7.1-specific additions**:
- **ClamAV daemon** local install — needed for unit/integration/e2e testing of attachment upload + image scan flows. **Dev runs the same `clamd` daemon model as prod** (which deploys to a Fly.io persistent micro-VM running the official `clamav/clamav:stable` image, per `research.md § 1`). Pick the simplest path for your OS:
  - **Docker (RECOMMENDED — any OS, identical to prod image)**: `docker run -d --name clamav -p 3310:3310 clamav/clamav:stable`. Set `CLAMAV_HOST=localhost` + `CLAMAV_PORT=3310` in `.env.local`. Signature DB auto-refreshes via `freshclam` inside the container (24h default). First start downloads ~150 MB of signatures — give it 2-3 minutes before running tests.
  - **macOS native**: `brew install clamav` then `sudo freshclam` to download signatures, then `clamd` (or configure `clamav.service` via brew services). Verify with `nc localhost 3310` (clamd default port).
  - **Linux native**: `sudo apt install clamav clamav-daemon` (Debian/Ubuntu) or `sudo dnf install clamav clamav-update` (Fedora). Enable daemon: `sudo systemctl enable --now clamav-daemon`.
  - **Windows**: use the Docker option above — native Windows ClamAV setup is awkward and not worth the time.
- **Tiptap image extension** is part of the `@tiptap/extension-image@^3.22` npm package — installed via `pnpm install`

---

## 2. Initial setup (worktree-first, per project convention)

```bash
# From the main checkout directory
cd ~/Documents/Swedish\ chaplain_membership/

# Create the F7.1 worktree from origin/main (already done for this branch — skip if you cloned the worktree directly)
git worktree add -b 014-email-broadcast-advance ../chamber-os-014-broadcast-advance origin/main

# Switch into the worktree
cd ../chamber-os-014-broadcast-advance/

# Install dependencies (Node 22, pnpm)
pnpm install

# Sync env vars from Vercel
vercel env pull .env.local

# Add F7.1-specific env vars to .env.local (see § 3 below)
```

If you're on Windows + PowerShell:
```powershell
git worktree add -b 014-email-broadcast-advance ..\chamber-os-014-broadcast-advance origin/main
Set-Location ..\chamber-os-014-broadcast-advance
pnpm install
vercel env pull .env.local
```

---

## 3. Environment variables (F7.1-specific additions)

Add the following to `.env.local` (existing F1–F8 + F7 MVP env vars stay):

```bash
# ── F7.1a feature flags (3 USs only after Strategy B scope split) ──
# Master kill-switch (default OFF — F7.1a ships dark)
FEATURE_F71A_BROADCAST_ADVANCED=true

# Per-US flags (each defaults OFF; flip ON one at a time during ship)
FEATURE_F71A_US1_PAGINATION=true        # Lift recipient cap to 50k
FEATURE_F71A_US2_IMAGES=true            # Enable inline image embedding + ClamAV scan
FEATURE_F71A_US7_TEMPLATES=true         # Enable template library + member compose picker

# ── ClamAV configuration ────────────────────────────────────
CLAMAV_HOST=localhost          # In PROD: <flyapp>.internal or clamav-swecham.fly.dev
CLAMAV_PORT=3310               # default ClamAV daemon TCP port
CLAMAV_TIMEOUT_MS=300000       # 5-minute scan timeout per FR-027

# ── Cron-job.org secret (existing — F7.1a adds NO new cron endpoints; ClamAV signature refresh handled by freshclam in container) ──
# CRON_SECRET=... (existing F7 MVP secret — unchanged for F7.1a)

# ── PII detector ────────────────────────────────────────────
PII_DETECTOR_VERSION=v1.0  # forensic determinism per FR-062 — change requires spec amendment
```

---

## 4. Apply F7.1 database migrations

```bash
# Generate Drizzle migration SQL from schema changes (drizzle-kit reads from src/modules/*/infrastructure/schema.ts)
pnpm drizzle-kit generate

# Apply migrations to your DATABASE_URL (live Neon Singapore per project convention; integration tests run against same DB)
pnpm drizzle-kit migrate

# Verify migrations 0127-0138 are applied (F8 PR #24 occupied 0124-0126)
psql $DATABASE_URL -c "SELECT id, hash FROM drizzle.__drizzle_migrations ORDER BY id DESC LIMIT 15;"
```

**Critical post-migration integrity check** (per data-model.md § 9 migration ordering invariants):

```bash
# Verify the F3 contacts backfill ran correctly (migration 0135)
pnpm tsx scripts/verify-f71-contacts-backfill.ts
```

The script should report: every contact with `is_primary=true` has `receive_broadcasts=true`; every contact with `is_primary=false` has `receive_broadcasts=false`. If either fails, halt the deploy and investigate before proceeding (the backfill is a one-shot — re-running is safe but should not be needed).

---

## 5. Start the dev server

**IMPORTANT** (per `feedback_user_runs_dev_server` memory): the dev server runs on **port 3100**, NOT the default 3000. Next.js auto-reloads `.env.local` without restart, so you generally don't need to bounce the server when toggling feature flags during testing.

```bash
pnpm dev   # http://localhost:3100
```

If you're running another worktree's dev server on :3100, start F7.1 on a different port:

```bash
pnpm dev --port 3101
```

---

## 6. Verify ClamAV connectivity

The first time you run F7.1 with ClamAV enabled:

```bash
# Self-test the ClamAV adapter via a one-off script
pnpm verify:clamav

# Expected output: "ClamAV scan OK: { verdict: 'clean', signature: null, durationMs: 23 }" for a known-clean test file
# If you get connection refused: verify ClamAV daemon is running (clamd.service on Linux, clamav service on macOS via brew, Docker container on Windows)
```

**Note on signature refresh**: in PROD, ClamAV runs on a Fly.io persistent micro-VM where `freshclam` inside the container auto-refreshes signatures every 24h — there is NO Vercel cron endpoint for signature refresh. In DEV, your locally-installed `clamav-daemon` package similarly runs `freshclam` automatically (Linux systemd timer; macOS launchd via brew; the Docker `clamav/clamav` image does it in-container). To force a refresh manually:

```bash
# Linux / macOS (daemon mode)
sudo freshclam

# Docker
docker exec clamav freshclam
```

This is for local testing only — operators never need to trigger signature refresh in PROD.

---

## 7. Run the test suites

F7.1 tests follow the project's standard `pnpm` script conventions:

```bash
# Fast feedback (unit + contract — no DB; ~10-15s for F7.1 surface)
pnpm test

# With coverage (Domain 100% line, Application 80% line/branch, security-critical 100% branch)
pnpm test:coverage

# Integration tests against live Neon Singapore — 1-3 min for F7.1 surface
pnpm test:integration

# F7.1 only (filter)
pnpm test --filter broadcasts

# E2E with Playwright + axe-core
# IMPORTANT (per feedback_e2e_workers): use --workers=1 — default of 3 hangs the user's machine
pnpm test:e2e --workers=1

# E2E F7.1 subset
pnpm test:e2e --workers=1 --grep "F7.1|broadcasts/.*\.spec\.ts"

# i18n parity check (EN+TH+SV) — F7.1 adds ~250 keys
pnpm check:i18n

# Layout-container guard (existing project gate)
pnpm check:layout

# Full CI pipeline locally (reproduce before pushing)
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1
```

---

## 8. Manual walkthrough (per user story — F7.1a scope only)

After dev server is running with all 3 F7.1a feature flags ON, walk each US end-to-end to verify the surface works:

### US1 — Pagination >5k
1. As admin, seed a test tenant with 7,500 members (`pnpm tsx scripts/seed-test-tenant.ts --members 7500`)
2. As a member of that tenant, compose a broadcast targeting `all_members`
3. Submit + admin approve + dispatch
4. Watch dispatch in admin broadcast detail page — per-batch breakdown should show 1 batch of 7,500
5. Simulate per-batch failure: kill the dev server mid-dispatch, restart, observe `partially_sent` state + Retry button
6. Test concurrent admin retry race: open broadcast in 2 admin tabs, click Retry in both — only one should proceed, other returns `ALREADY_RETRYING_IN_PROGRESS`

### US2 — Image embedding
1. As admin, verify default image-source allowlist via `/admin/broadcasts/settings` — should show 2 entries (chamber asset domain + email-provider CDN)
2. As admin, add `example.com` to allowlist via the same page
3. As member, compose draft and paste `<img src="https://example.com/banner.png">` body
4. Verify submit succeeds + dispatched email contains the image
5. As member, try to paste `<img src="https://attacker.example.com/track.gif">` (not allowlisted) → verify submit rejected with `broadcast_body_image_source_unsafe`
6. As member, try to upload 6 MB image inline via compose toolbar → rejected with `broadcast_image_too_large`
7. As admin, verify ClamAV connectivity by triggering a scan: upload a known-clean PDF as a test image (or use EICAR test signature for the infected path)

### US7 — Templates
1. As admin, navigate to `/admin/broadcasts/templates` — verify **5 starter templates** appear pre-seeded (Monthly Newsletter, Event Invitation, Member Spotlight, Urgent Announcement, Sponsorship Thank-You) × EN+TH+SV = **15 total rows** marked with **"Starter" badge** (per critique P6)
2. Use filter pills to switch view: "Starter only" / "Admin-authored" / "All"
3. As admin, click Edit on a starter template — verify **confirmation banner** appears: "This is a starter template seeded by the platform. Editing creates a tenant-specific version..." (per critique P6)
4. As admin, edit the "Monthly Newsletter" template — change a sentence; save
5. As member, open compose — verify **shadcn Combobox** template picker (NOT bare `<select>`) opens with locale-cascading default (templates in user's locale first, per critique X3)
6. Pick "Monthly Newsletter" → verify draft body populates with the EDITED template content (admin's edits ARE applied at draft-start)
7. Verify `[bracketed text]` placeholders render with **distinct visual style** (grey background + dashed border per critique P4) + first-time-microcopy hint: "Click any [bracketed text] to replace with your content."
8. Verify `{{chamber_name}}` was **server-substituted** with tenant's display_name (HTML-escaped per contracts § 5)
9. As admin, edit the template AGAIN; as member with the open draft, verify the in-flight draft is NOT modified (snapshot semantics — FR-019)
10. **Stale draft test** (per critique E5): set draft created_at to >30 days ago; reload compose → verify "Template has been updated since you started this draft" banner appears with optional re-snapshot CTA
11. As admin, delete a starter template — verify the template-deletion audit row records `started_from_count` snapshot (FR-023) AND draft `template_name_snapshot` survives (per critique P9)
12. **XSS test** (per critique E6): set tenant display_name to `<script>alert(1)</script>`; pick a template containing `{{chamber_name}}` → verify draft body shows `&lt;script&gt;alert(1)&lt;/script&gt;` text, NOT executable script
13. Run migration 0134 a second time (manually re-trigger) — verify it SKIPS all 15 starters (no duplicates) and emits `broadcast_template_seed_skipped_existing_name` per starter

**Note**: US3 (per-contact opt-in), US4 (attachments), US5 (tracking), US6 (saved segments), and US8 (PII detector) are DEFERRED to F7.1b — see `f71b-backlog.md`. Their walkthrough steps are preserved there for future re-spec.

---

## 9. Infrastructure setup (pre-prod)

### 9.1 Fly.io ClamAV deployment

F7.1 introduces ONE new infrastructure piece — the ClamAV daemon on Fly.io. Pre-prod setup (one-time, ship-day operator runs):

```bash
# Install Fly CLI (https://fly.io/docs/hands-on/install-flyctl/)
brew install flyctl   # macOS
# or curl -L https://fly.io/install.sh | sh

fly auth login

# From the F7.1 worktree
cd infra/clamav
fly launch --copy-config --name clamav-swecham --region sin --no-deploy
fly secrets set CLAMAV_SHARED_SECRET="$(openssl rand -hex 32)"
fly deploy

# Verify
fly status -a clamav-swecham
fly logs -a clamav-swecham   # look for "clamd[1]: Listening daemon"

# Take the connection URL and add to Vercel env
fly info -a clamav-swecham   # copy the *.internal address (or *.fly.dev if using public)
vercel env add CLAMAV_HOST production
vercel env add CLAMAV_PORT production   # 3310 (clamd default)
vercel env add CLAMAV_SHARED_SECRET production
```

Future tenants on the same shared platform reuse the same Fly.io app (single ClamAV serving all tenants); only re-provision if scanner load exceeds the free-tier VM's capacity (~250 scans/day comfortable; ~1000/day stretch).

### 9.2 Cron-job.org coordinator

F7.1 adds ONE new cron-job.org coordinator (extending the existing 5 from F8 = 6 total):

| Endpoint | Cadence | Purpose |
|----------|---------|---------|
| `POST /api/cron/broadcasts/prune-engagement-events` | daily at 04:00 Asia/Bangkok | Purge engagement events >90d old |

Uses Bearer auth via `CRON_SECRET`. Configuration goes in cron-job.org dashboard per the project's `docs/runbooks/cron-jobs.md` pattern; ship-day operator (per ship checklist) adds the coordinator before flipping `FEATURE_F71_BROADCAST_ADVANCED=true`.

ClamAV signature refresh is **NOT** a cron-job.org endpoint — it runs as `freshclam` inside the Fly.io container on a 24h timer (default ClamAV behavior).

---

## 10. Common pitfalls (recorded for F7.1)

- **ClamAV daemon not running** — silent test failures or 500 errors on attachment upload. Verify with `pnpm verify:clamav` before running integration tests.
- **F3 contacts backfill skipped** — if you applied migration 0135 manually outside `drizzle-kit migrate`, the integrity check script will fail. Re-run `pnpm tsx scripts/verify-f71-contacts-backfill.ts` and remediate by running the backfill UPDATE manually.
- **F7 MVP master flag `FEATURE_F7_BROADCASTS=false`** blocks the entire broadcasts surface — F7.1 builds on top of F7 so both must be `true` for F7.1 to be reachable.
- **Tiptap image extension caching** — if `<img>` doesn't appear in toolbar after enabling `FEATURE_F71_US2_IMAGES=true`, hard-reload (Cmd+Shift+R) — Tiptap caches extension config at editor init.
- **Cross-tenant probe test failures** — usually mean RLS+FORCE didn't apply on a new table. Re-run migration 0136 + verify with `psql -c "SELECT tablename, rowsecurity FROM pg_tables WHERE tablename LIKE 'broadcast_%';"` — every F7.1 table should show `t` (true) for `rowsecurity`.
- **Resend Broadcasts API rate-limit during US1 testing** — if testing 50k pagination locally, your Resend account may hit rate limits. Mock the Resend client with MSW for the integration tests (existing F7 MVP pattern); reserve live Resend for end-to-end staging tests only.

---

## 11. Where to look next

- **`/speckit.tasks`** — generate `tasks.md` from this spec/plan/data-model/contracts bundle. Estimated ~250 tasks (per plan.md § Phase 2 hand-off).
- **F7 MVP retrospective** (`specs/010-email-broadcast/retrospective.md`) — lessons learned that shaped F7.1 scope choices
- **F8 retrospective** (`specs/011-renewal-reminders/retrospective.md`) — solo-maintainer substitute pattern + 13 review-round PR cycle
- **`docs/runbooks/`** — F7.1 will add 4 new runbooks (clamav-signature-stale, broadcast-partial-send-recovery, attachment-scan-backlog, pii-detector-false-positive-burst)
