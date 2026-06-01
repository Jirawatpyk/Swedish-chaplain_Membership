# Runbook — Go-Live Operator Steps (SweCham / TSCC first launch)

**Audience**: operator (Jirawatpyk) with Vercel + Neon + cron-job.org + Fly.io access.
**Companion**: `docs/go-live-readiness.md` (master plan). This file = the exact
commands. Per-feature operational playbooks live in their own runbooks (linked).

> Run top-to-bottom on launch day. Each step has a verify line. **Do not flip a
> feature flag until that feature's gates pass.** Authoritative env schema:
> `src/lib/env.ts` (the app refuses to boot on a missing/invalid required var).

---

## 0. Pre-flight (before anything)

```bash
vercel link                       # link to the swecham project
vercel env pull .env.production.local --environment=production   # inspect current prod env
git checkout main && git pull && git log --oneline -1            # confirm F1–F9 merged
```
- [ ] Confirm `main` tip = the merged `015` (F1–F9). 
- [ ] Take a **Neon PITR snapshot / branch** as the rollback point.

---

## 1. Environment variables (production)

Most are reported already set ("ครบ"). Verify each is present; add any missing:
```bash
vercel env ls production
# add a missing one (interactive value prompt):
vercel env add <NAME> production
```
Required (boot-blocking — app refuses to start if any is missing): `DATABASE_URL` ·
`AUTH_COOKIE_SIGNING_SECRET` (≥32) · `APP_BASE_URL` (`https://swecham.zyncdata.app`) ·
`APP_ALLOWED_ORIGINS` (CSV CSRF allow-list) · `TENANT_SLUG` (`swecham`) ·
`TENANT_TIMEZONE` (default `Asia/Bangkok`) · `CRON_SECRET` (≥16) · `RESEND_API_KEY` ·
`RESEND_WEBHOOK_SIGNING_SECRET` · `BLOB_READ_WRITE_TOKEN` · `KV_REST_API_URL` ·
`KV_REST_API_TOKEN` · `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` (≥32, **required unconditionally**).

Feature-specific: **F5** `STRIPE_SECRET_KEY` `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`
(NEXT_PUBLIC_ prefix mandatory) `STRIPE_WEBHOOK_SECRET` `STRIPE_API_VERSION`
`STRIPE_ACCOUNT_ID_SWECHAM` `STRIPE_LIVE_MODE` (must agree with key mode) ·
**F6** `EVENTCREATE_PII_PSEUDONYM_SALT` (≥32) + `ZAPIER_DPA_EXECUTED=true` (both boot-assert when F6 on) ·
**F7** `RESEND_BROADCASTS_API_KEY` `RESEND_BROADCASTS_WEBHOOK_SECRET` (≥32)
`UNSUBSCRIBE_TOKEN_SECRET` (≥32, distinct) `BROADCASTS_FROM_EMAIL` ·
**F7.1a** (US2 images) `CLAMAV_SCAN_URL` `CLAMAV_SCAN_SECRET` (≥32) ·
**F9** `EXPORT_DOWNLOAD_TOKEN_SECRET` `BLOB_PRIVATE_READ_WRITE_TOKEN`.

> 🟡 **Stripe is still in TEST mode.** For a launch without live payments, leave
> F5 flag OFF (§ 4) and cut over to live keys later. For live payments, swap to
> live keys + register the live webhook before flipping F5 on.

- [ ] `vercel env ls production` shows every required var.

---

## 2. Data provisioning (order matters — see plan § 6b)

```bash
# 2.1 tenant row (see tenant-onboarding.md)
#     — confirm the SweCham tenant exists; create if not.

# 2.2 membership plans for 2026 (TENANT_SLUG=swecham is mandatory — script hard-refuses without it)
TENANT_SLUG=swecham node --env-file=.env.local --import tsx scripts/seed-swecham-2026-plans.ts

# 2.3 bootstrap first admin (safe to re-run; refuses if an admin exists)
BOOTSTRAP_ADMIN_EMAIL=jirawat.p@eqho.com pnpm tsx scripts/seed-bootstrap-admin.ts
```
- [ ] Verify tenant + 9 plans (6 corporate + 3 partnership) present (Claude action **A1** can confirm read-only).
- [ ] **PITR snapshot taken** (rollback point) BEFORE member import.
- [ ] Member import → see `docs/member-import-spec.md` (dry-run, then `--commit`).

---

## 3. External cron (cron-job.org) — full catalogue in `cron-jobs.md`

For every job: **Bearer `CRON_SECRET`**, **retry OFF** (per `cron-jobs.md`).
Launch-critical 5-min jobs (Hobby plan can't do these natively):
- [ ] **F9** `POST /api/cron/insights/snapshot-refresh-coordinator` `*/5` **+** `POST /api/cron/insights/process-export-jobs` `*/5` ← **T101** (both POST — route exports POST only; GET → 405)
- [ ] **F7** `dispatch-scheduled` `*/5` · `reconcile-stuck-sending` `*/15` · `dispatch-batches` `*/5` · `split-large-broadcasts` `*/5` · `broadcasts-gauges` `*/5` · `prune-expired-drafts` `30 4 * * *`
- [ ] **F5** `stale-pending-count` `*/5`
- [ ] **F8** all 7: `dispatch-coordinator` · `at-risk-recompute-coordinator` · `tier-upgrade-evaluate-coordinator` · `reconcile-pending-reactivations-coordinator` · `lapse-cycles-on-grace-expiry-coordinator` · `prune-consumed-tokens` · `reconcile-pending-applications`
- [ ] **F6** 4 jobs: idempotency sweep · PII pseudonymisation sweep (compliance-critical) · error-CSV blob TTL sweep · match-rate gauge (hourly)
- [ ] Native `vercel.json` daily jobs deployed (outbox purge, receipt-pdf reconcile, stale-refund sweep)
> All endpoints **POST** unless `cron-jobs.md` states otherwise.

Verify: trigger one manually with the Bearer token → expect `2xx`.

---

## 4. ClamAV (F7.1a US2 image scanning) — Option D HTTP wrapper

Production uses the **Option D HTTPS scan-wrapper** (Vercel can't reach Fly 6PN);
`CLAMAV_HOST`/`CLAMAV_PORT` are legacy dev-only.
- [ ] Fly.io HTTPS scan-wrapper healthy + responding at its public URL (`clamav-daemon-down.md`)
- [ ] `CLAMAV_SCAN_URL` + `CLAMAV_SCAN_SECRET` (≥32) set in env (§ 1)
- [ ] Signature freshness OK (`clamav-signature-stale.md`)

---

## 5. Feature-flag flip sequence (only after each feature's gates pass)

```bash
vercel env add FEATURE_F3_MEMBERS production            # true
# … repeat per flag, then redeploy
```
Order: `FEATURE_F3_MEMBERS` → `FEATURE_F4_INVOICING` →
`FEATURE_F5_ONLINE_PAYMENT` (⚠️ only if Stripe LIVE + `STRIPE_LIVE_MODE=true`) →
`FEATURE_F6_EVENTCREATE` (⚠️ set `EVENTCREATE_PII_PSEUDONYM_SALT` + `ZAPIER_DPA_EXECUTED=true` FIRST or boot fails)
→ `FEATURE_F7_BROADCASTS` → `FEATURE_F71A_BROADCAST_ADVANCED` →
`FEATURE_F8_RENEWALS` → `FEATURE_F9_DASHBOARD`.
- [ ] **F7.1a sub-flags** (staged, after master): `FEATURE_F71A_US7_TEMPLATES` → `FEATURE_F71A_US2_IMAGES` (needs ClamAV § 4) → `FEATURE_F71A_US1_PAGINATION`.
- [ ] Redeploy after flag changes; confirm app boots.

---

## 6. Smoke test (production)

- [ ] Bootstrap admin signs in at `/admin/sign-in`
- [ ] Admin sees members (post-import), plans, dashboard (F9)
- [ ] Invite one real member → member signs in at `/portal/sign-in`
- [ ] Generate one invoice PDF; (if F5 live) one test payment
- [ ] Monitoring live: traces + Vercel Analytics + cron gauges emitting

---

## 7. Safety net (rehearse before declaring go-live)

```bash
# emergency write-freeze (reversible in ~30s, no code deploy)
vercel env add READ_ONLY_MODE production    # true  → redeploy
# rollback to a previous deployment
vercel promote <previous-deployment-url>
```
- [ ] Read-only mode toggles + reverts cleanly
- [ ] Rollback rehearsed

---

## 8. Go / No-Go

Cross-check every box in `go-live-readiness.md § 7`. Ship only when ALL pass +
the UAT owner has signed off.
