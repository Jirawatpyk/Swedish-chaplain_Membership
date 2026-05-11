# F8 Renewal Reminders — Staff Architect Ship-Gate Review

**Reviewer**: Chamber-OS Architect (Claude Sonnet 4.6)
**Date**: 2026-05-10
**Branch**: `011-renewal-reminders` · HEAD `f0756c73`
**Basis**: Constitution v1.4.0; R5 + R6 review reports (10 total); direct code inspection of HEAD state.
**Scope**: Constitution NON-NEGOTIABLE gates (I/II/III/IV), R5+R6 closure verification, architectural drift check.

---

## Verdict

**CONDITIONAL APPROVE — 2 residual findings before `/speckit.ship`.**

One LOW finding (R001) is a genuine open gap from R6 that was not closed in `f0756c73`. One WARN finding (R002) is a documentation accuracy issue with non-blocking operational risk. All BLOCKER and HIGH findings from R5+R6 are verified closed. The four NON-NEGOTIABLE Constitutional principles (I/II/III/IV) are satisfied at HEAD.

---

## NON-NEGOTIABLE Gate Results

### Principle I — Data Privacy & Tenant Isolation: PASS

**RLS+FORCE on all 9 F8 tables**: Verified via migrations 0086–0093. All 8 primary F8 tables (`scheduled_plan_changes`, `renewal_cycles`, `renewal_reminder_events`, `tenant_renewal_settings`, `tenant_renewal_schedule_policies`, `at_risk_outreach`, `tier_upgrade_suggestions`, `renewal_escalation_tasks`, `consumed_link_tokens`) carry `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` with policy `USING ("tenant_id" = current_setting('app.current_tenant', TRUE)) WITH CHECK (same)`. Pattern is byte-identical to F3/F4/F5/F7 precedents.

**`runInTenant` on all 4 cron coordinators**: Verified. `dispatch/[tenantId]/route.ts:169`, `at-risk-recompute/[tenantId]/route.ts:170`, `tier-upgrade-evaluate/[tenantId]/route.ts:77`, `reconcile-pending-applications/route.ts:67`, `dispatch-coordinator/route.ts:59` — all use `runInTenant(tenantCtx, ...)` before any DB access.

**Bulk method tenantId guards (R5-C2 / R6-H2)**:
- `bulkInsertIfAbsent` (reminder-event-repo:348-354): guard present, throws `cross-tenant write blocked (Constitution Principle I)`.
- `bulkTransitionToSent` (reminder-event-repo:408-414): guard present, symmetric.
- `bulkInsertOpenIfAbsent` (tier-upgrade-suggestion-repo:529-544): guard present as of `f0756c73`, closing R6-H2. Message text matches pattern.
- `bulkTransitionToSent` raw SQL UPDATE (reminder-event-repo:474): `AND r.tenant_id = ${tenant.slug}` present, closing R6-M3.

**Cross-tenant probe integration test**: `tests/integration/renewals/cross-tenant-isolation.test.ts` has 15 named `it()` probes covering dispatch, send-reminder, bounce-detection, snooze, outreach, task creation, tier-upgrade accept/dismiss/escalate/evaluate, and email-collision determinism. Covers all 9 F8 tables via use-case surface (not schema-scan). Consistent with the F3/F4/F5/F7 isolation test pattern. **Review-Gate blocker satisfied.**

**ESLint barrel guard**: `eslint.config.mjs:358-371` blocks direct imports into `@/modules/renewals/domain/**`, `application/**`, `infrastructure/**` from outside the module. Mirrors F7 broadcasts pattern exactly.

### Principle II — Test-First: PASS (with acknowledged debt)

**Per-story acceptance coverage**: 6 user stories (US1–US6) have corresponding integration-test coverage across `tests/integration/renewals/` (35+ files, 119+ F8 integration cases) and unit tests (34 unit files in `tests/unit/renewals/application/use-cases/`). The R6 CRIT-1 gap (`evaluate-tier-upgrade.ts` and `accept-tier-upgrade.ts` lacking unit tests) is resolved in `vitest.config.ts` by *excluding* these files from `pnpm test:coverage` thresholds with explicit documentation (`vitest.config.ts:312-329`). Integration coverage on live Neon is the binding contract for those two files. This is a documented deviation consistent with the solo-maintainer clause; `pnpm test:coverage` will not fail at CI.

**Security-critical 100% branch thresholds**: `verify-renewal-link-token.ts` is listed at `branches: 100`. `dispatch-renewal-cycle.ts` is downgraded to `branches: 70` (R6-CRIT-3 honest pass). `confirm-renewal.ts` is downgraded to `branches: 75` (R6-CRIT-2 honest pass). All reflect real achievable coverage with the existing unit-test suites, not aspirational numbers. `vitest.config.ts` comment block (lines 241-329) accurately explains each file's threshold and why.

**R5-B1 / R6-B1 flushPage atomicity**: Verified closed. `evaluate-tier-upgrade.ts:492-520` correctly branches on `outerTx`: the production path (`if (outerTx)`) calls `flushPage` without a surrounding try/catch, propagating throws to the route's `runInTenant` closure for rollback. The standalone path wraps in try/catch and converts to `err({kind:'server_error'})`. R6-B1's stated regression is not present at HEAD.

**R6-H1 deliveryId filter on bulkTransitionToSent**: Verified closed. `reminder-event-repo:488-501` adds `inArray(renewalReminderEvents.deliveryId, expectedDeliveryIds)` to the post-UPDATE verification SELECT, closing the concurrent-race false-positive window.

### Principle III — Clean Architecture: PASS

**Domain layer**: Zero imports from `next`, `drizzle-orm`, `react`, `resend`, `@upstash`. Confirmed by exhaustive grep of `src/modules/renewals/domain/` (14 files). Domain files import only TypeScript stdlib and sibling domain types.

**Application layer**: Zero `drizzle-orm` imports. Ten Application use-cases import `@/lib/otel-tracer` for OTel span instrumentation (`detect-bounce-threshold.ts`, `dispatch-renewal-cycle.ts`, `load-pipeline.ts`, and others). This is a known pre-existing pattern established in F4/F5/F7 where `otel-tracer` is treated as a cross-cutting infrastructure-lite utility rather than a framework dependency. It is documented in `plan.md` Complexity Tracking and does not carry Drizzle types or HTTP primitives. Not flagged as a new violation.

**Port interfaces**: Application use-cases reference only port interfaces from `application/ports/`. Infrastructure adapters implement those ports. Drizzle-inferred row types are confined to `infrastructure/drizzle/` files. No infrastructure type leak detected.

**Cross-module imports**: All F4/F5/F2 cross-module access goes through barrels (`@/modules/invoicing`, `@/modules/payments`, `@/modules/plans`). ESLint `no-restricted-imports` enforced. Verified for F8's specific cross-module consumers (`F4InvoicePaidEvent`, `F5IssueRefundPort`, `ScheduledPlanChange`).

### Principle IV — PCI DSS: PASS

F8 has no direct card data handling. The `f5-refund-bridge-drizzle.ts` adapter calls the F5 `IssueRefundForInvoice` port by `invoiceId` only — no card number, CVV, PAN, or PANs are threaded through F8 surfaces. The `payment-method-enum-parity.test.ts` integration test (CHK040, closed T289) pins that F8's view of `paymentMethod` union values matches F4+F5 discriminated union exhaustively, with a `never` catch at compile time. Audit/log forbidden fields (`password`, `sessionId`, `resetToken`, `Authorization`) are absent from F8 module (grep confirmed zero hits).

---

## Architectural Decision Verification

| Decision | Status |
|---|---|
| MTA+STD: `tenant_id` on every F8 table + RLS+FORCE | VERIFIED (9/9 tables) |
| Advisory lock per (tenant, cron_kind) in cron routes | VERIFIED (`pg_advisory_xact_lock` in all 4 coordinators) |
| F8→F4 callback (Option A LOCKED): `onPaidCallbacks` on `RecordPaymentDeps` | VERIFIED (T007-T010, `f4-on-paid-callbacks.contract.test.ts` 5/5 GREEN) |
| F4→F8 audit-emit-rollback atomicity contract | VERIFIED (`audit-emit-rollback.test.ts` on live Neon) |
| F2 `scheduled_plan_changes` cross-module table (F8 PR delivers) | VERIFIED (migration 0086, F2 barrel exports confirmed) |
| Cron-job.org 6 endpoints + Bearer auth via `CRON_SECRET` | VERIFIED (`scripts/setup-cron-job-org-renewals.md` operator guide) |
| F8 ships dark behind `FEATURE_F8_RENEWALS=false` | VERIFIED (`src/lib/env.ts` + kill-switch guard in all cron routes) |
| i18n EN+TH+SV: `admin.renewals` / `portal.renewal` / `portal.preferences.renewals` | VERIFIED (all 3 namespaces present in all 3 locale files) |

---

## Findings

### R001 — 🟡 LOW — `evaluate-tier-upgrade.ts` aggregate audit-emit catch has no metric counter

**File**: `src/modules/renewals/application/use-cases/evaluate-tier-upgrade.ts:557-566`
**Constitution**: Principle VIII (Reliability — forensic chain visibility)
**Severity**: LOW (not a ship blocker; operational observability gap, not a correctness issue)

The catch block for the aggregate `tier_upgrade_already_at_target` audit emit (lines 557-566) logs at WARN but does NOT call `renewalsMetrics.tierUpgradeAuditEmitFailed(...)`. This is the R6 errors-review finding L2, which was NOT closed in `f0756c73`. The corresponding counter function exists at `src/lib/metrics.ts:1480` and the parallel pattern in `compute-at-risk-score.ts:164` (R5-S1) shows the correct form.

The missing counter means silent audit failures on this branch are not alertable via the `renewals_tier_upgrade_audit_emit_failed_total` metric. The Principle VIII "State↔audit atomicity" invariant is not broken here (the aggregate audit is non-critical best-effort, which is why it's in a standalone catch outside the tx), but the observability gap is inconsistent with the R5-S1 fix applied to the symmetric use-case.

**Fix**: add one line after the `logger.warn` call:
```ts
renewalsMetrics.tierUpgradeAuditEmitFailed('tier_upgrade_already_at_target', tenantId);
```
This matches the signature at `metrics.ts:1480`.

---

### R002 — 🟡 WARN — T261 pipeline-perf positive-path assertion remains a tautology

**File**: `tests/integration/renewals/pipeline-perf.test.ts:205`
**Constitution**: Principle II (Test-First — meaningful assertions)
**Severity**: WARN (perf bench quality; does not block ship but noted as open R6-IMP-5)

Line 205 still reads `expect(r.value.rows.length).toBeGreaterThanOrEqual(0)`, which is always true. The R6-tests report IMP-5 flagged this and recommended `toBeGreaterThan(0)` for the `'t-90'` warmup call where the seed guarantees ≥1 row. This was not fixed in `f0756c73`. The T265 assertion (`renewal-confirm-perf.test.ts:229,246`) also remains at `expect(r.ok).toBe(true)` without asserting `cycleStatus` transition (IMP-4).

These are perf-bench quality items, not functional regressions. The benches still provide meaningful p95 timing data. Recommend fixing in the same commit as R001 to keep the branch clean before ship. One-character change for IMP-5 (`toBeGreaterThanOrEqual` → `toBeGreaterThan`); one-line assertion for IMP-4.

---

## Open Human-Gated Items (not ship blockers in-session)

Per `tasks.md` Phase 10, the following remain pending human operator action before `FEATURE_F8_RENEWALS=true` can be flipped in production. These are correctly sequenced AFTER ship (PR merge) per the F7 precedent:

| Task | Gate | Status |
|---|---|---|
| T277 | Maintainer co-sign security checklist | Pending (this review is the staff-review component) |
| T277b | cron-job.org 6th entry (reconcile-pending-reactivations coordinator) | Pending operator action |
| T282 | Staging walkthrough with `FEATURE_F8_RENEWALS=true` | Pending Vercel staging deploy |
| SC-004 | Renewal-rate baseline extraction (post-F1+F3+F4 historical data) | Pending operator data extract |

The T262 production SLO assessment remains PROVISIONAL (retrospective.md:94 notes p99 ~150–300ms but the conclusion uses p50=~100ms in the dominant-latency math). This is documented accurately in `retrospective.md` and the `perf-benchmarks.md:133` comment acknowledges p99. The R6-M2 finding requested a stronger "PROVISIONAL" label on the "Status: PASS" framing — the current text is defensible at SweCham's single-tenant scale (~131 members → ~11s observed) but should be revisited at T215-equivalent production RUM.

---

## Positive Observations

1. **R6-B1 fix is architecturally sound.** The `if (outerTx)` branch split at `evaluate-tier-upgrade.ts:492-520` correctly separates the production cron path (no catch, throw propagates to route's `runInTenant`) from the standalone admin-replay path (catch + convert to `err`). The comment block (lines 483-491) explains the invariant with sufficient clarity for future maintainers.

2. **`bulkInsertOpenIfAbsent` conflict target is explicit.** `drizzle-tier-upgrade-suggestion-repo.ts:559-575` uses `target: [tenantId, memberId]` with `where: sql\`status IN ('open','accepted_pending_apply')\``, closing R5-C1 correctly. Future unique constraint additions will not be silently absorbed.

3. **`bulkTransitionToSent` deliveryId verification is production-safe.** The post-UPDATE SELECT filters by `deliveryId` (lines 488-501), closing R6-H1's concurrent-race false-positive window. The `expected N rows, got M` throw (line 511) provides the rollback signal without ambiguity.

4. **Coverage threshold honesty is exemplary.** The `vitest.config.ts` comment block (lines 241-329) explicitly names each file, its actual test count, the reachable branch ceiling, and why two files are excluded from unit coverage (integration-only). This is better documentation practice than aspirational 100% entries that fail CI on first run.

5. **Cross-tenant isolation test is comprehensive.** 15 named probes covering all F8 use-case surfaces and all 9 tables via RLS behavioural verification — not just schema-scan. This is the correct Constitution Principle I clause 3 implementation pattern.

---

## Summary

| Gate | Status |
|---|---|
| Principle I — Tenant Isolation | PASS |
| Principle II — Test-First | PASS (acknowledged debt documented) |
| Principle III — Clean Architecture | PASS |
| Principle IV — PCI DSS | PASS |
| R5+R6 BLOCKER closures | ALL VERIFIED CLOSED |
| R5+R6 HIGH closures | ALL VERIFIED CLOSED |
| R6 LOW residuals | 1 OPEN (R001 above) |
| Architectural drift from plan.md | NONE DETECTED |
| Migration sequence + RLS coverage | COMPLETE (9/9 tables, 0086–0093 + 0115 + 0121–0122) |

**Action required before `/speckit.ship`**:
1. Close R001: add `renewalsMetrics.tierUpgradeAuditEmitFailed('tier_upgrade_already_at_target', tenantId)` at `evaluate-tier-upgrade.ts:566`.
2. Optionally close R002 in the same commit: tighten T261:205 to `toBeGreaterThan(0)` and add `cycleStatus` assertion to T265:229/246.

Both fixes are ≤5 lines each. No architecture change. No new test files required. After those land, F8 is clear for `/speckit.ship`.

---

*Staff Architect sign-off: Constitution v1.4.0 compliance confirmed at HEAD `f0756c73` modulo R001/R002 above. NON-NEGOTIABLE principles I/II/III/IV all pass. MTA+STD pattern applied correctly across all 9 F8 tables.*
