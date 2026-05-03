# F8 — Renewal Tracking + Smart Reminders — Quickstart

**Feature**: F8 Renewal Tracking + Smart Reminders
**Branch**: `011-renewal-reminders`
**Date**: 2026-05-03
**Status**: Phase 1 quickstart output

This is the developer quickstart for working on F8. Assumes you already have a working F1+F2+F3+F4+F5+F7 dev environment per the existing project quickstarts in `specs/001-auth-rbac/quickstart.md` (foundation), `specs/007-invoices-receipts/quickstart.md` (F4), and `specs/010-email-broadcast/quickstart.md` (F7 — most recent for cron-job.org pattern).

---

## 1. Required environment variables

Add to `.env.local` (and Vercel env for staging/production):

```bash
# F8 — Renewal Tracking
FEATURE_F8_RENEWALS=true                 # Default false in production until F9 ships (see Assumption A12)
RENEWAL_LINK_TOKEN_SECRET=<32-byte-min>  # Generated via: openssl rand -base64 32
                                         # MUST be distinct from AUTH_COOKIE_SIGNING_SECRET (F1)
                                         # MUST be distinct from UNSUBSCRIBE_TOKEN_SECRET (F7)

# Reused from F4/F5/F7 (no new value needed)
CRON_SECRET=<existing>                   # Bearer auth for /api/cron/renewals/*
RESEND_API_KEY=<existing>                # F1+F4 transactional surface; F8 reuses
DATABASE_URL=<existing>                  # Neon Postgres
DEBUG_RLS_STATE=1                        # Dev-only RLS safety net
```

Validation: `pnpm dev` will refuse to start if `RENEWAL_LINK_TOKEN_SECRET` is missing or shorter than 32 bytes (zod check in `src/lib/env.ts`).

---

## 2. Database migrations

```bash
# Generate the F8 migration set (after writing schema in src/modules/renewals/infrastructure/drizzle/schema.ts)
pnpm drizzle-kit generate

# Apply to dev DB
pnpm drizzle-kit migrate

# Verify the 7 new tables + extended columns
psql $DATABASE_URL -c "\d renewal_cycles"
psql $DATABASE_URL -c "\d renewal_reminder_events"
psql $DATABASE_URL -c "\d tenant_renewal_settings"
psql $DATABASE_URL -c "\d tenant_renewal_schedule_policies"
psql $DATABASE_URL -c "\d at_risk_outreach"
psql $DATABASE_URL -c "\d tier_upgrade_suggestions"
psql $DATABASE_URL -c "\d renewal_escalation_tasks"
psql $DATABASE_URL -c "\d consumed_link_tokens"
psql $DATABASE_URL -c "\d members"   # confirm 7 new columns present
psql $DATABASE_URL -c "\d membership_plans"  # confirm renewal_tier_bucket column present
```

---

## 3. Seed data for development

```bash
# Seed default schedule policies for the SweCham tenant (5 buckets per docs/smart-chamber-features.md § 4)
pnpm tsx scripts/seed-renewal-schedule-policies.ts

# Seed default tenant_renewal_settings (grace_period_days=14, etc.)
pnpm tsx scripts/seed-renewal-tenant-settings.ts

# Materialise renewal_cycles for existing F3 members (calls computeExpiresAt for each)
pnpm tsx scripts/seed-renewal-cycles-from-members.ts
```

Script outline (each ships in `scripts/`):

- `seed-renewal-schedule-policies.ts` — inserts 5 rows per tenant from a hardcoded fixture (the 5 buckets x their canonical schedule per `docs/smart-chamber-features.md` § 4)
- `seed-renewal-tenant-settings.ts` — inserts one row per active tenant with default values
- `seed-renewal-cycles-from-members.ts` — for each F3 member, computes `expires_at` from `joined_at + plan.term_months` and inserts the initial `RenewalCycle` row

---

## 4. Manual cron triggering

```bash
# Daily reminder dispatch
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3100/api/cron/renewals/dispatch | jq

# Weekly at-risk recompute
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3100/api/cron/renewals/at-risk-recompute | jq

# Weekly tier-upgrade evaluate
curl -X POST -H "Authorization: Bearer $CRON_SECRET" \
  http://localhost:3100/api/cron/renewals/tier-upgrade-evaluate | jq
```

Each returns a JSON summary per `contracts/cron-renewals-api.md` § 1–3.

---

## 5. Test cycle

```bash
# Unit tests (Domain + Application + Infrastructure)
pnpm test src/modules/renewals/

# Integration tests (live Neon Singapore — uses .env.local DATABASE_URL)
pnpm test:integration tests/integration/renewals/

# E2E tests
pnpm test:e2e --workers=1 tests/e2e/renewal-pipeline-dashboard.spec.ts
pnpm test:e2e --workers=1 tests/e2e/tier-aware-reminder-cron.spec.ts
pnpm test:e2e --workers=1 tests/e2e/member-self-service-renewal.spec.ts
pnpm test:e2e --workers=1 tests/e2e/at-risk-widget.spec.ts
pnpm test:e2e --workers=1 tests/e2e/auto-tier-upgrade.spec.ts
pnpm test:e2e --workers=1 tests/e2e/escalation-task-queue.spec.ts
pnpm test:e2e --workers=1 tests/e2e/lapsed-portal-scope.spec.ts
pnpm test:e2e --workers=1 tests/e2e/manager-readonly.spec.ts
pnpm test:e2e --workers=1 tests/e2e/renewal-a11y.spec.ts
pnpm test:e2e --workers=1 tests/e2e/renewal-i18n.spec.ts
```

**Note**: `--workers=1` is mandatory per project memory `feedback_e2e_workers.md` — Playwright default of 3 workers hangs the maintainer's machine.

---

## 6. Frontend dev workflow

```bash
# Dev server on port 3100 (port 3000 reserved for other Express projects)
pnpm dev

# Open the renewal pipeline as admin
# http://localhost:3100/admin/renewals

# Open the at-risk widget
# http://localhost:3100/admin/renewals  (widget is on the same page)

# Open the tier-upgrade queue
# http://localhost:3100/admin/renewals/tier-upgrades

# Open the escalation task queue
# http://localhost:3100/admin/renewals/tasks

# Open the schedule policy editor
# http://localhost:3100/admin/renewals/settings/schedules

# Open a member self-service renewal page (assumes test fixture exists)
# http://localhost:3100/portal/renewal/<test_member_id>

# Open member preferences
# http://localhost:3100/portal/preferences/renewals
```

The Next.js dev server hot-reloads on `.env.local` changes WITHOUT restart (per project memory `feedback_user_runs_dev_server.md` — never kill the dev server).

---

## 7. cron-job.org configuration (staging + production)

After staging deployment, add 3 new cron-job.org jobs (see `contracts/cron-renewals-api.md` § 4):

| Job name | URL | Cadence | Notify on failure |
|---|---|---|---|
| F8 Renewal Dispatch | `https://staging.swecham.zyncdata.app/api/cron/renewals/dispatch` | `0 6 * * *` Bangkok | ops@... |
| F8 At-Risk Recompute | `.../api/cron/renewals/at-risk-recompute` | `0 2 * * 0` Bangkok Sun | ops@... |
| F8 Tier-Upgrade Evaluate | `.../api/cron/renewals/tier-upgrade-evaluate` | `0 3 * * 0` Bangkok Sun | ops@... |

Each job's Bearer header: `Authorization: Bearer <CRON_SECRET>` (from Vercel env).

---

## 8. Production rollout

F8 ships **complete in scope** within this branch but goes **dark** in production (`FEATURE_F8_RENEWALS=false`) until the entire planned MVP is ready for chamber adoption (per Assumption A12 v3).

Sequence:

1. Merge F8 PR with `FEATURE_F8_RENEWALS=false` set in Vercel production. F8 backend + cron + ALL UI surfaces + audit deployed but NOT exposed (kill-switch returns 404 / no-op)
2. Staging validation runs continuously: end-to-end self-service renewal cycle + cron passes + bounce-threshold detection + tier-upgrade pending flow + cross-tenant integration test green
3. Remaining MVP work lands in production behind their own dark switches: F6 (EventCreate), F9 (Admin Dashboard + Directory + Timeline + Audit), R6 folder rename, Phase 5B design system polish
4. **Single MVP cutover event** when the entire MVP is complete + stable in staging:
   - Communicate go-live to SweCham admin + executive director
   - Flip kill-switches for F1-F9 + smart features simultaneously using Vercel Rolling Releases (10% → 50% → 100% over 30-min observation windows per F5 ship pattern)
   - Chamber begins using Chamber-OS for the first time
5. Monitor for 7 days: `renewals.cycles_active`, `renewals.reminders_sent_total`, `renewals.reminders_failed_total`, `at_risk.scores_recomputed_total` + cross-feature SLOs from F4/F5/F7/F9
6. Run first T-30 reminder cycle; deliver first member self-service renewals

---

## 9. Rollback procedures

### Soft rollback (kill-switch flip)

```bash
# In Vercel production env
vercel env rm FEATURE_F8_RENEWALS production
vercel env add FEATURE_F8_RENEWALS production
# Set to: false
# Trigger redeploy to apply
```

Effect: cron handlers return `{skipped: true, reason: 'feature_flag_disabled'}`; admin pipeline route returns 404; member portal renewal page returns generic "feature unavailable". F4/F5 unaffected.

### Hard rollback (DB migration revert)

If a serious data issue surfaces:

```bash
# Apply down migrations 0094 → 0086 in reverse order (F8 owns 0086-0094 after F7 post-ship 0084/0085)
psql $DATABASE_URL -f drizzle/migrations/0094_DOWN.sql
psql $DATABASE_URL -f drizzle/migrations/0093_DOWN.sql
# ... etc through 0086_DOWN.sql
```

Down migrations DROP the F8 tables + REMOVE the F2/F3 column extensions. Audit log entries with F8 event types REMAIN (audit log is append-only; rollback only removes future emissions).

### READ_ONLY_MODE interaction

Setting `READ_ONLY_MODE=true` (existing emergency switch, F1 era) immediately:
- F8 cron handlers return `{skipped: true, reason: 'read_only_mode'}` + audit `renewal_reminder_deferred_read_only` per skipped step
- Member self-service confirm endpoint returns 503
- Admin manual send + snooze + accept/dismiss/escalate / task mutations all return 503
- Pipeline read-only views still work

Reversible in ~30 seconds without code deploy.

---

## 10. Common dev tasks

### Add a new audit event type

1. Add to the F8 audit event taxonomy in `src/modules/renewals/application/ports/renewal-audit-emitter.ts`
2. Add the matching payload TS type
3. Update `data-model.md` § 4 audit taxonomy
4. Update `contracts/audit-port.md` interface + payload
5. Add a contract test in `tests/contract/audit-port.contract.test.ts`

### Add a new reminder template

1. Author EN copy in `src/i18n/messages/en.json` under `email.renewal.<template_id>.*`
2. Translate to TH + SV in `th.json` + `sv.json` (or open a translation issue)
3. Add the React Email template in `src/modules/renewals/infrastructure/resend/templates/<template_id>.tsx`
4. Reference the `template_id` in the schedule policy step
5. Add E2E test for the new template render

### Adjust the at-risk score formula

1. Modify `compute-at-risk-score.ts` use-case
2. Update FR-029 in `spec.md`
3. Update R4 in `research.md` with new factor weights + rationale
4. Re-run synthetic-data calibration in `tests/integration/renewals/at-risk-fixture-calibration.test.ts`
5. Communicate the change in the next staff-review round

### Add a new tier bucket (e.g., for a future SaaS tenant)

**Out of MVP scope.** Per Q2 round 1 + OOS-12, the 5 buckets are frozen for MVP. Adding a 6th bucket post-MVP requires:

1. Migration to extend the `tier_bucket` enum CHECK constraint
2. F2 plan re-bucket migration with updated CASE statement
3. Schedule policy fixture for the new bucket
4. UI changes in `tier-badge.tsx`
5. i18n keys for the new bucket label

---

## 11. Useful queries (debugging)

```sql
-- All cycles within the next 90 days, ordered by urgency
SELECT
  rc.member_id,
  m.company_name,
  rc.tier_at_cycle_start,
  rc.expires_at,
  rc.status,
  EXTRACT(EPOCH FROM (rc.expires_at - NOW())) / 86400 AS days_to_expiry
FROM renewal_cycles rc
JOIN members m ON (m.tenant_id = rc.tenant_id AND m.member_id = rc.member_id)
WHERE rc.tenant_id = current_setting('app.current_tenant')
  AND rc.expires_at <= NOW() + INTERVAL '90 days'
  AND rc.status NOT IN ('cancelled', 'completed')
ORDER BY rc.expires_at ASC;

-- Current at-risk distribution
SELECT risk_score_band, COUNT(*) AS members
FROM members
WHERE tenant_id = current_setting('app.current_tenant')
  AND risk_score IS NOT NULL
GROUP BY risk_score_band
ORDER BY CASE risk_score_band
  WHEN 'critical' THEN 1
  WHEN 'at-risk' THEN 2
  WHEN 'warning' THEN 3
  WHEN 'healthy' THEN 4
END;

-- Pending tier upgrades + their target cycles
SELECT
  tus.suggestion_id,
  m.company_name,
  fp.plan_name AS from_plan,
  tp.plan_name AS to_plan,
  tus.target_apply_at_cycle_id,
  rc.expires_at AS target_apply_at
FROM tier_upgrade_suggestions tus
JOIN members m ON (m.tenant_id = tus.tenant_id AND m.member_id = tus.member_id)
JOIN membership_plans fp ON (fp.tenant_id = tus.tenant_id AND fp.plan_id = tus.from_plan_id)
JOIN membership_plans tp ON (tp.tenant_id = tus.tenant_id AND tp.plan_id = tus.to_plan_id)
LEFT JOIN renewal_cycles rc ON (rc.tenant_id = tus.tenant_id AND rc.cycle_id = tus.target_apply_at_cycle_id)
WHERE tus.tenant_id = current_setting('app.current_tenant')
  AND tus.status = 'accepted_pending_apply';

-- Open escalation tasks per assignee
SELECT
  COALESCE(u.email, '<unassigned>') AS assignee,
  ret.task_type,
  COUNT(*) AS open_count,
  MIN(ret.due_at) AS earliest_due
FROM renewal_escalation_tasks ret
LEFT JOIN users u ON (u.user_id = ret.assigned_to_user_id)
WHERE ret.tenant_id = current_setting('app.current_tenant')
  AND ret.status = 'open'
GROUP BY u.email, ret.task_type
ORDER BY u.email, earliest_due;
```

---

## 12. References

- `spec.md` — full feature spec with FRs, USes, SCs, Clarifications
- `plan.md` — implementation plan + Constitution Check + Complexity Tracking
- `research.md` — Phase 0 decisions (10 areas)
- `data-model.md` — Phase 1 schema + state machines + RLS
- `contracts/admin-renewals-api.md` — admin endpoints
- `contracts/portal-renewal-api.md` — member portal endpoints
- `contracts/cron-renewals-api.md` — 3 cron handlers
- `contracts/audit-port.md` — audit event taxonomy
- `docs/smart-chamber-features.md` § 3, § 4, § 12 — design source for at-risk + reminders + tier-upgrade
- `docs/observability.md` § 14 — SLO + metric conventions reused
- `docs/runbooks/cron-jobs.md` — operational runbook (extended with F8 entries)
