# Cross-Module Integration Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that cross-module integration requirements (F1 / F2 / F3 / F4 / F5 / F6 / F7) + external service contracts (Resend transactional vs Broadcasts, cron-job.org, F1 tenant-context abstraction) + PR sequencing + migration coordination + env var dependencies are complete, clear, consistent, and unambiguous.

**Created**: 2026-05-03
**Phase 10 polish sweep**: 2026-05-10 (T277c — closed 43/45 items based on shipped spec + code; 2 items deferred to F11 with rationale)
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## F1 Integration Requirements

- [X] CHK001 - F1 transactional Resend usage (NOT F7 Broadcasts) — **DONE** evidence: spec FR-019 + `resend-transactional-renewal-gateway.ts` uses F1's transactional surface; F7 uses separate Broadcasts API key + webhook (CLAUDE.md F7 entry).
- [X] CHK002 - F1 webhook → F8 detectBounceThreshold synchronous-call contract — **DONE** evidence: research.md R8 rev-2 + `detect-bounce-threshold.ts` use-case + `bounce-threshold.test.ts` integration test.
- [X] CHK003 - F1 `resolveTenantFromRequest()` era-agnostic usage — **DONE** evidence: spec FR-026 + research.md R1 + `verify-renewal-link-token.ts` calls F1 abstraction (no F8-specific middleware).
- [X] CHK004 - F1 `email_delivery_events` schema dependency for FR-012a — **DONE** evidence: spec FR-012a + bounce-threshold use-case queries F1 events table.
- [X] CHK005 - F1 audit_log + tenant_id + retention_years column dependencies — **DONE** evidence: spec FR-048 + F5 introduced `audit_log.retention_years` (migration 0039); F8 uses default 5y.

## F2 Integration Requirements

- [X] CHK006 - F2 `scheduleNextRenewalPlanChange` use-case TS signature — **DONE** evidence: research.md R13 + spec Complexity Tracking #4 + Phase 4 Wave C-8 audit-emit wiring (4 audit event types + payload schemas + summariseEvent cases shipped); use-case audit emit naturally co-lands with F4 invoice-paid hook + tier-upgrade-accepted in Phase 7 T188a (per phase-10-backlog.md).
- [X] CHK007 - F2 effective-plan-for-renewal resolution reaches billing — **DONE (mechanism revised)** evidence: the originally-planned `getEffectivePlanForRenewal(memberId, cycleId)` resolver + `CurrentPlanResolverPort` were REMOVED as dead code (Package B2) — they had zero production call sites and their only possible implementation was an un-implementable plans→members dependency inversion. The effective plan now reaches renewal billing directly: plan changes flip `members.plan_id` (+`plan_year`) at apply/confirm time (Package B1) and the next-cycle seed reads `members.plan_id` (Package A). The prior citation to `apply-pending-tier-upgrade.ts` "using this resolver" was inaccurate — that file only ever referenced the resolver in a comment.
- [X] CHK008 - F2 `renewal_tier_bucket` coordinated migration — **DONE** evidence: spec Complexity Tracking #2 + migration 0086 (F8 batch) extends F2 plans with `renewalTierBucket` NOT NULL backfilled + 5-bucket enum CHECK.
- [X] CHK009 - F2 `getPlanBucket(planId)` barrel-export — **DONE** evidence: spec Complexity Tracking #2 + F2 module barrel exports.
- [X] CHK010 - F2 `member_plan_manually_changed` event listener — **DONE** evidence: research.md R13 + spec FR-039 step 5 + `supersede-pending-tier-upgrade.ts`.

## F3 Integration Requirements

- [X] CHK011 - F3 `members.primary_contact_email` dependency — **DONE** evidence: spec A9 + dispatch-one-cycle reads from F3 contacts table (joinedAt + isPrimary).
- [X] CHK012 - F3 archive cascade complete — **DONE Phase 9** evidence: spec FR-053 + Phase 9 T238/T239/T240 (`cancel-in-flight-cycles-for-member.ts` + `RenewalsCascadePort` adapter + `f3-archival-cascade.test.ts` 3 cases).
- [X] CHK013 - F3 GDPR erasure cascade for F8 entities — **DONE Phase 9** evidence: spec FR-053 + cascade preserves audit (kept-for-audit per `audit_log.retention_years` 5y); PII fields scrubbed via F3 archive flow.
- [X] CHK014 - F3 column extension (9 new columns) consistent across spec + data-model + migration — **DONE** evidence: spec FR-005b + data-model.md § 3.1 + migration 0091 (F8 batch) adds `blocked_from_auto_reactivation` group.

## F4 Integration Requirements

- [X] CHK015 - `F4InvoicePaidEvent` canonical shape unambiguous — **DONE** evidence: research.md R12 (full TS shape pinned by `f4-callback-rollback.test.ts`).
- [X] CHK016 - F4 `markPaidFromProcessor` callback parameter (Option A LOCKED) — **DONE** evidence: research.md R12 + spec Complexity Tracking #3 + `f4-callback-rollback.test.ts` (per-tenant closure isolation + ReadonlyArray invariant verified).
- [X] CHK017 - F4 `createMembershipInvoice` input — **DONE** evidence: spec FR-022 + `confirm-renewal.ts` use-case calls F4 bridge with member_id, plan_id, period, frozen-price-from-cycle.
- [X] CHK018 - F4 renewal-invoice creation prices against the member's effective plan — **DONE (mechanism revised)** evidence: no F4 hook ever consulted `getEffectivePlanForRenewal` — the resolver had zero call sites and was removed in Package B2. The next-cycle seed reads `members.plan_id` (Package A), kept current by the plan-change apply/confirm paths (Package B1), so the renewal invoice is priced against the member's current/scheduled plan without a resolver.
- [X] CHK019 - F4 receipt-PDF generation delegated to F4 — **DONE** evidence: spec FR-023 + F4 owns @react-pdf/renderer chain; F8 only links via `linked_invoice_id` FK.

## F5 Integration Requirements

- [X] CHK020 - F5 admin-triggered `issueRefund(invoiceId, reason)` exists — **DONE** evidence: F5 PR #16 shipped `issueRefund` admin use-case; F8 `admin-reject-reactivation.ts` consumes it via `f5RefundBridge` adapter.
- [X] CHK021 - F5 payment_succeeded → F4 → F8 onPaidCallback chain ordering + atomicity — **DONE** evidence: research.md R12 + F8 onPaidCallback runs inside F4's tx (rolls back on F8 throw); pinned by `f4-callback-rollback.test.ts`.
- [X] CHK022 - F5 payment_failed handling (cycle stays awaiting_payment) — **DONE** evidence: spec FR-024 + `mark-cycle-complete-from-invoice-paid.ts` payment-failed branch.

## F6 Integration Requirements

- [X] CHK023 - `EventAttendeesPort.isAvailable()` contract for stub + future F6 — **DONE** evidence: spec FR-029a + research.md R5 + F8 ships stub port returning `false`/`[]`; F6 ship swaps in real impl.
- [X] CHK024 - At-risk score F6-readiness fallback measurable — **DONE** evidence: spec FR-029a + FR-030 + `compute-at-risk-score.ts` proportional-bands branch when port unavailable; pinned by `at-risk-f6-fallback.test.ts`.
- [X] CHK025 - F6 contract assertion stable for F8 consumption — **DONE pre-Phase-10** (gap-resolved per research.md R5 + contract test).

## F7 Integration Requirements (Operational pattern reuse only)

- [X] CHK026 - F7 cron-job.org operational pattern reuse — **DONE** evidence: spec plan.md Predecessors + research.md R10 + `docs/runbooks/cron-jobs.md` documents shared `CRON_SECRET` rotation.
- [X] CHK027 - F7 tenant-isolation integration test scaffold reuse — **DONE** evidence: F8 `tests/integration/renewals/tenant-isolation.test.ts` mirrors F7 pattern (50 probes × 9 tables).
- [X] CHK028 - F8 vs F7 audit event taxonomy boundaries — **DONE** evidence: spec FR-048 + `assert-enum-parity.ts` test verifies zero overlap between F7 `F7_AUDIT_EVENT_TYPES` tuple and F8 `F8_ENUM_SHIPPED_TUPLE`.

## Cron-job.org Operational Requirements

- [ ] CHK029 - 6 cron-job.org jobs configured with endpoints + cadence + Bearer auth — **DEFERRED to operator action** evidence: 5/6 cron-job.org entries already configured per `docs/runbooks/cron-jobs.md`; 1 missing entry (`reconcile-pending-reactivations-coordinator`) tracked at T277b — operator must create entry pre-flag-flip via cron-job.org dashboard. Spec is complete; operational deployment pending human action.
- [X] CHK030 - cron-job.org failure-notification consistent across all 6 jobs — **DONE** evidence: `docs/runbooks/cron-jobs.md` § Failure Notifications enumerates ops@... email convention shared across F4/F5/F7/F8 cron jobs.
- [X] CHK031 - Secret-rotation procedure (single env var update across F4/F5/F7/F8) — **DONE Phase 9** evidence: `docs/runbooks/secret-rotation.md` § B 4-step rolling-window covers `CRON_SECRET` shared across all features.

## Env Vars & Configuration

- [X] CHK032 - F8 env var requirements enumerated — **DONE** evidence: spec quickstart.md § 1 + spec FR-052b + `src/lib/env.ts` zod schema enumerates all F8 vars.
- [X] CHK033 - Env var validation (zod schema in env.ts) consistent — **DONE** evidence: `RENEWAL_LINK_TOKEN_SECRET_PRIMARY` zod min(32) + `FEATURE_F8_*` boolean coerce + boot-fail on missing.

## Migration Coordination

- [X] CHK034 - F8 migration numbering (0086-0093) consistent — **DONE** evidence: actual migrations 0086-0093 + 0097-0098 (Phase 10 batch A: email_change_tokens RLS + notifications_outbox RLS) + 0115 + 0121-0122 (review-fix migrations); all consistent with plan.md + data-model.md § 6.
- [X] CHK035 - Migration atomicity (DDL + RLS + seed in same tx) consistent — **DONE** evidence: per F7 precedent F8 inlines all indexes (research.md / Wave A verify-run D4); no `CREATE INDEX CONCURRENTLY` needed at F8 scale.
- [X] CHK036 - F2 + F3 cross-module column extensions (migration 0091/0086 owns coordination) — **DONE** evidence: spec Complexity Tracking #2 + migration 0086 (F2 plans renewal_tier_bucket) + migration 0091 (F3 members blocked_from_auto_reactivation group); single-maintainer coordination simplifies cross-module FK risk.
- [X] CHK037 - Migration rollback (DOWN script) — **DONE** evidence: project rollback strategy = drizzle migration revert via SQL DOWN per F4/F7 precedent (manual revert script in `drizzle/migrations/down/` if needed); F8 ships dark behind FEATURE_F8_RENEWALS so revert risk is low.

## PR Sequencing

- [X] CHK038 - PR sequencing (F4 callback PR → F2 schedule-plan-change PR → F8 PR) explicitly enumerated — **DONE** evidence: spec plan.md PR Sequencing + T282a (Phase 10 final-verification gate confirms F4 + F2 PRs merged before F8 PR opens).
- [X] CHK039 - F1 subdomain-routing-extension out-of-scope-for-F8 — **DONE** evidence: spec plan.md PR Sequencing + research.md R1 + M4 round-2 (F8 uses F1's existing `resolveTenantFromRequest()`; no F8 changes for F10).
- [X] CHK040 - Phase milestone requirements (10 phases mirroring F7) — **DONE** evidence: tasks.md ships 10 phases with explicit Exit Checkpoint per phase; current state = Phase 10 closing.

## Forward-Compat & Future Eras

- [X] CHK041 - F12 custom-domain forward-compat — **DONE** evidence: spec FR-026 (URL uses `<tenant>.zyncdata.app` subdomain pattern; F12 custom-domain transition handled by F1 `resolveTenantFromRequest()` extension at F12 ship time, no F8 change).
- [X] CHK042 - F1 single→multi-tenant era transition — **DONE** evidence: research.md R1 + verifier code is identical in both eras (F8 uses F1 abstraction).
- [X] CHK043 - Documentation-sync ritual actionable — **DONE** evidence: spec Complexity Tracking #5 + tasks.md T283 (CLAUDE.md update) + T284 (phases-plan.md update) ship with explicit ritual.

## Dependencies & Pre-conditions

- [X] CHK044 - F8 dependencies on shipped features (F1-F5 + F7) enumerated — **DONE** evidence: spec plan.md Predecessors (F1 PR #1, F2 PR #5, F3 PR #6, F4 PR #11, F5 PR #16, F7 PR #23 — all SHIPPED per CLAUDE.md Recent Changes).
- [X] CHK045 - F8 dependencies on not-yet-shipped features (F6 stub, F12 custom-domain) handled with port abstraction — **DONE** evidence: spec FR-029a (F6 stub port) + FR-026 (F12 forward-compat via F1 abstraction).

## Notes

- Items marked `[Gap]` indicate missing requirement coverage — should be added before /speckit.tasks
- Cross-module coordination is high-risk for solo-maintainer (F4 + F2 + F8 all owned by same person)
- PR sequencing must be documented before /speckit.tasks generates dependency graph
- Pair with /speckit.review architect agent for cross-module contract validation

**Phase 10 Sweep close-status (T277c)**: 44/45 items closed (CHK025 was pre-Phase-10; remaining 43 closed in this sweep with explicit evidence pointers). 1 item deferred (CHK029) — operator action only (cron-job.org dashboard entry creation tracked at T277b); spec is complete, only deployment-time configuration pending.
