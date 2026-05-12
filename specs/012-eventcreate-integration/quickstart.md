# Quickstart: F6 — EventCreate Integration (developer onboarding)

**Branch**: `012-eventcreate-integration`
**Audience**: Developer joining mid-F6 implementation (or returning after a context switch).
**Prerequisites**: F1+F2+F3+F4+F5+F7+F8 already merged on `main`; you have a working local dev setup per the F1 quickstart (`specs/001-auth-rbac/quickstart.md`).

This doc covers (a) the environment + secret setup specific to F6, (b) the day-1 implementation workflow following the Spec Kit gates, (c) the manual end-to-end smoke test using a real Zap.

---

## 1. Environment + secrets

Add the following to your `.env.local` (after `vercel env pull` for the base set):

```bash
# F6 — EventCreate Integration
FEATURE_F6_EVENTCREATE=true                              # turn on F6 for local dev
EVENTCREATE_PII_PSEUDONYM_SALT=<32-byte-base64-random>   # per-environment salt; rotate by env, not by tenant

# Existing F5 var reused for F6 cron
CRON_SECRET=<existing>                                   # already in .env.local from F5

# Existing F1+F4 redact list — extended in lib/logger.ts (no env change needed)
```

The zod schema in `src/lib/env.ts` is extended to fail-fast on missing `EVENTCREATE_PII_PSEUDONYM_SALT` when `FEATURE_F6_EVENTCREATE === 'true'`. If you flip the flag without the salt, the app refuses to start with a clear error message.

**Production**: the salt is generated once per environment (preview, production) via `openssl rand -base64 32` and stored as a Vercel env var. Rotation is a coordinated event — old salts cannot be discarded because pseudonymised rows still need them for re-identification by audit reconstruction.

---

## 2. Day-1 implementation workflow

Follow the Spec Kit gates from `CLAUDE.md` § Spec Kit workflow:

```text
/speckit.specify (done) → /speckit.clarify (done) → /speckit.plan (done — this gate)
  → /speckit.checklist (next)
  → /speckit.tasks
  → /speckit.analyze
  → /speckit.implement (TDD: failing tests first)
  → /speckit.verify
  → /speckit.review + /speckit.staff-review (solo-maintainer substitute applies)
  → /speckit.ship
```

### 2.1 Migration order (Drizzle)

Run migrations 0127–0134 in sequence. Each migration is in its own file (per F4/F5/F7/F8 convention).

```bash
pnpm drizzle-kit generate          # generate 0127..0134 from src/modules/events/infrastructure/schema.ts
pnpm drizzle-kit migrate           # applies to $DATABASE_URL
```

Verify with `psql $DATABASE_URL -c "\d events"` etc. All 3 F6 tables should show `ROW LEVEL SECURITY = ON, FORCE`.

### 2.2 Wire the F8 `EventAttendeesPort` adapter swap

Open `src/app/(staff)/admin/renewals/...` route loaders + `src/app/api/cron/renewals/...` cron handlers. Each composition root currently imports `stubEventAttendeesPort` from F8's barrel; conditionally swap for `drizzleEventAttendeesAdapter` from F6's barrel when `process.env.FEATURE_F6_EVENTCREATE === 'true'`:

```ts
// at the top of each composition root
import { stubEventAttendeesPort } from '@/modules/renewals';
import { drizzleEventAttendeesAdapter } from '@/modules/events';

const eventAttendeesPort = process.env.FEATURE_F6_EVENTCREATE === 'true'
  ? drizzleEventAttendeesAdapter(db)
  : stubEventAttendeesPort;
```

F8's existing test `tests/integration/renewals/at-risk-f6-fallback.test.ts` covers both modes — re-run it after the swap to confirm both code paths still pass.

### 2.3 Cron handler setup (cron-job.org)

After deployment, add **two new cron coordinators** at cron-job.org (mirror the F4/F5/F7/F8 pattern):

| Schedule (UTC) | URL | Purpose |
|----------------|-----|---------|
| `0 20 * * *` (daily 03:00 Asia/Bangkok) | `/api/internal/retention/pseudonymise-eventcreate` | FR-032 non-member PII pseudonymisation sweep |
| `0 21 * * *` (daily 04:00 Asia/Bangkok) | `/api/internal/retention/sweep-eventcreate-idempotency` | TTL cleanup of `eventcreate_idempotency_receipts` (per Z5 round-3 critique) |

Both use `Authorization: Bearer <CRON_SECRET>` header.

Document both in `docs/runbooks/cron-jobs.md` alongside the existing F4–F8 coordinators.

---

## 3. Manual end-to-end smoke test (post-implement, pre-ship)

This is the "I want to actually see a real Zap fire" test before flipping `FEATURE_F6_EVENTCREATE` on for SweCham in production.

### 3.1 Create a Zapier sandbox account

If you don't have one already: sign up at zapier.com (free tier is sufficient).

### 3.2 Create an EventCreate test event

In your tenant's EventCreate account, create a single test event with a non-production name (e.g., "F6 SMOKE TEST 2026-05-12") and register one test attendee using an email that matches a known chamber member's contact (e.g., the maintainer's own contact email if it's seeded).

### 3.3 Configure the Zap

In Zapier:

1. **Trigger** — EventCreate → "New Attendees Registered" — select your test event
2. **Action** — Webhooks by Zapier → "POST"
   - **URL**: `https://<your-staging-domain>/api/webhooks/eventcreate/v1/<your-tenant-slug>` (NOTE: `/v1/` segment is mandatory per FR-001)
   - **Content-Type**: `application/json`
   - **Headers**:
     - `X-Chamber-Signature`: use Zapier's "Formatter → Crypto → HMAC" step computed as `SHA256(<your-tenant-secret>, "${timestamp}.${rawBody}")` prefixed with `sha256=`
     - `X-Chamber-Timestamp`: Zapier "Formatter → Date / Time → now → epoch seconds"
     - `X-Request-ID`: the EventCreate attendee external ID (or any Zapier-generated UUID)
   - **Body**: map the EventCreate event + attendee fields per `contracts/webhook-eventcreate-api.md`

### 3.4 Test it

1. In Chamber-OS admin, navigate to `/admin/integrations/eventcreate` — confirm the secret is configured and `lastReceivedAt` is null.
2. In Zapier, click "Test step" on the POST action — Zapier sends the payload.
3. Expected: Chamber-OS returns 200 with `{ ok: true, matched: ..., registrationId: ... }`.
4. Refresh the admin page — `lastReceivedAt` updates; the test delivery appears in the recent-deliveries panel.
5. Navigate to `/admin/events` — your test event appears in the list with 1 registration.
6. Click into the event — the attendee row shows match status + ticket info + quota effect.

### 3.5 Test failure modes

While Zapier is still in test mode, deliberately break things:

- Edit the secret to be wrong → re-test → expect 401 + admin sees `webhook_signature_rejected` in recent-deliveries
- Edit the timestamp to be 10min old → expect 401 + `webhook_replay_rejected`
- Re-send the same payload → expect 409 + `webhook_duplicate_rejected`
- Send malformed JSON (missing `attendee.email`) → expect 400 + `webhook_malformed_rejected`

After verification, fix the Zap and publish it for live use.

---

## 4. CSV fallback smoke test

1. Open `/admin/events/import` and drag-drop a 5-row CSV matching the format in `contracts/csv-import-api.md`.
2. Confirm the preview shows the first 5 rows with column mapping suggestions.
3. Click "Import".
4. Result page should show: 5 rows processed, 1 event created, 5 registrations matched (by your match-type), 0 errors.
5. Navigate to `/admin/events/<that event id>` — the 5 attendees appear.

Re-upload the same CSV — expect 0 new rows (idempotency via row-hash).

---

## 5. Local testing commands

The full F6 test suite, in the order it runs in CI:

```bash
# 1. Lint + typecheck
pnpm lint
pnpm typecheck

# 2. Unit + contract tests (vitest)
pnpm test --filter events

# 3. Integration tests (live Neon Singapore)
pnpm test:integration --filter events

# 4. Cross-tenant probe (Review-Gate blocker)
pnpm test:integration tests/integration/events/tenant-isolation.test.ts

# 5. E2E (Playwright — REMEMBER --workers=1 per project convention)
pnpm test:e2e tests/e2e/eventcreate-*.spec.ts --workers=1

# 6. A11y
pnpm test:e2e --grep "@a11y" --workers=1

# 7. i18n coverage
pnpm check:i18n

# 8. Layout check (existing CI gate)
pnpm check:layout
```

Reproduce the full CI chain locally before pushing:

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n && pnpm check:layout && pnpm test:integration && pnpm test:e2e --workers=1
```

---

## 6. Observability dashboards (post-deploy)

After F6 deploys to staging:

1. Open Vercel Observability → Metrics → confirm `eventcreate_webhook_receipts_total` is being emitted (filter by `tenant_id=<your tenant>`)
2. Check `eventcreate_webhook_ingest_latency_seconds` histogram — p95 should be well under 300ms in the empty-load case
3. Verify all 5 alerts are wired (see `research.md` R10)
4. Verify all 3 runbooks exist under `docs/runbooks/` (signature-failure, match-rate degradation, secret-rotation)

---

## 7. Rollback plan

F6 is feature-flag-gated. To roll back in production:

```bash
# 1. Disable the feature flag in Vercel
vercel env rm FEATURE_F6_EVENTCREATE production
vercel env add FEATURE_F6_EVENTCREATE production
# Set value to 'false'

# 2. Trigger a redeploy (no code change needed)
vercel --prod
```

This will:
- Reject new webhook deliveries with `feature_disabled` (treated as a 503 by Zapier, retries indefinitely until re-enabled)
- Disable the admin events list + integration config + CSV import (return 404)
- F8 falls back to the stub `EventAttendeesPort` automatically (at-risk score factors degrade gracefully per F8's FR-029a)

Existing data (events, registrations, audit log) is preserved. Re-enabling the flag restores all surfaces without data loss.

To roll back the **schema** as well (rare; only if a migration bug is discovered post-merge):

```bash
# Run the corresponding down-migrations 0134 → 0127 in reverse order
pnpm drizzle-kit migrate:down --steps=8
```

Down-migrations are idempotent and reverse the CREATE TABLE / ALTER TABLE / CREATE INDEX statements cleanly. There is no data destruction in the down path because F6 is dark-deployed (no production data flows in until the flag flips).

---

## 8. Common gotchas

- **Edge runtime vs Node runtime**: the webhook receiver MUST be Node runtime. The route handler exports `export const runtime = 'nodejs'` at the top — verify this before merging.
- **Raw body access**: HMAC verification needs the unparsed body. Use `await request.text()` BEFORE any `await request.json()` parse. Re-parse the text yourself with Zod.
- **`crypto.timingSafeEqual` length check**: it throws if the two buffers are different lengths. Compute HMAC first to a known fixed length, then compare. Wrap in try/catch and treat length mismatch as signature rejection.
- **Postgres advisory locks**: F6 does NOT use advisory locks (unlike F4 §87 numbering + F5 TOCTOU guard + F7 broadcast dispatch + F8 cron coordinator). The `SELECT … FOR UPDATE` row lock on the quota counter is sufficient at F6's transaction granularity.
- **Don't write to F2 quota counters directly**: F2 owns its schema. F6 calls `getMemberPlanForBucket` + `applyQuotaEffect` through F2's barrel; do not reach into F2's tables from F6 use-cases.
- **Test the cron handler timeout**: if pseudonymisation sweep exceeds 60s with 50k rows, batch the work — don't extend the function timeout.
- **i18n keys for audit events**: all ~35 event types have a human-readable description in `i18n/messages/{en,th,sv}.json` under `audit.eventcreate.*`. CI fails if any is missing.
- **CSV import 5 MiB limit**: enforced at the multipart parse boundary. If a tenant needs >5 MiB, they have to split the file — bigger uploads are F6.1 backlog.

---

## 9. Where to file follow-up work

- **F6.1 backlog** (post-MVP): create issues with the `F6.1` label for anything deferred during MVP (e.g., >5k-attendee event, real-time push delivery, ICS calendar sync, multi-source ingestion). See `spec.md` § Out of scope.
- **Constitution amendments triggered by F6 retrospective**: file under `.specify/memory/constitution.md` with version bump per the F8/F1 precedent.
- **F8 → F6 hook follow-ups**: if F8 needs additional data from F6 (e.g., last-event-attended timestamp on the member profile), extend F8's `EventAttendeesPort` interface FIRST in F8's spec amendment, then add the implementation in F6's barrel — never the other way around.
