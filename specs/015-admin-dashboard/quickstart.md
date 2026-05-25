# Quickstart — F9 Admin Dashboard + Directory + Timeline + Audit

**Branch**: `015-admin-dashboard` | **Date**: 2026-05-25

Developer onboarding for F9. Assumes the F1–F8 local setup from
`specs/001-auth-rbac/quickstart.md` is already working (Vercel link, Neon Singapore via
`.env.local`, seeded tenant + members).

## 1. Branch & feature

```bash
git checkout 015-admin-dashboard
pnpm install            # no new runtime deps for F9
```

## 2. New environment variables

Add to Vercel env (and pull locally). `src/lib/env.ts` (zod) will refuse to boot if
missing/invalid:

```bash
FEATURE_F9_DASHBOARD=false          # ships dark; flip to true to expose /admin dashboard
EXPORT_DOWNLOAD_TOKEN_SECRET=<≥32-byte random, distinct from AUTH/UNSUBSCRIBE secrets>
# reused: CRON_SECRET, BLOB_READ_WRITE_TOKEN
vercel env pull .env.local
```

## 3. Apply migrations (0185+) — BEFORE running code that references new columns

```bash
pnpm drizzle-kit migrate         # applies 0185..0190 to $DATABASE_URL (live Neon)
pnpm test:integration            # confirm schema + RLS before committing (CLAUDE.md R8 gotcha)
```

Migrations: `dashboard_metrics_cache`, `smart_insight_dismissals`, `directory_listings`,
`export_jobs` (+ enums), `member_timeline_v` view (`security_invoker`), audit-query
indexes. See `data-model.md §9`.

## 4. Run locally

```bash
pnpm dev                          # :3100 (user runs this; do not restart for env changes)
# Seed a tenant with members/invoices/payments/broadcasts/events in known states,
# then open /admin (with FEATURE_F9_DASHBOARD=true) as an admin.
```

## 5. Tests (TDD order — failing acceptance test first)

```bash
pnpm test unit/insights                       # domain + projections (fast-check)
pnpm test contract                            # audit-query, export-job, directory, dashboard ports
pnpm test:integration insights                # live Neon — INCLUDES cross-tenant isolation (Principle I)
pnpm test:integration members                 # timeline multi-source union
pnpm test:e2e --grep "@f9" --workers=1        # dashboard/audit/directory/timeline/benefits/gdpr-export
pnpm test:e2e --grep "@a11y" --workers=1      # WCAG 2.1 AA scan
pnpm test:e2e --grep "@i18n" --workers=1      # EN/TH/SV coverage
```

> Always pass `--workers=1` to `pnpm test:e2e` (the default of 3 hangs this workstation).

## 6. The MUST-haves before Review gate

- **Cross-tenant isolation integration test** (two tenants, read+write both directions,
  zero visibility) for dashboard, audit query, `member_timeline_v`, directory, export —
  **Review-Gate blocker** (Principle I §3).
- **`security_invoker = on`** asserted on `member_timeline_v` (CI guard
  `check-f9-schema`).
- **GDPR export redaction**: archive audit subset = member-performed ∪ member-targeted,
  third-party PII + internal annotations stripped (100% branch coverage on the scoping).
- **Private download proxy**: session + RBAC + signed-token + expiry all enforced; Blob
  URL never sent to client.
- **No global `db`**: every F9 repo method threads `tx` from `runInTenant`.
- **Benefit-usage determinism** (critique R2-E5): tests for the membership-year boundary
  (a broadcast sent Dec-31 vs Jan-1 counts in the correct **tenant-timezone calendar
  year**); the aggregate consumed-% = **mean of quantifiable-benefit ratios, excluding
  unlimited**; and the 25-pt under-use warning firing exactly at the threshold.
- **Directory logo pipeline** (FR-025a): tests that a logo upload is re-encoded +
  EXIF-stripped, rejects oversize/non-image input, and never serves the original bytes.
- **i18n**: EN canonical; TH + SV present (`pnpm check:i18n`); BE display for `th-TH`.

## 7. Full CI before push

```bash
pnpm lint && pnpm typecheck && pnpm test:coverage && pnpm check:i18n \
  && pnpm check:layout && pnpm check:fixme && pnpm test:integration && pnpm test:e2e
```

## 8. Ship-day operator gates (deferred to /speckit.ship)

- cron-job.org coordinators: `snapshot-refresh-coordinator` + `process-export-jobs`
  (both `*/5`, Bearer `CRON_SECRET`) — see `contracts/http-endpoints.md`.
- Vercel env vars set in Production (incl. `EXPORT_DOWNLOAD_TOKEN_SECRET`).
- Flag-flip sequence: tables + cron live dark → staging QA → flip `FEATURE_F9_DASHBOARD`.
- Append F9 section to `docs/runbooks/cron-jobs.md` + SLOs to `docs/observability.md`.
