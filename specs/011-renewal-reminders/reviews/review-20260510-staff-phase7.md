# Staff-Engineer Review — F8 Phase 7 (US5 Auto Tier-Upgrade Suggestions)

**Feature**: F8 Renewal Reminders | **Branch**: `011-renewal-reminders` | **Phase**: 7 (US5)
**Reviewer**: Claude (synthesized from 6 specialist agents — chamber-os-architect, drizzle-migration-reviewer, reliability-guardian, security-threat-modeler, senior-tester, i18n-translation-reviewer)
**Generated**: 2026-05-10
**Commit range**: `647f9946..01631d0b` (Phase 7 close → before Phase 8 starts at `38981048`)
**Scope**: T179–T207 — 30 tasks · ~9,610 LOC across 98 files
**Constitution baseline**: v1.4.0

---

## 1. Executive Summary

### Verdict: ❌ **CHANGES REQUIRED**

Phase 7 is functionally rich and well-architected — `acceptTierUpgrade` exhaustiveness pinning, F8→F2/F4 bridge atomicity discipline, and audit-event taxonomy are all best-in-class. The Round 1–5 review-fix cycle (43 → 26 → 25 → 22 → 25 findings closed) materially improved code quality vs the initial drop. **However, a Constitution Principle I clause 3 Review-Gate blocker remains open: zero cross-tenant integration probes for the 5 new use-cases**.

Three independent reviewers (architect, drizzle-migration-reviewer, senior-tester) flagged the same gap from different angles. Two acceptance scenarios (AS3 dismiss + the escalate flow) lack any integration coverage at all — tested only as pre-seeded state or via unit-level error class. With Constitution Principle II (TDD NON-NEG) requiring ≥1 acceptance test per user story, AS3 + escalate fall short.

Six additional Warning-class items concentrate around: (a) nested `runInTenant` semantics under Neon HTTP driver in the evaluate cron, (b) Manager-role bypass at the API layer for the queue list, (c) unsanitized exception messages reaching audit_log, and (d) DoS surface on the unbounded `?limit=` parameter.

**Recommended path**: open Round 6 review-fix; address the 3 Blockers (probes + dismiss/escalate integration tests) and 6 high-priority Warnings; re-review and ship.

### Strengths (top 5)

1. **GatewayResult exhaustiveness pinning** in `accept-tier-upgrade.ts` — compile-time mutual-subtype assertion + runtime `_exhaustive: never` throw. Defence-in-depth against deploy-skew arm additions; best pattern observed in this codebase.
2. **F8→F2 bridge with explicit failure isolation** (`f2-plan-change-bridge.ts`) — `wrapListener` documented trade-off (plan-flip reliability vs supersede atomicity) is a correct architectural priority ordering. `reconcilePendingApplications` cron is the documented backstop.
3. **F8→F4 hook atomicity** (`applyPendingTierUpgradeInTx`) — accepts external `TenantTx`, no nested tx, brand-checked, with degraded-fallback path and observability counters.
4. **Audit completeness for the email path** — `tier_upgrade_pending_member_notified` only emitted on send-success; 4 distinct audit branches (`no_recipient` / `sent` / `failed` / `threw`); Resend error sanitization via `sanitizeResendErrorMessage`.
5. **Migration discipline** — 17 enum values shipped across 0116/0118/0119/0120 all use `IF NOT EXISTS`; pgEnum + `F8_ENUM_SHIPPED_TUPLE` + `F8_AUDIT_EVENT_TYPES` exhaustiveness assertion (count=64) compiles green; journal monotonic.

### Risks (top 5)

1. **Review-Gate blocker (cross-tenant probes absent)** — see §3 F-001.
2. **AS3 dismiss + escalate use-cases untested at integration layer** — `dismissTierUpgrade` and `escalateTierUpgrade` exercised only via unit-error classes / pre-seeded state. Constitution Principle II miss.
3. **Nested `runInTenant` under outer advisory-lock tx in evaluate cron** — Neon HTTP driver semantics could place suggestion inserts outside the RLS session that holds the lock. Audit log writes might bypass tenant scoping.
4. **Manager role can hit `GET /api/admin/renewals/tier-upgrades` directly** — UI redirects manager away, but raw API allows `action:'read'` so manager bypass at the HTTP boundary. FR-052a was meant to be admin-only for this surface.
5. **Audit flood from `tier_upgrade_already_at_target`** — emitted per-member (5,000 rows/week for a 5k-member tenant) instead of aggregated like the `tenant_disabled` / `no_thresholds_configured` siblings. Write amplification + audit-log retention cost.

---

## 2. Spec Coverage Matrix

| Requirement | Implementation | Tests | Status |
|---|---|---|---|
| **AS1** Regular member 120M → suggestion + idempotent | `evaluateTierUpgrade` + partial UNIQUE `member_open` | `tier-upgrade-evaluate.test.ts` happy + idempotent | ✅ |
| **AS2** Admin Accept → F2 plan-change + email + audit | `acceptTierUpgrade` + `f2-plan-change-bridge` + Resend | `tier-upgrade-pending.test.ts` accept happy + email | ✅ |
| **AS3** Admin Dismiss + 90d cooldown | `dismissTierUpgrade` | **GAP**: only suppression-side tested (pre-seeded `dismissed` row). Use-case itself has zero integration test | ⚠️ PARTIAL → 🔴 |
| **AS4** Member already at target → no suggestion + audit | `evaluateTierUpgrade` (already_at_target branch) | `tier-upgrade-evaluate.test.ts` already-on-highest | ✅ |
| **AS5** Tenant no-thresholds → audit + cron continues | `evaluateTierUpgrade` (no-thresholds branch) | `tier-upgrade-evaluate.test.ts` no-thresholds + R3-IMP-8 | ✅ |
| **AS6** `auto_upgrade_enabled=false` → tenant skipped | `evaluateTierUpgrade` (tenant-disabled branch) | `tier-upgrade-evaluate.test.ts` tenant-disabled | ✅ |
| **FR-037** Weekly cron `/api/cron/renewals/tier-upgrade-evaluate` | coordinator + per-tenant routes | T202 5/5 GREEN | ✅ |
| **FR-038** Insert TierUpgradeSuggestion on qualify | use-case + audit | covered | ✅ |
| **FR-039** TierUpgradePending flow on Accept | T-180 task + email + apply-at-renewal | T203 5/5 GREEN | ✅ |
| **FR-040** Never auto-applied — admin-required | route handlers gated | T194/T197 admin role gate | ✅ |
| **FR-041** Tenant disable via settings | branch + audit | T202 tenant-disabled | ✅ |
| **FR-042** Auto-DOWNGRADE OOS | not implemented (correct) | n/a | ✅ |
| **FR-052a** Admin-only mutating CTAs | route gates + UI redirect | **GAP**: GET list allows manager via `action:'read'` | ⚠️ → see T-03 |
| **Principle I clause 3** Cross-tenant integration test | RLS + runInTenant + DB-layer probes (existing) | **GAP**: Phase 7 tier-upgrade application-layer probes absent | 🔴 → see F-001 |

**Coverage**: 6/6 ASes covered structurally; 1/6 (AS3 dismiss) demoted from ✅ to 🔴 because integration test absent.

---

## 3. Findings

### 🔴 Blockers (Review-Gate)

#### F-001 | Constitution Principle I clause 3 — Cross-tenant integration probes absent for Phase 7 tier-upgrade surfaces

**Files**: `tests/integration/renewals/cross-tenant-isolation.test.ts` (no `tier-upgrade` describe block).
**Impact**: Three independent reviewers flagged this. RLS policy on `tier_upgrade_suggestions` is verified at the DB-layer (`tenant-isolation.test.ts` Section 7), but Constitution Principle I clause 2 mandates **two-layer (application + database)** isolation testing — application-layer use-case probes for the 5 new entrypoints are absent.

**Required probes** (minimum):
1. `acceptTierUpgrade(tenantA-ctx, suggestionId=tenantB)` → `error.kind='suggestion_not_found'` + B's row unchanged.
2. `dismissTierUpgrade(tenantA-ctx, suggestionId=tenantB)` → `error.kind='suggestion_not_found'`.
3. `escalateTierUpgrade(tenantA-ctx, suggestionId=tenantB)` → `error.kind='suggestion_not_found'`.
4. `evaluateTierUpgrade(tenantA-ctx)` → tenant B's `tier_upgrade_suggestions` count remains 0 + B's members untouched.

These use-cases do **not** emit `renewal_cross_tenant_probe` audits (by design — the `findById(tenantId, suggestionId)` predicate combined with RLS makes the row simply invisible). Tests therefore must assert on post-condition state, not on audit emission.

**Recommendation**: Add `describe('tier-upgrade cross-tenant probes (Phase 7)')` block after the Phase 8 escalation-task section in `cross-tenant-isolation.test.ts`. Estimated effort: 1–2 hours.

---

#### F-002 | Principle II — `dismissTierUpgrade` has zero integration test

**Files**: `src/modules/renewals/application/use-cases/dismiss-tier-upgrade.ts` (untested at integration layer).
**Impact**: AS3 ("Admin Dismiss with reason → status=dismissed + suppressed_until=today+90d + audit `tier_upgrade_dismissed`") is currently covered only by seeding a pre-existing `dismissed` row in `tier-upgrade-evaluate.test.ts` and verifying the cron's suppression branch. The use-case's `open→dismissed` transition, `suppressed_until` write, and audit emit are not exercised against live Neon.

**Recommendation**: Add a `tier-upgrade-dismiss.test.ts` (or extend `tier-upgrade-pending.test.ts`) with at least 3 cases: dismiss happy path, dismiss with reason, dismiss-when-already-dismissed (re-dismiss attempt → error or no-op).

---

#### F-003 | Principle II — `escalateTierUpgrade` has zero integration test

**Files**: `src/modules/renewals/application/use-cases/escalate-tier-upgrade.ts` (untested at integration layer).
**Impact**: T182 documents that escalate inserts an `at_risk_outreach` row keyed to the suggestion's member with `template_id='tier_upgrade_escalation_<reasonCode>'` and reuses `at_risk_outreach_recorded` audit. No integration test exercises this — only the unit-level error class is in `ports.test.ts`.

**Recommendation**: Add an integration case: call `escalateTierUpgrade` → assert `at_risk_outreach` row inserted with the correct `template_id` discriminator + `at_risk_outreach_recorded` audit emitted.

---

### 🟡 Warnings (Should fix before ship)

#### W-001 | Reliability — Nested `runInTenant` under outer advisory-lock tx in evaluate cron

**Files**: `src/app/api/cron/renewals/tier-upgrade-evaluate/[tenantId]/route.ts:77-86` + `evaluate-tier-upgrade.ts:330`.
**Impact**: Route opens `runInTenant` to acquire `pg_advisory_xact_lock`, then calls `evaluateTierUpgrade` which opens `runInTenant` again per insert. On Neon HTTP driver, nested `BEGIN` is rejected/no-op — suggestion inserts may bypass the RLS session that holds the lock.
**Recommendation**: Either (a) hoist lock acquisition into a one-shot tx that does the lock + commit immediately while we hold a session-level `pg_advisory_lock`, then call `evaluateTierUpgrade` with its own tx, or (b) thread the locked tx through `deps` and use it directly inside the use-case loop. Add a test that asserts inserts happen under the locked session (e.g., assert `current_setting('app.current_tenant')` is non-null inside the loop).

#### W-002 | Reliability — `wrapListener` swallows supersede failure → orphan undetected by reconcile cron

**Files**: `src/modules/renewals/infrastructure/ports-adapters/f2-plan-change-bridge.ts:77-97` + `reconcile-pending-applications.ts:listOrphanedPending`.
**Impact**: `wrapListener` catch+swallow preserves F3 plan-flip intent (correct trade-off), but if `supersedePendingTierUpgradeInTx` throws after F3 commits, the suggestion stays in `accepted_pending_apply` for a member whose `members.plan_id` is now a different tier. `reconcilePendingApplications.listOrphanedPending` filters by `cycle.status IN ('cancelled','lapsed')` — the cycle is still active → cron won't catch this orphan → F4 onPaidCallback at next renewal applies a stale tier-upgrade decision.
**Recommendation**: Extend `listOrphanedPending` to also detect `accepted_pending_apply` suggestions where `members.plan_id !== suggestion.toPlanId AND members.plan_id !== suggestion.fromPlanId` (plan changed manually after Accept). Alternatively, emit `tier_upgrade_supersede_failed` audit event in the catch block and have reconcile cron query that audit stream. Add an alert rule on `manualPlanChangeListenerFailed{listener='supersede'} > 0`.

#### W-003 | Security (T-03) — Manager bypasses admin-only queue list at API layer

**Files**: `src/app/api/admin/renewals/tier-upgrades/route.ts` (GET).
**Impact**: Route passes `action:'read'` to `requireRenewalAdminContext`, which permits both admin AND manager. UI redirect blocks manager from the page, but raw API access by manager succeeds — FR-052a violation. Although manager has full read-only on F8 surfaces in general, the queue list's mutating CTAs are admin-only and FR-052a §1 specifies "tier-upgrade queue ... full read-only" — but the spec earlier (§7-q-3) permits manager read on the queue. **This is a spec ambiguity**.
**Recommendation**: Either (a) accept manager read access (then the UI redirect should be removed for consistency) OR (b) explicitly block manager in the route handler with `if (current.user.role !== 'admin') return 403`. **Open question**: clarify with PM whether manager can SEE the tier-upgrade queue read-only or is locked out entirely.

#### W-004 | Security (T-10) — Unsanitized exception message in audit_log

**Files**: `src/modules/renewals/application/use-cases/accept-tier-upgrade.ts:557-560`.
**Impact**: The `threw` branch captures `gatewayResult.error.message.slice(0, 500)` and writes it into `audit_log.payload.failure_message` without passing through `sanitizeResendErrorMessage`. Resend SDK exceptions may embed email addresses or `re_<key>` API key prefixes — these would land in 5y-retained audit log.
**Recommendation**: Apply `sanitizeResendErrorMessage(gatewayResult.error instanceof Error ? gatewayResult.error.message : String(gatewayResult.error))` before `.slice(0, 500)`. Add unit test: gateway exception with email/key prefix → `[REDACTED_*]` in payload.

#### W-005 | Security (T-08) — Unbounded `?limit=` on GET queue

**Files**: `src/app/api/admin/renewals/tier-upgrades/route.ts:37`.
**Impact**: `Number.parseInt(limitParam, 10)` with no upper-bound cap. `GET ...?limit=999999` triggers full-table scan. Page server component hardcodes 50, but raw API allows arbitrary limit.
**Recommendation**: `const safeLimit = Math.min(Number.isFinite(rawLimit) ? rawLimit : 50, 100)`. Add contract test asserting `items.length <= 100`.

#### W-006 | Reliability (M-1) — `limit` NaN guard missing

**Files**: same as W-005, line 37.
**Impact**: `Number.parseInt('abc', 10) === NaN` → `Math.max(NaN, 1) === NaN` → Drizzle `.limit(NaN)` throws. Combined with W-005 fix above.
**Recommendation**: Use `Number.isFinite(rawLimit) ? rawLimit : 50` defensively.

#### W-007 | Security (T-04) — Coordinator response error field uncapped

**Files**: `src/app/api/cron/renewals/tier-upgrade-evaluate-coordinator/route.ts:227`.
**Impact**: Log slice capped to 400 chars, but `error` field in the JSON response body (`per_tenant_results[].error`) writes the raw `String(r.reason)`. Could leak stack traces, internal hostnames, or query fragments to cron-job.org.
**Recommendation**: Cap response-body error to ≤200 chars or replace with `http_${status}` sentinel.

#### W-008 | Architecture (F-04) — Direct cross-module infra import bypasses F2 barrel

**Files**: `src/modules/renewals/infrastructure/renewals-deps.ts:28`.
**Impact**: `import { drizzleScheduledPlanChangeRepo } from '@/modules/plans/infrastructure/db/drizzle-scheduled-plan-change-repo'` reaches into F2 infrastructure directly. ESLint `no-restricted-imports` rule doesn't currently block this path, but it violates Principle III spirit: cross-module imports go through public barrels.
**Recommendation**: Export the repo (or a factory) from `src/modules/plans/index.ts` and import via `@/modules/plans`.

#### W-009 | Architecture (F-02) — Reconcile cron lacks advisory lock

**Files**: `src/app/api/cron/renewals/reconcile-pending-applications/route.ts`.
**Impact**: Per-tenant evaluate cron acquires `pg_advisory_xact_lock('renewals:tierupgrade:'+tid)`; reconcile route does not. cron-job.org retry on timeout could double-fire reconcile, producing duplicate `tier_upgrade_pending_orphan_detected` audit emits for the same orphan (state remains idempotent due to status guard, but audit noise).
**Recommendation**: Add `pg_advisory_xact_lock(hashtextextended('renewals:reconcile:'||tenantId, 0))` in the reconcile use-case loop or route handler.

#### W-010 | Reliability (M-2) — `tier_upgrade_already_at_target` audit flood

**Files**: `evaluate-tier-upgrade.ts:282-314`.
**Impact**: Emitted per-member; 5,000-member tenant produces 5,000 audit rows weekly — write amplification + 5y retention storage cost. Spec FR-038 AS4 says "level: debug", but the audit emitter doesn't filter by log level before DB write.
**Recommendation**: Aggregate into a single `tier_upgrade_already_at_target_summary` audit per cron run with a count, mirroring `tenant_disabled` / `no_thresholds_configured` patterns. Alternatively, add a `level` column with a TTL distinct from 5y.

#### W-011 | Tests (F-04) — No concurrent-Accept race test

**Files**: `tests/integration/renewals/tier-upgrade-pending.test.ts`.
**Impact**: `acceptTierUpgrade` relies on partial UNIQUE catch via `TierUpgradeOpenConflictError`. The race "two admins click Accept on same suggestion" is not exercised at integration.
**Recommendation**: Add `Promise.all([accept(s1), accept(s1)])` — assert exactly one `ok=true` + one `error.kind='open_conflict'`.

#### W-012 | Tests (F-05) — F4 webhook replay idempotency for `apply-pending-tier-upgrade` not tested

**Files**: `tests/unit/renewals/infrastructure/f8-on-paid-callbacks.test.ts:310-319`.
**Impact**: Stripe webhook retry on the same `payment_intent.succeeded` event invokes `f8OnPaidCallbacks` twice. The current test only covers the `null cycle` (no-op) branch. The "already-applied → no-op + no double audit" path is missing.
**Recommendation**: Mock `cyclesRepoFindByInvoiceIdInTx` returning a cycle whose suggestion is already `applied`; assert no-op + no double `tier_upgrade_applied_at_renewal` audit emit.

#### W-013 | Tests (F-08) — Manual-supersede `open` state untested

**Files**: `tests/integration/renewals/tier-upgrade-pending.test.ts:527-578`.
**Impact**: `supersedePendingTierUpgradeInTx` discriminates `superseded_from_status: 'open' | 'accepted_pending_apply'`. Only the latter is tested; the `'open'` branch (admin manually changes plan before clicking Accept) is uncovered.
**Recommendation**: Add a case: seed `open` suggestion → call supersede → assert `fromStatus='open'` + `status='superseded'`.

#### W-014 | Tests (F-09) — "Already-fired reminders not recalled" path untested

**Files**: `tests/unit/renewals/application/use-cases/reschedule-on-plan-change.test.ts`.
**Impact**: All 6 unit tests short-circuit before the cancelled-step path. The invariant "steps with `fired_at IS NOT NULL` are preserved when the bucket diff cancels a step" is not asserted.
**Recommendation**: Add a test where the schedule diff produces a step with `fired_at IS NOT NULL`; assert `cancelledStepIds` excludes already-fired steps.

#### W-015 | Tests (F-06, F-07) — E2E auto-tier-upgrade.spec.ts has vacuous-pass anti-pattern

**Files**: `tests/e2e/auto-tier-upgrade.spec.ts:60-83, 85-113`.
**Impact**: Tests 3+4 check `acceptBtn.count() === 0` and emit a test annotation note — they pass vacuously when no suggestions are seeded. This is the documented "skip is not pass" anti-pattern. FR-058 §4 focus-on-Cancel default for Accept dialog is also not asserted.
**Recommendation**: Seed an open suggestion in `beforeAll` via direct API call or seeder script. Add `expect(cancelButton).toBeFocused()` assertion when AlertDialog opens.

#### W-016 | i18n — TH `status.dismissed` collision with `dialog.cancel`

**Files**: `src/i18n/messages/th.json` → `admin.renewals.tier_upgrades.status.dismissed = "ยกเลิก"` collides with `dialog.cancel = "ยกเลิก"`.
**Impact**: Same word for status badge and Cancel button → screen-reader confusion.
**Fix**: `"dismissed": "ถูกปฏิเสธ"`.

#### W-017 | i18n — TH `from_plan` / `to_plan` use "แพลน" instead of project-canonical "แพ็กเกจ"

**Files**: `src/i18n/messages/th.json` → `admin.renewals.tier_upgrades.columns.from_plan` / `to_plan`.
**Impact**: Project F2 vocabulary uses "แพ็กเกจ" 100× — the new keys diverge with "แพลน" (2× total).
**Fix**: `"from_plan": "แพ็กเกจปัจจุบัน"`, `"to_plan": "แพ็กเกจที่แนะนำ"`.

#### W-018 | i18n — SV `escalate.success` neuter-agreement bug

**Files**: `src/i18n/messages/sv.json` → `admin.renewals.tier_upgrades.actions.escalate.success = "Utkast till uppsökande skapad"`.
**Impact**: "utkast" is neuter (ett utkast) → past participle must be `"skapat"`, not `"skapad"`.
**Fix**: `"Utkast till uppsökande skapat"`.

#### W-019 | Drizzle (S-1) — Migration 0118 missing `--> statement-breakpoint`

**Files**: `drizzle/migrations/0118_f8_phase7_renewal_schedule_rescheduled_enum.sql:18`.
**Impact**: 0116/0119/0120 all use `--> statement-breakpoint` after `ADD VALUE`. Doesn't break Postgres 15+ (auto-commit), but breaks codebase convention.
**Fix**: Append `--> statement-breakpoint` after the semicolon.

---

### 🟢 Suggestions (nice to fix; non-blocking)

#### S-001 | Architecture — `drizzlePlanCatalog` singleton inconsistency
`drizzle-plan-catalog.ts:137`. Refactor to `makeDrizzlePlanCatalog(tenant)` factory like sibling repos for clarity.

#### S-002 | Architecture — `isSuppressedForMember` outside `runInTenant` tx
`evaluate-tier-upgrade.ts:317-326`. Document conscious design choice; partial UNIQUE catches the race regardless.

#### S-003 | Architecture — `f8OnPaidCallbacks` closure 280+ lines
`renewals-deps.ts:391-674`. Extract `makeApplyTierUpgradeCallback(deps, tenantId)` for test isolation.

#### S-004 | Reliability (N-1) — `correlationId` and `requestId` are the same value
`change-plan.ts:317`. `correlationId` should come from upstream request context, not duplicate `requestId`. Won't lose data today but hampers distributed-trace stitching.

#### S-005 | Tests (F-10) — Idempotency test allows either branch
`tier-upgrade-evaluate.test.ts:292-294`. "Either conflictSkipped or alreadyAtTarget" comment hides the path discriminator. Tighten to assert which branch fires.

#### S-006 | Tests (F-11) — EN locale BE-leak check permits 1 occurrence
`tier-upgrade-approval-email.test.tsx:60-68`. Split body vs footer assertions so a stray BE year in the body cannot hide.

#### S-007 | Tests (F-12) — No property-based test for state machine
6-state machine has illegal transitions (`dismissed` → `open` etc.). Add fast-check property test to lock invariants.

#### S-008 | Drizzle (S-2) — `isSuppressedForMember` query index sub-optimal
`(tenant_id, status, suppressed_until) WHERE status='dismissed'` lacks `member_id`. Postgres scans all dismissed rows. Add `(tenant_id, member_id, status, suppressed_until) WHERE status='dismissed'` in next migration.

#### S-009 | Security (T-12) — Confirm F3 self-update field allowlist excludes `declared_turnover_thb`
Cross-check F3 `member_self_update` use-case to ensure members cannot inflate turnover and trigger upgrades.

#### S-010 | Security (T-09) — Coordinator HTTP fan-out timeout not enforced
Multi-tenant future hazard (50 tenants × 30s = exceeds 300s budget). Document timeout requirement for multi-tenant migration.

#### S-011 | i18n — TH dialog title drift (`Accept tier upgrade?` vs `ยืนยันการปรับระดับสมาชิก?`)
EN says "Accept", TH reads "Confirm". Align with button label `"อนุมัติ"`.

#### S-012 | i18n — SV escalate dialog title `"Eskalera till uppsökande?"` awkward
"uppsökande" used as standalone noun; better: `"Skapa kontaktutskick?"`.

#### S-013 | Architecture (F-06) — Security checklist sign-off pending
F8 PII surface requires Principle IX 2-reviewer + security sign-off at Review gate. Verify `security.md § 5` covers tier-upgrade routes.

---

## 4. Test Coverage Assessment

| Layer | Status | Gaps |
|---|---|---|
| **Domain (target 100%)** | ✅ Tier-upgrade Domain types in port files; sha256-hex value object covered | none material |
| **Application (target 80%/80%)** | ⚠️ accept-tier-upgrade.ts 660 LOC — branch coverage on T-180 conditional + manual-supersede + email-failure 4-branch needs spot-check | F-002 dismiss + F-003 escalate at 0% integration |
| **Infrastructure** | ✅ Drizzle adapters covered via integration tests T202–T204 | none material |
| **Cross-tenant isolation** | 🔴 **GAP — F-001 Phase 7 surfaces absent** | 4 probes required |
| **E2E** | ⚠️ T205 written but data-dependent vacuous-pass | F-006/F-007 |

---

## 5. Metrics

- **Files reviewed**: 98 (9,610 LOC)
- **Migrations reviewed**: 5 (0116, 0117, 0118, 0119, 0120)
- **Findings**: **3 🔴 Blockers · 19 🟡 Warnings · 13 🟢 Suggestions** — total 35
- **Spec coverage (FRs + ASes)**: 12/14 ✅, 1/14 ⚠️ (FR-052a manager ambiguity), 1/14 🔴 (Principle I clause 3 cross-tenant probe)
- **Constitution compliance**: I (Tenant Isolation) 🔴 | II (Test-First) 🔴 | III (Clean Architecture) ⚠️ | IV (PCI DSS) n/a | V (i18n) ⚠️ | VI (Inclusive UX) ⚠️ | VII (Perf & Observability) ✅ | VIII (Reliability) ⚠️ | IX (Code Quality) ⚠️ | X (Simplicity) ✅
- **Round 1–5 close rate (historical)**: 141/141 findings (100%) — strong remediation track record

---

## 6. Recommended Actions (prioritized)

### Round 6 — Critical (must close)
1. **F-001** Add 4 cross-tenant probes for tier-upgrade use-cases in `cross-tenant-isolation.test.ts`.
2. **F-002** Add `dismissTierUpgrade` integration test (3 cases minimum).
3. **F-003** Add `escalateTierUpgrade` integration test (1 case minimum).

### Round 6 — High (should close)
4. **W-001** Resolve nested `runInTenant` semantics (lock-then-tx separation).
5. **W-002** Extend reconcile to detect manual-plan-change orphans.
6. **W-003** Clarify FR-052a manager queue access; align route + UI behavior.
7. **W-004** Sanitize exception message before audit_log write.
8. **W-005** + **W-006** Cap & defensively parse `?limit=`.
9. **W-007** Cap coordinator response error string.

### Round 6 — Medium (nice to close)
10. W-008..W-015 (architecture + tests bundle).
11. W-016..W-018 i18n trio.
12. W-019 Drizzle convention fix.

### Defer (post-ship Phase 10 polish)
- All 13 🟢 Suggestions can be tracked as Phase 10 backlog items unless trivial-to-fix-now.

---

## 7. Verdict

❌ **CHANGES REQUIRED** — Open Round 6 review-fix to close the 3 Blockers (F-001/002/003) and the 9 high-priority Warnings. After closure, re-run `/speckit.staff-review.run F8 Phase 7 verify` and proceed to `/speckit.ship` if green.

The Phase 7 codebase is functionally well-built; the gaps are testing-discipline gaps, not architectural rewrites. Estimated remediation effort: 1–2 developer-days for Blockers + 1 day for high-priority Warnings.

---

*Generated 2026-05-10 by `speckit-staff-review-run` — synthesized from 6 specialist agent reports (chamber-os-architect, drizzle-migration-reviewer, reliability-guardian, security-threat-modeler, senior-tester, i18n-translation-reviewer).*
