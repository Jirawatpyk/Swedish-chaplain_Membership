# Go-Live Docs Audit — specialist findings (2026-05-30)

**Source**: `go-live-docs-audit` workflow — 11 specialists × 5 docs, cross-checked
against the live repo, P0/P1 adversarially verified.
**Raw**: 135 findings (P0 27 · P1 44 · P2 48 · P3 16). **Deduped distinct: 15** (heavy
overlap — the Stripe-key + missing-env issues were each found by ~6 specialists).

> All P0/P1 below were verified against actual source (`src/lib/env.ts`, route
> files, schemas, `cron-jobs.md`, seed scripts). Status reflects this session's fix pass.

---

## P0 — factual errors that would cause a wrong launch action

| # | Issue | Where | Source truth | Status |
|---|-------|-------|--------------|--------|
| D1 | Stripe publishable key named `STRIPE_PUBLISHABLE_KEY` — app reads **`NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY`**; bare name → Stripe Elements never loads in browser | readiness §6.1, operator §1 (also `credential-compromise.md`) | `env.ts:236`, consumed `:828` | ✅ fixed |
| D2 | **Boot-required env vars absent** from "complete" checklist: `APP_ALLOWED_ORIGINS`, `TENANT_SLUG`, `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` (all unconditional — app refuses to boot) | readiness §6.1, operator §1 | `env.ts:92,122,414` | ✅ fixed |
| D3 | **Flag-conditional boot-blockers absent**: `STRIPE_LIVE_MODE` (cross-field guard), `EVENTCREATE_PII_PSEUDONYM_SALT` + `ZAPIER_DPA_EXECUTED` (F6 boot assert; ZAPIER also PDPA §28/GDPR Art.28 gate) | readiness §6.1, operator §1/§5 | `env.ts:264,477,494,639,663,686` | ✅ fixed |
| D4 | F9 `snapshot-refresh-coordinator` cron registered as **GET** — route exports **POST only** → 405 every tick, dashboard cache never refreshes | operator §3 (line 74) | route `:29` POST | ✅ fixed |

## P1 — significant gaps

| # | Issue | Where | Status |
|---|-------|-------|--------|
| D5 | ClamAV docs describe legacy **TCP/6PN**; production uses **Option D HTTP wrapper** — `CLAMAV_SCAN_URL` + `CLAMAV_SCAN_SECRET` absent from checklist | readiness §6.3, operator §4 (`env.ts:552,556`) | ✅ fixed |
| D6 | Cron lists incomplete: F7 `prune-expired-drafts` missing; F6 "sweeps" = **3 distinct jobs + gauge**; F8 = **7 coordinators** (vaguely "F8 coordinators") | readiness §6.2, operator §3 (`cron-jobs.md`) | ✅ fixed |
| D7 | Flag-flip omits F7.1a sub-flags `FEATURE_F71A_US7_TEMPLATES` → `US2_IMAGES` → `US1_PAGINATION` (staged order) | readiness §6.4, operator §5 (`env.ts:507-509`) | ✅ fixed |
| D8 | Seed command missing `TENANT_SLUG=swecham` — script hard-refuses without it | operator §2 (`seed-swecham-2026-plans.ts:56`) | ✅ fixed |
| D9 | Importer dedup by email ignores `removed_at IS NULL` — partial unique index `contacts(tenant_id, lower(email)) WHERE removed_at IS NULL` → soft-deleted contacts invisible | member-import-spec §2/§5 | ✅ fixed |
| D10 | Spec conflates `members.preferred_locale` vs `contacts.preferred_language` into one mapping row | member-import-spec §1/§2 | ✅ fixed |
| D11 | **No Excel parsing lib in `package.json`** — importer can't compile until `xlsx`/`exceljs` added | member-import-spec §7 | ✅ noted in spec |
| D12 | Go/No-Go references **golden-path E2E that don't exist** (`tests/e2e/` has only per-feature specs, no `*-journey.spec.ts`) | readiness §7 / §4 Stage 1b | ✅ noted |
| D13 | F9 perf suites (`dashboard-perf`, `audit-perf`) **not wired into `scripts/run-perf-tests.ts`** — Go/No-Go perf gate incomplete | readiness §7 (`observability.md §25.2`) | ✅ noted |
| D14 | Audit workflow: **journey findings bypass adversarial verify** (only per-module P0/P1 verified) | `go-live-audit.workflow.js` synth phase | ✅ fixed |
| D15 | `audit_log.retention_years` set (5y/10y) but **no purge cron exists** → GDPR Art.5(1)(e)/PDPA §37 storage-limitation unmet | codebase gap | ✅ logged as risk (post-launch) |

---

## Notes

- **D11/D12/D13/D15 are codebase realities, not just doc edits** — the docs were
  corrected to state them accurately; the actual build work (add Excel lib, write
  journey E2E specs, wire perf suites, build audit purge cron) lands in the relevant Stage.
- The Stripe-key error also exists in `docs/runbooks/credential-compromise.md:20`
  (outside this doc set) — fix in the same pass when touching that runbook.
- P2/P3 (64 findings) are clarity/nits — folded into the doc edits where cheap; not separately tracked.
