# F7 Release Record — 2026-04-30 (MVP slice US1+US2)

**Release date**: 2026-04-30
**Feature**: F7 — Email Broadcast (E-Blast)
**Branch**: `010-email-broadcast`
**Last commit**: `0950e6f [Spec Kit] F7 — eliminate runtime-skips: 29/29 E2E pass / 0 skip / 0 fail`
**Commits ahead of `main`**: 15
**Author**: Jirawatpyk (solo-maintainer per Constitution v1.4.0 § IX substitute)
**Scope**: MVP slice — US1 (member compose+submit) + US2 (admin review queue) only. US3–US6 deferred to Phase 5+.

---

## Ship Readiness Summary

| Check | Result |
|---|---|
| Tasks | 129/226 (57%) — Phase 1–4 (MVP slice) ≈ 100%; Phase 5–10 (US3–US6) explicit defer per Ultraplan |
| Latest verify-run | ✅ 0 CRITICAL / 0 HIGH / 0 MEDIUM / 3 LOW (G1+G2+H1 — all addressed) |
| Working tree at ship | Clean (commit `0950e6f` finalized) |
| Static gates | typecheck ✅ · lint ✅ (0 warnings) · check:i18n ✅ (1524 keys × 3 locales) · check:layout ✅ (66 page/loading pairs) |
| Test suites | **F7 totals: 37 files / 430 tests / 0 todo / 0 fixme / 0 skip** |
| Unit | 17 files / 234 tests pass |
| Contract | 7 files / 102 tests pass |
| Integration | 7 files / 65 tests pass (live Neon Singapore) |
| E2E | 6 files / 29 tests pass (chromium) |

## Changelog Entry

```markdown
## [F7 — Email Broadcast (E-Blast) — MVP slice US1+US2] - 2026-04-30

### Added — Member-side (US1)
- Compose page at `/portal/broadcasts/new` with Tiptap editor + segment picker + live preview pane
- POST `/api/broadcasts/draft` + PUT `/api/broadcasts/draft` (multi-draft; 30-day retention)
- DELETE `/api/broadcasts/draft/[id]` (idempotent)
- POST `/api/broadcasts/submit` with all 11 FR-002 a–k preconditions enforced
- POST `/api/broadcasts/[id]/cancel` (member-side cancel, FR-004a cutoff)
- GET `/api/broadcasts/quota` (typed counter envelope: used/reserved/remaining/cap/eblastPerYear/quotaYear/planCode/planId)
- Quota counter UI on compose page + `/portal/benefits/e-blasts`
- Strict-allowlist HTML sanitiser (FR-002a) — server-side authoritative
- 5,000 recipient hard cap (FR-016a) + DB CHECK constraint defence
- Custom-recipient validation against tenant graph (FR-015d)
- Self-exclusion (Q16) — requesting member's primary contact is auto-removed

### Added — Admin-side (US2)
- Admin review queue at `/admin/broadcasts` (TableContainer 96rem)
- Admin broadcast detail at `/admin/broadcasts/[id]` (DetailContainer 72rem)
- TanStack Table v8 + `@tanstack/react-virtual` virtualization (>100 rows)
- 9 new admin API routes: queue list, approve, reject, cancel, proxy-submit, sla-stats, halt-clear, member-cancel-bridge, cron dispatch
- 11 admin UI components: queue-table, queue-filters, status-badge, sla-banner, halt-state-banner, manager-readonly-banner, audit-timeline, review-actions, approve-dialog, reject-dialog, clear-halt-dialog
- 48-hour SLA banner with green/amber/red severity (FR-013)
- Q12 admin-on-behalf-of-member submission (dual-actor)
- Q14 halt-state banner + typed-phrase clear-halt confirmation
- Manager read-only role with persistent banner (FR-014)

### Added — Infrastructure
- 4 new DB tables: `broadcasts`, `broadcast_deliveries`, `marketing_unsubscribes`, `broadcast_segment_definitions` (RLS+FORCE)
- 2 new columns on F3 `members`: `broadcasts_halted_until_admin_review` (Q14) + `broadcasts_acknowledged_at` (Q15)
- 37 new audit event types (Migration 0072) — F7-owned with 5y retention
- 4 notification_outbox enum extensions (Migration 0073) — `broadcast_dispatch_pending` + 3 member notifications
- Resend Broadcasts API gateway (separate from F1/F4 transactional Resend)
- Email-transactional bridge for member notifications (F1+F4 outbox reuse)
- Cron dispatcher at `/api/cron/broadcasts/dispatch-scheduled` (5-min cadence via cron-job.org)
- Tiptap@3.22.5 + isomorphic-dompurify@2.36.0 + email-validator@^2 + @tanstack/react-virtual@^3
- `FEATURE_F7_BROADCASTS` kill-switch (NOW=true, was ship-dark until 2026-04-30)
- 3 new env vars: `RESEND_BROADCASTS_API_KEY` + `RESEND_BROADCASTS_WEBHOOK_SECRET` + `UNSUBSCRIBE_TOKEN_SECRET`

### Fixed (during F7=true rollout)
- 0074 — `broadcasts.requested_by_member_plan_id_snapshot` was uuid; F2 plan_id is text → schema mismatch caught + altered
- 0075 — `broadcasts_immutable_after_submit_fn` blocked `scheduled_for` change during submitted→approved transition; admin approve flow unblocked
- audit-timeline operator type mismatch (text = audit_event_type) → ANY array cast fixed
- audit-timeline timestamp string → `new Date()` coercion (postgres.js raw SQL doesn't auto-coerce)
- queue page barrel imports loading dompurify chain via composition root → lazy `require()` for read-only deps
- preview-pane SSR static-import of isomorphic-dompurify crashed Node 20 CJS loader → dynamic `await import()` inside `useEffect` (browser-only)
- pnpm overrides pin `jsdom@25 + whatwg-url@14 + html-encoding-sniffer@4` to bypass ESM-only `@exodus/bytes` chain in jsdom@28
- 0076 — DB↔TS audit-event enum drift (`broadcast_resend_audience_drift` + `broadcast_resend_drift_check_unverifiable` were in `F7_AUDIT_EVENT_TYPES` but not yet in Postgres `audit_event_type`); first emit would have thrown `invalid input value for enum`. Fixed via migration 0076 + manual `sql.unsafe()` apply on Neon (commit `12baa31`)
- `_journal.json` backfill — migrations 0074/0075/0076 were originally applied via direct `sql.unsafe()` outside `drizzle-kit migrate`, so `drizzle/migrations/meta/_journal.json` did not contain idx 74/75/76 entries; subsequent `pnpm db:migrate` runs would silently skip them. Backfilled the journal + the `drizzle.__drizzle_migrations` table (rows 92/93/94 with computed SHA-256 hashes matching Drizzle's algorithm) in commit `9ef6689`. Verified `pnpm db:migrate` runs clean against the synced state. **Future maintainers**: prefer running `pnpm db:migrate` (not direct `sql.unsafe()`) so the journal stays in sync automatically.

### Architecture decisions (resolved during /speckit.plan + Ultraplan)
- AD1: Two-phase Resend dispatch (status=approved + outbox enqueue → cron picks up → Resend call)
- AD2: Idempotency key `broadcast-{tenantId}-{broadcastId}` (no attempt counter — FR-020)
- AD3: Separate Resend Broadcasts client from F1+F4 transactional Resend
- AD4: send-now path uses `scheduledFor=now()` → cron dispatches within 60s
- AD8: 48h SLA stats endpoint `GET /api/admin/broadcasts/sla-stats` (PERCENTILE_CONT median + p95)
- AD9: TanStack Table v8 + react-virtual virtualization at >100 rows (per CHK039)
- AD10: Manager role gets `broadcast` + `read` (queue read-only) — admin gets full RW

### Constitution alignment (v1.4.0)
- Principle I (tenant isolation, NON-NEGOTIABLE): RLS+FORCE on all 4 F7 tables; cross-tenant probes test all 4×4 surfaces ✅
- Principle II (TDD, NON-NEGOTIABLE): 234 unit tests; 100% branch on security-critical paths (sha256-not-raw, halt-flag, dual-actor) ✅
- Principle III (Clean Architecture, NON-NEGOTIABLE): Module barrel + ESLint guard; F1 audit-log stays internal to F1 ✅
- Principle IV (PCI DSS): N/A (no payment surface) ✅
- Principle X (i18n): 1524 keys × EN/TH/SV at release ✅

### Known limitations (deferred — documented)
- US3 Member quota dashboard + history page — Phase 5 scope
- US4 Webhook delivery tracking + auto-halt on per-broadcast >5% complaint rate — Phase 6
- US5 Public unsubscribe page — Phase 7
- US6 Scheduled future-dated send improvements — Phase 8 (basic schedule path ships in US2)
- F6 EventAttendees stub — F7 ships with stub returning `[]`; F6 swaps in real Drizzle adapter at F6 ship
- F7 SV translations were originally `[F7-SV-REVIEW]` placeholders; auto-translated EN→SV via map during round-4 (256 keys). **Status as of 2026-04-30**: 0 placeholders remaining (`grep "F7-SV-REVIEW" src/i18n/messages/sv.json` returns 0); strings are production-shipped pending chamber TH/SV liaison content-quality sign-off at `/speckit.ship` gate
- isomorphic-dompurify ESM workaround documented in `docs/runbooks/f7-dompurify-esm-workaround.md` — track upstream for removal
```

## Bugs caught + fixed during F7=true rollout

| # | Bug | Root cause | Fix |
|---|---|---|---|
| 1 | `ERR_REQUIRE_ESM` on `/admin/broadcasts` page render | Barrel re-exports infra → loads `dompurifySanitizer` → `isomorphic-dompurify` → `jsdom@28` → `@exodus/bytes` ESM-only | Lazy `require()` in `broadcasts-deps.ts` for read-only deps |
| 2 | `ERR_REQUIRE_ESM` on `/portal/broadcasts/new` page render | `preview-pane.tsx` static-imports `isomorphic-dompurify` at module top → SSR pre-render crashes | Dynamic `await import()` inside `useEffect` (browser-only) |
| 3 | `ERR_REQUIRE_ESM` on POST `/api/broadcasts/submit` | Same chain as #1, server-side use case path | Lazy `require()` + pnpm overrides pinning jsdom@25 / whatwg-url@14 / html-encoding-sniffer@4 |
| 4 | `column "regular" does not exist` on broadcast INSERT | `broadcasts.requested_by_member_plan_id_snapshot` declared `uuid` but F2 `plan_id` is text | Migration 0074 — alter column to text |
| 5 | `broadcast_immutable_after_submit` raised on admin approve | DB trigger blocked `scheduled_for` change after status leaves draft, but FR-011 admin approve sets it during submitted→approved | Migration 0075 — loosen trigger to allow scheduled_for during submitted→approved only |
| 6 | `operator does not exist: text = audit_event_type` on audit-timeline | `event_type::text = ANY(...::audit_event_type[])` type mismatch | Switch RHS to `text[]` so LHS+RHS match |
| 7 | `r.timestamp.getTime is not a function` on audit-timeline | postgres.js raw SQL returns `timestamp` column as string, not Date | `new Date(r.timestamp)` coercion before `.getTime()` |

## Verify-run remediation (3 LOW findings from 2026-04-30)

- **G1**: pnpm overrides workaround documented at `docs/runbooks/f7-dompurify-esm-workaround.md` — covers removal criteria + verification commands ✅
- **G2**: `serverExternalPackages` documented inline in next.config.ts + the new runbook ✅
- **H1**: TanStack `useReactTable` lint warning suppressed via `eslint-disable-next-line react-hooks/incompatible-library` (matches F3 `members-table.tsx` project convention) ✅

## Migrations applied to live Neon Singapore

```
0064–0072  F7 schema baseline (tables + RLS + audit enum + retention default)
0073       notifications_outbox enum extension (4 broadcast notification types)
0074       broadcasts.requested_by_member_plan_id_snapshot uuid → text  ← runtime fix
0075       broadcasts_immutable_after_submit_fn loosened for submitted→approved  ← runtime fix
```

Re-applicable via `pnpm tsx scripts/apply-migration-0074.ts <migration.sql>`.

## Test counts (final)

```
Unit              17 files    234 tests   pass
Contract           7 files    102 tests   pass
Integration        7 files     65 tests   pass  (live Neon Singapore)
E2E                6 files     29 tests   pass  (chromium, --workers=1)
─────────────────────────────────────────────
Total F7          37 files    430 tests   pass / 0 todo / 0 fixme / 0 skip
```

## Performance budgets (per FR-013 / SC-002 / Q6)

- Compose page TTFB p95: not yet RUM-measured (deferred to /speckit.verify staging)
- Submit endpoint p95: < 1.2s budget — current dev-mode ≈ 600ms ✅
- Admin queue list p95 @ 1k pending: < 500ms — not yet load-tested
- Webhook handler p95: not yet measured (US4 surface)
- 48h review SLA: surfaced via banner, NO automated escalation in MVP (Q2 / FR-013)

## Outstanding (post-MVP / human-gated)

- US3 (T127+) member quota dashboard
- US4 webhook delivery tracking + 5% complaint rate auto-halt
- US5 public unsubscribe page
- US6 scheduled-send polish
- F6 EventAttendees real impl (batch-ship with F7)
- SV translations chamber-liaison review
- Production load test for SC-002 + SC-010 budgets
- Resend Broadcasts staging dry-run before main merge

## Next gates

1. `/speckit.review` — multi-reviewer cycle (≥2 reviewers; security-sensitive surface)
2. `/speckit.staff-review` — chamber liaison sign-off on TH/SV copy + admin UX
3. `/speckit.ship` — final go/no-go with full CI matrix + production rollout plan
