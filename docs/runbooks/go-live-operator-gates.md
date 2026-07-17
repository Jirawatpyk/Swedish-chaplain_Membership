# Go-Live Operator Gates — Executable Runbook (SweCham / TSCC)

**Audience**: the operator who provisions production (not Claude — Claude produced this; you run it).
**Scope**: Stage 4 of `docs/go-live-readiness.md`. Turns the § 6 checklist into top-to-bottom
**runnable** steps. Authoritative sources cross-checked into this file: `src/lib/env.ts`
(boot-time zod schema) + `docs/runbooks/cron-jobs.md` (cron catalogue), verified 2026-06-03.
**Deploy target**: Vercel `sin1` + Neon `ap-southeast-1`, domain `swecham.zyncdata.app`.

> **Golden rule**: the app **refuses to boot** if any unconditionally-required env var is
> missing/malformed (it throws from `src/lib/env.ts` at startup and Vercel marks the deploy
> failed). So § 2 must be 100% complete **before** the first production deploy succeeds — a
> half-set env list does not "mostly work", it fails closed. Run § 2 → deploy → § 3 verify
> boot, in that order.

---

## 0. At-a-glance gate checklist

Tick each as you complete its section. Order matters top-to-bottom.

- [ ] **§1** Tooling + access ready (Vercel CLI linked, Neon access, cron-job.org + Resend + Stripe + Fly accounts)
- [ ] **§2** All production env vars set (incl. the boot-required Stripe/F7/renewal block — see ⚠️ in §2.2)
- [ ] **§3** Production deploy boots green (env validation passed)
- [ ] **§4** Data prerequisites seeded (tenant row → 2026 plans → bootstrap admin → **PITR snapshot**)
- [ ] **§5** Crons registered (cron-job.org externals + native `vercel.json` present)
- [ ] **§6** ClamAV Fly.io scan-wrapper up **(only if enabling F7.1a image upload)**
- [ ] **§7** Feature flags flipped in the staged order, each only after its gates pass
- [ ] **§8** Safety net rehearsed (READ_ONLY_MODE, rollback, PITR restore path)
- [ ] **§9** Member data imported; row counts reconciled; 5-member spot-check
- [ ] **§10** Post-flip smoke verification green
- [ ] **§11** Open operator/legal decisions resolved or consciously deferred (Stripe live, privacy policy)

---

## 1. Preconditions — tooling + access

```bash
# Vercel CLI (the dev workstation does not have it per session note — install once):
npm i -g vercel
vercel login
vercel link            # link this repo to the swecham project/team
vercel env pull .env.production.local --environment=production   # inspect current prod env (do NOT commit)
```

Accounts / credentials you will need (1Password vault paths in parentheses where known):
- **Vercel** — project admin on the SweCham team (env vars + Blob stores + deploys + rollback)
- **Neon** — `ap-southeast-1` project owner (PITR snapshot + connection strings)
- **cron-job.org** — SweCham ops account (`swecham/cron-job-org`) for the 5-minute crons
- **Resend** — two API surfaces: transactional + Broadcasts; sender domain verified
- **Stripe** — SweCham connected account (test keys minimum; live keys for §11 cutover)
- **Fly.io** — only if enabling F7.1a image upload (ClamAV scan-wrapper) — see §6
- **Upstash / Vercel KV** — rate-limit store (Marketplace integration)

> All secrets live in **Vercel env only** — never commit them. `.env.production.local` and
> `.env.local` are gitignored; treat any pulled file as sensitive and delete after use.

---

## 2. Production environment variables

### 2.1 Generate the secrets first

Every `≥32`-byte secret below MUST be **independently generated** (distinct values — they are
deliberately kept separate so rotating one never invalidates another surface's tokens):

```bash
# Run each line; paste the output into the matching `vercel env add` in §2.2.
openssl rand -base64 48   # AUTH_COOKIE_SIGNING_SECRET            (≥32)
openssl rand -base64 48   # CRON_SECRET                           (≥16; 48 is fine)
openssl rand -base64 48   # UNSUBSCRIBE_TOKEN_SECRET              (≥32, distinct from auth)
openssl rand -base64 48   # RENEWAL_LINK_TOKEN_SECRET_PRIMARY     (≥32, distinct)
openssl rand -base64 48   # RESEND_BROADCASTS_WEBHOOK_SECRET      (≥32) — or use the value Resend gives you
openssl rand -base64 48   # EXPORT_DOWNLOAD_TOKEN_SECRET          (≥32, F9 — distinct)
openssl rand -base64 32   # EVENTCREATE_PII_PSEUDONYM_SALT        (≥32, F6 only — NEVER rotate once live)
openssl rand -base64 48   # CLAMAV_SCAN_SECRET                    (≥32, F7.1a US2 — must equal Fly app secret)
```

PowerShell equivalent (if you are not in git-bash/WSL):

```powershell
[Convert]::ToBase64String((1..48 | ForEach-Object { Get-Random -Max 256 }))
```

`vercel env add <NAME> production` reads the value from stdin (pipe or paste). Example:

```bash
echo -n "<paste-generated-value>" | vercel env add AUTH_COOKIE_SIGNING_SECRET production
```

### 2.2 The variables (grouped by when they are required)

> **Authoritative list = `src/lib/env.ts`.** The app validates with zod at boot. Anything in
> **2.2.A is required UNCONDITIONALLY** — boot fails without it, *even when the related feature
> flag is off*. This corrects a mislabel in `go-live-readiness.md` §6.1: the Stripe block, the
> F7 Broadcasts block, and `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` are **not** "set before flipping
> on" — they are **boot-required now**. To launch members+invoicing with F5/F7/F8 dark you still
> must set valid **test-mode** Stripe keys + the F7 secrets + the renewal primary secret.

#### 2.2.A — Unconditionally required (app will not boot without ALL of these)

| Var | Constraint / format | Notes |
|-----|--------------------|-------|
| `DATABASE_URL` | valid URL | Neon `ap-southeast-1` **pooled** connection string |
| `AUTH_COOKIE_SIGNING_SECRET` | ≥32 chars | session cookie HMAC |
| `APP_BASE_URL` | valid URL | `https://swecham.zyncdata.app` |
| `APP_ALLOWED_ORIGINS` | CSV, ≥1 entry | CSRF Origin allow-list, e.g. `https://swecham.zyncdata.app` |
| `TENANT_SLUG` | `^[a-z0-9-]{1,63}$` | `swecham` |
| `CRON_SECRET` | ≥16 chars | shared Bearer for **all** cron endpoints |
| `RESEND_API_KEY` | starts `re_` | transactional email |
| `RESEND_WEBHOOK_SIGNING_SECRET` | ≥10 chars | transactional webhook |
| `BLOB_READ_WRITE_TOKEN` | ≥10 chars | **public** Blob store (F4 PDFs + F9 logos + F7.1a broadcast images) — **region `sin1`, see §6b** |
| **Upstash pair** | both ≥20 chars | `KV_REST_API_URL`+`KV_REST_API_TOKEN` **OR** `UPSTASH_REDIS_REST_URL`+`UPSTASH_REDIS_REST_TOKEN` (boot throws if neither pair present) |
| `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` | ≥32 chars | **required even with F8 dark** |
| `STRIPE_SECRET_KEY` | `sk_test_`\|`sk_live_` | **required even with F5 dark** — use `sk_test_` until §11 |
| `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` | `pk_test_`\|`pk_live_` | `NEXT_PUBLIC_` prefix mandatory (client bundle) |
| `STRIPE_WEBHOOK_SECRET` | starts `whsec_` | |
| `STRIPE_API_VERSION` | ≥8 chars | pinned, e.g. `2025-09-30.clover` (matches `.env.example`) |
| `STRIPE_ACCOUNT_ID_SWECHAM` | ≥10 chars | connected-account id (stable test↔live) |
| `RESEND_BROADCASTS_API_KEY` | starts `re_` | **required even with F7 dark** (may equal `RESEND_API_KEY`) |
| `RESEND_BROADCASTS_WEBHOOK_SECRET` | ≥32 chars | distinct Resend Broadcasts webhook secret |
| `BROADCASTS_FROM_EMAIL` | `local@domain` or `Name <local@domain>` | must be a Resend-verified domain; **no** `.test/.example/.invalid/.localhost` TLDs |
| `UNSUBSCRIBE_TOKEN_SECRET` | ≥32 chars | distinct from auth secret |

> **Boot cross-checks that bite here** (`src/lib/env.ts` throws):
> - `STRIPE_LIVE_MODE` must **agree** with the key prefix: `sk_test_` ↔ `STRIPE_LIVE_MODE=false`
>   (default), `sk_live_` ↔ `=true`. And `=true` is allowed **only** when `NODE_ENV=production`.
>   → For a test-mode prod launch: set `sk_test_`/`pk_test_` keys and leave `STRIPE_LIVE_MODE` unset (=false).
> - Upstash: set exactly one pair; setting neither throws.

#### 2.2.B — Required only before flipping that feature ON

| Feature | Vars | Gate |
|---------|------|------|
| **F6 EventCreate** | `EVENTCREATE_PII_PSEUDONYM_SALT` (≥32) **+** `ZAPIER_DPA_EXECUTED=true` | Boot **throws** if `FEATURE_F6_EVENTCREATE=true` without the salt; and in production without `ZAPIER_DPA_EXECUTED=true` (PDPA §28 / GDPR Art.28 legal gate). **Never rotate the salt** once live. |
| **F9 Dashboard** | `EXPORT_DOWNLOAD_TOKEN_SECRET` (≥32) **+** `BLOB_PRIVATE_READ_WRITE_TOKEN` | Boot **throws** if `FEATURE_F9_DASHBOARD=true` without the token secret. Private Blob store is a separate provisioning step — see §6b. |
| **F7.1a US2 images** | `CLAMAV_SCAN_URL` (HTTPS) **+** `CLAMAV_SCAN_SECRET` (≥32) | Option D HTTP wrapper (§6). NOT the legacy `CLAMAV_HOST`/`CLAMAV_PORT` (dev-only). Empty `CLAMAV_SCAN_URL` ⇒ scanner returns `error` verdict ⇒ image upload disabled. |

#### 2.2.C — Optional (have safe defaults; set only if you need to override)

`TENANT_TIMEZONE` (default `Asia/Bangkok` — set explicitly for clarity) · `RESEND_FROM_EMAIL` ·
`DATABASE_URL_UNPOOLED` / `POSTGRES_URL_NON_POOLING` (migrations) · `DATABASE_POOL_MAX` ·
`LOG_LEVEL` (default `info`) · `RENEWAL_LINK_TOKEN_SECRET_FALLBACK` (only during a 30-day rotation
window) · `TENANT_PRIVACY_POLICY_URL` / `TENANT_WEBSITE_URL` (member-facing links; see §11) ·
`STRIPE_LIVE_MODE` (default false) · `FEATURE_F5_ASYNC_RECEIPT_PDF` / `FEATURE_F4_VOID_ATTACHMENT`
(default false) · `READ_ONLY_MODE` (default false; emergency write-freeze — §8).

> **Must NOT be set in production** (boot throws): `DEBUG_RLS_STATE=true`,
> `E2E_X_TENANT_HEADER_ENABLED=true`. Leave both unset.

#### 2.2.D — Feature-flag defaults (so you know the starting state)

`FEATURE_F3_MEMBERS` and `FEATURE_F4_INVOICING` **default TRUE**. Everything else
(`FEATURE_F5_ONLINE_PAYMENT`, `FEATURE_F6_EVENTCREATE`, `FEATURE_F7_BROADCASTS`,
`FEATURE_F71A_BROADCAST_ADVANCED` + its three US sub-flags, `FEATURE_F8_RENEWALS`,
`FEATURE_F9_DASHBOARD`) **defaults FALSE** (ships dark). §7 is the flip plan.

---

## 3. Verify the production boot

```bash
vercel deploy --prod                       # or push to the production branch
# Watch the build/deploy. If env validation fails you'll see a thrown error from
# src/lib/env.ts listing EVERY bad key at once. Fix them all, redeploy.
vercel logs <deployment-url>               # confirm clean boot, no env throw
```

Open `https://swecham.zyncdata.app` → the app should load (F3 members + F4 invoicing live by
default; everything else dark). If the deploy is marked **Error** with an env message, you are
missing a 2.2.A var — go back, do not proceed.

---

## 4. Data prerequisites (run in this EXACT order)

Members reference plan tiers + tenant_id, so 1→2 must precede the import (§9). Per `go-live-readiness` §6b:

> **These scripts run on YOUR machine against production Neon.** They read `DATABASE_URL`
> (point it at **prod** Neon) and `TENANT_SLUG` (must be `swecham` — the scripts refuse any other
> slug). Put both in a local gitignored `.env.local`/`.env.production.local`, or inline them as
> shown below. Never commit that file.

1. **SweCham tenant row** exists — see `docs/runbooks/tenant-onboarding.md`.
2. **2026 membership plans** seeded:
   ```bash
   TENANT_SLUG=swecham DATABASE_URL="<prod-neon-url>" pnpm tsx scripts/seed-swecham-2026-plans.ts
   ```
3. **Bootstrap admin** (idempotent — refuses if any admin already exists):
   ```bash
   TENANT_SLUG=swecham DATABASE_URL="<prod-neon-url>" \
     BOOTSTRAP_ADMIN_EMAIL=first.admin@swecham.example pnpm tsx scripts/seed-bootstrap-admin.ts
   ```
4. **Clear any test data** left in the DB (this is the first real launch — no prod users to preserve).
5. **Take a Neon PITR snapshot / branch** — your rollback point *before* the bulk member write.

> Do not run §9 (member import) until 1–5 are done and the PITR snapshot is confirmed.

---

## 5. Register cron jobs

`CRON_SECRET` (Bearer) on **every** job; **retry/failure-retry OFF** on every job (the cadence is
the natural retry; cron-job.org's retry storm would hammer endpoints during an outage). Full
per-job operational detail + response-code tables live in `docs/runbooks/cron-jobs.md`.

### 5.1 Cron jobs — native Vercel Cron since 2026-07-17 (Pro plan)

> **⚡ Updated 2026-07-17:** these now run on **native Vercel Cron**
> (`vercel.json`), registered automatically on the production deploy.
> Vercel auto-injects the `CRON_SECRET` Bearer and triggers every path via
> **GET** (POST-only handlers gained `export const GET = POST`).
> cron-job.org is a paused standby. The **Method** column below is each
> handler's native verb (all also accept GET now); the exact UTC
> `vercel.json` schedules are in `cron-jobs.md`.

Header on all: `Authorization: Bearer <CRON_SECRET>`. URL prefix `https://swecham.zyncdata.app`.
Cadence below is the *logical* schedule (UTC unless noted ICT = Asia/Bangkok):

| Feature | Endpoint | Method | Cadence | Register when |
|---------|----------|--------|---------|---------------|
| F5 | `/api/internal/metrics/stale-pending-count` | GET | `*/5 * * * *` | always (F5 metric) |
| F7 | `/api/cron/broadcasts/dispatch-scheduled` | POST | `*/5 * * * *` | before F7 flip |
| F7 | `/api/cron/broadcasts/reconcile-stuck-sending` | POST | `*/15 * * * *` | before F7 flip |
| F7 | `/api/cron/broadcasts/prune-expired-drafts` | POST | `30 4 * * *` (UTC) | before F7 flip |
| F7 | `/api/internal/metrics/broadcasts-gauges` | GET | `*/5 * * * *` | before F7 flip |
| F7.1a | `/api/cron/broadcasts/split-large-broadcasts` | POST | `*/5 * * * *` | before F7.1a US1 flip (503 until then = OK) |
| F7.1a | `/api/cron/broadcasts/dispatch-batches` | POST | `*/5 * * * *` | before F7.1a US1 flip (503 until then = OK) |
| F8 | `/api/cron/renewals/dispatch-coordinator` | POST | `0 6 * * *` (ICT) | before F8 flip |
| F8 | `/api/cron/renewals/at-risk-recompute-coordinator` | POST | `0 2 * * 0` (Sun ICT) | before F8 flip |
| F8 | `/api/cron/renewals/tier-upgrade-evaluate-coordinator` | POST | `0 3 * * 0` (Sun ICT) | before F8 flip |
| F8 | `/api/cron/renewals/reconcile-pending-reactivations-coordinator` | POST | `0 7 * * *` (ICT) | before F8 flip |
| F8 | `/api/cron/renewals/lapse-cycles-on-grace-expiry-coordinator` | POST | `30 6 * * *` (ICT) | before F8 flip |
| F8 | `/api/cron/renewals/prune-consumed-tokens` | POST | `0 4 * * 6` (Sat ICT) | before F8 flip |
| F8 | `/api/cron/renewals/reconcile-pending-applications` | POST | `0 5 * * 6` (Sat ICT) | before F8 flip |
| F6 | `/api/internal/retention/sweep-eventcreate-idempotency` | POST | `30 3 * * *` (ICT) | before F6 flip |
| F6 | `/api/internal/retention/pseudonymise-eventcreate` | POST | `0 4 * * *` (ICT) | before F6 flip **(compliance-critical)** |
| F6.1 | `/api/internal/retention/sweep-error-csv-blobs` | GET | `0 22 * * *` (UTC = 05:00 ICT) | before F6 flip |
| F6 | `/api/internal/observability/recompute-match-rate` | POST | `0 * * * *` (hourly) | before F6 flip |
| F9 | `/api/cron/insights/snapshot-refresh-coordinator` | POST | `*/5 * * * *` | before F9 flip |
| F9 | `/api/cron/insights/process-export-jobs` | POST | `*/5 * * * *` | before F9 flip **(T101)** |

For each: create the job, set method + schedule + Bearer header, **disable failure-retry**, enable
email-on-failure, set timeout 30–60 s, then **Run once** and confirm the expected JSON (a `503`
while the feature is still dark is **correct**, not an incident).

### 5.2 Native `vercel.json` daily crons (already in repo — just confirm present)

| Endpoint | Method | Cadence |
|----------|--------|---------|
| `/api/cron/sweep-stale-pending-refunds` | POST | `0 3 * * *` |
| `/api/cron/outbox-purge` | POST | `15 20 * * *` |
| `/api/internal/cron/receipt-pdf-reconcile` | POST | `30 3 * * *` |

These pick up `CRON_SECRET` automatically via Vercel's injected `Authorization` header — no UI action.

---

## 6. ClamAV Fly.io scan-wrapper — **only if enabling F7.1a image upload (US2)**

Skip this section entirely if you are not turning on `FEATURE_F71A_US2_IMAGES`.

Vercel functions cannot join Fly's IPv6-only 6PN, so production uses the **Option D HTTPS
scan-wrapper** in front of `clamd`. See `infra/clamav/README.md` +
`docs/runbooks/clamav-daemon-down.md` for the deploy procedure.

- [ ] Fly.io app deployed; HTTPS scan-wrapper responding at its public URL (e.g. `https://clamav-swecham.fly.dev/scan`)
- [ ] Fly app secret `CLAMAV_SCAN_SECRET` set; **same value** placed in Vercel env (§2.2.B)
- [ ] `CLAMAV_SCAN_URL` set in Vercel to the full `/scan` endpoint
- [ ] Signature freshness OK (`docs/runbooks/clamav-signature-stale.md`)
- [ ] Smoke: POST a known-EICAR test string → expect an `unsafe` verdict

### 6b. F9 private Blob store (do before flipping `FEATURE_F9_DASHBOARD` on)

F9 exports use `put({ access:'private' })`; a Blob store is public XOR private. The existing
`BLOB_READ_WRITE_TOKEN` store is **public** (F4 PDFs + F9 logos) — private puts on it are rejected.

> ⚠️ **Region — pick Singapore (`sin1`) at creation for EVERY Blob store (public + private).**
> The region is chosen at store-creation and is **immutable**; the Vercel default is **US
> (`iad1`)**. A store left on the default keeps production Blob data (invoice/receipt PDFs =
> PII + Thai tax docs) in the US, contradicting `docs/compliance/processing-records.md` (which
> records Blob as `sin1` Singapore). `sin1` requires the **Pro** plan. You cannot move a
> store's region afterwards — you must create a new `sin1` store, copy the DB-referenced blobs
> (`scripts/blob-migration/`), swap the token, and redeploy.
> **2026-07 incident:** the public store was created on the US default; migrating it by bulk-
> reading the *whole* store from a laptop triggered a Vercel Blob **store suspension** → a prod
> outage (invoice downloads 403). Copy only the **~161 DB-referenced keys** (see
> `scripts/blob-migration/audit-all-prod-blobs.mjs`), never the whole store.

1. Vercel dashboard → Storage → **Create** Blob store, **region Singapore (`sin1`)**, access **Private** (or `vercel blob create-store <name> --access private`).
2. Put its token in `BLOB_PRIVATE_READ_WRITE_TOKEN` (Production + Preview). Leave `BLOB_READ_WRITE_TOKEN` on the public store.
3. Confirm `EXPORT_DOWNLOAD_TOKEN_SECRET` set (§2.2.B).
4. Smoke after the F9 flip: generate a directory JSON on `/admin/directory` → wait a `process-export-jobs` tick → download via the link.

---

## 7. Feature-flag flip sequence

Flip each ON only after its env (§2.2.B), crons (§5), and any infra (§6) gates pass. Set with
`vercel env add FEATURE_X true production` then **redeploy** (flags load at boot).

**Already TRUE by default** (no action): `FEATURE_F3_MEMBERS`, `FEATURE_F4_INVOICING`.

Recommended launch order (lowest risk → highest; skip any feature you are deferring):

1. `FEATURE_F9_DASHBOARD` — needs §6b private store + `EXPORT_DOWNLOAD_TOKEN_SECRET` + F9 crons (§5).
2. `FEATURE_F8_RENEWALS` — needs all 7 F8 crons (§5) + `tenant_renewal_settings` row for SweCham.
3. `FEATURE_F7_BROADCASTS` — needs F7 crons (§5) + verified Broadcasts sender domain.
4. `FEATURE_F71A_BROADCAST_ADVANCED` (master), then the **staged sub-flags in this order**:
   `FEATURE_F71A_US7_TEMPLATES` → `FEATURE_F71A_US2_IMAGES` (**needs ClamAV §6**) → `FEATURE_F71A_US1_PAGINATION` (needs the two split/dispatch-batches crons).
5. `FEATURE_F6_EVENTCREATE` — **boot fails** unless `EVENTCREATE_PII_PSEUDONYM_SALT` set **and**, in prod, `ZAPIER_DPA_EXECUTED=true`. Plus F6 crons (§5).
6. `FEATURE_F5_ONLINE_PAYMENT` — ⚠️ **only after the Stripe LIVE cutover** (§11). Leaving F5 dark is a valid launch-minimal choice.

> After each flip + redeploy, **Run** that feature's cron jobs once in cron-job.org — they should
> now return `200` instead of the dark-launch `503`.

---

## 8. Safety-net rehearsal (do BEFORE real data import)

- [ ] **Write-freeze**: set `READ_ONLY_MODE=true` + redeploy → state-changing `/api/**` return 503
      `read-only-mode` while sign-in + reads stay alive. Revert (unset/false + redeploy). ~30 s, no code deploy.
- [ ] **Rollback**: confirm `vercel promote <previous-good-deployment-url>` restores the prior build.
- [ ] **Neon PITR**: confirm you can restore/branch to the §4 snapshot timestamp.

---

## 9. Member data import (Stage 3 tool)

Runs on the **operator's machine** against the gitignored Excel workbook (PII — never committed,
never logged). Prereqs §4 (1–5) must be done. The importer threads `tx` via `runInTenant` (RLS-safe),
is all-or-nothing (a mid-batch failure rolls back), and writes a **PII-free** report.

> Same env as §4: `TENANT_SLUG=swecham` + `DATABASE_URL` (prod Neon) must be present (via
> `.env.local` or inline). The importer refuses any slug other than `swecham`.

```bash
# 1) DRY-RUN first — validates + dedupes + previews; writes NOTHING.
TENANT_SLUG=swecham DATABASE_URL="<prod-neon-url>" \
  pnpm tsx scripts/import-members.ts --file "<path-to-workbook>.xlsx" --plan-year 2026

# Review the dry-run report: error count must be 0 (or every error explained);
# tier histogram + member/contact counts must match your expectation.

# 2) COMMIT — only after a clean dry-run.
TENANT_SLUG=swecham DATABASE_URL="<prod-neon-url>" \
  pnpm tsx scripts/import-members.ts --file "<path-to-workbook>.xlsx" --plan-year 2026 --commit
```

Reconcile after commit:
- [ ] `membersCreated` + `contactsCreated` match the source row counts (minus any flagged skips).
- [ ] Investigate any `partial-overlap rows` / `primary-collision rows` listed in the report (resolve by hand).
- [ ] Spot-check **5 members** in the admin UI (`/admin/members`) — company, tier, primary contact correct.
- [ ] One real member invited → can sign in to `/portal`.

---

## 10. Post-flip smoke verification

- [ ] Bootstrap admin signs in at `/admin`; manager + member roles behave per RBAC.
- [ ] Each flipped feature's surface loads (dashboard, renewals page, broadcasts composer, etc.).
- [ ] Each feature's cron returns `200` (not `503`) and increments its gauge/metric within ~5 min.
- [ ] Golden-path E2E green on the Vercel preview/staging across platforms (`--workers=1`) — Stage 5 go/no-go.
- [ ] `@a11y` + `@i18n` E2E green; `RUN_PERF=1` perf gates within SLO (`docs/observability.md`).
- [ ] Monitoring live: OTel traces + Vercel Analytics + cron gauges + alert hooks.

---

## 11. Open operator / legal decisions (resolve or consciously defer)

These are **not** things Claude can do — they need operator/legal action and a recorded decision.

| Decision | Why it's a gate | Options |
|----------|-----------------|---------|
| 🟡 **Stripe LIVE cutover** | F5 is not production-live until live keys + products + PromptPay + live webhook are cut over. The app boots fine on `sk_test_` keys with F5 dark. | **Launch-minimal**: ship members+invoicing now, F5 as a fast-follow. **OR** cut over Stripe live (set `sk_live_`/`pk_live_`/live `whsec_` + `STRIPE_LIVE_MODE=true`, register the live webhook, then flip `FEATURE_F5_ONLINE_PAYMENT`). |
| 🟡 **Privacy policy / PDPA consent** | Importing ~131 real members' PII needs a privacy notice + lawful basis. Member surfaces, the broadcast unsubscribe footer, and GDPR export reference a policy URL. | **Blocker for real-data go-live** (legal text is operator/customer-produced). Once published, set `TENANT_PRIVACY_POLICY_URL` (+ `TENANT_WEBSITE_URL`). |
| **F6 Zapier DPA** | F6 attendee PII transits Zapier (US). PDPA §28 / GDPR Art.28 require an executed DPA before live data flows; boot refuses F6-on in prod without `ZAPIER_DPA_EXECUTED=true`. | Keep F6 dark until the DPA is signed, then set the salt + DPA flag + flip. |

---

## Appendix — quick command reference

```bash
# Env
vercel env ls production
vercel env add  <NAME> production         # reads value from stdin
vercel env rm   <NAME> production

# Deploy / rollback
vercel deploy --prod
vercel logs <deployment-url>
vercel promote <previous-deployment-url>  # rollback

# Emergency write-freeze (no code deploy needed beyond the redeploy)
vercel env add READ_ONLY_MODE true production && vercel deploy --prod

# Secret rotation (CRON_SECRET) — see docs/runbooks/cron-jobs.md § Secret rotation
openssl rand -base64 48
```

**Cross-references**: `docs/go-live-readiness.md` (stages + go/no-go) · `docs/runbooks/cron-jobs.md`
(per-job detail) · `docs/runbooks/clamav-daemon-down.md` · `docs/member-import-spec.md` ·
`src/lib/env.ts` (env schema — the source of truth this file is derived from).
