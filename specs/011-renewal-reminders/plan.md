# Implementation Plan: F8 — Renewal Tracking + Smart Reminders

**Branch**: `011-renewal-reminders` | **Date**: 2026-05-03 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/011-renewal-reminders/spec.md`
**Constitution**: [`.specify/memory/constitution.md`](../../.specify/memory/constitution.md) **v1.4.0**
**Predecessors**: F1 Auth & RBAC (PR #1), F2 Plans (`002-membership-plans`), F3 Members & Contacts (`005-members-contacts`), F4 Invoices & Receipts (`007-invoices-receipts`, PR #12), F5 Online Payment (`009-online-payment`, PR #16), F7 Email Broadcast (`010-email-broadcast`, PR #23)
**Co-shipping with**: F6 EventCreate Integration (`008-event-integration`, planned) — F8 ships an `EventAttendeesPort.isAvailable()` feature-detection probe (FR-029a) so its at-risk score gracefully degrades while F6 has not landed yet; F6 is in the Phase 2 ordering AHEAD of F9 (F5 → F7 → F8 → F6 → F9), so by F8 production go-live F6 data is guaranteed present and the fallback is purely a dev/staging concern
**Coordinated extensions** (per Complexity Tracking #3 + #4): F4 maintainer adds an `onPaidCallbacks` parameter to `markPaidFromProcessor` (~10 lines + 1 test); F2 maintainer adds `scheduleNextRenewalPlanChange` use-case + `scheduled_plan_changes` table; F1 maintainer adds a 4-line synchronous call to F8's `detectBounceThreshold` from the existing Resend webhook handler (per research.md R8 rev-2). All three extensions are additive (no breaking change to existing F1/F2/F4 consumers).
**Production gate (revised v3 — clarified by maintainer 2026-05-03)**: F8 ships **complete in scope** within this branch — every US (US1–US6), every UI surface, every backend, every cron, every test. **No scope cuts** (the earlier critique X2 / R15 suggestion to ship pipeline-only with UI placeholders was rejected by maintainer because Chamber-OS is not live yet — the staged-rollout reasoning does not apply when there are no end-users to protect). F8 ships **dark** in production (`FEATURE_F8_RENEWALS=false`); kill-switch flips on at the moment of MVP-wide chamber go-live (Phase 1 + 2 + 3 complete, F1-F9 + supporting smart features stable, R6 folder rename done) — a single coordinated cutover, not a per-feature rollout. Vercel Rolling Releases (10% → 50% → 100%) used at that single flip moment. See spec.md Assumption A12 v3.

## Summary

F8 delivers Chamber-OS's **seventh business feature** and closes the largest operational gap in the chamber's daily heads-up routine: today, admins manually scroll an Excel sheet to spot upcoming renewals, members silently churn before anyone notices, and high-value Diamond/Platinum partnerships get the same one-size-fits-all "Your membership expires in 30 days" email as a 1,000 THB Thai-Alumni member. F8 turns the renewal calendar into a live tier-aware pipeline, ships rule-based at-risk detection (90+ days early-warning with admin snooze + outreach), surfaces objective tier-upgrade candidates from F4 invoice + F2 plan data, and runs a daily tier-calibrated reminder cadence dispatched via the existing F1+F4 transactional Resend surface — all while staying tenant-isolated, audit-complete, and PII-safe. Members complete renewals self-service via a dedicated `/portal/renewal/<member_id>` flow that delegates invoice issuance to F4 and payment capture to F5; on payment success F8 advances `expires_at`, transitions the cycle to `completed`, and cancels any remaining scheduled reminders.

F8 carries **⚠ PII** sensitivity (member contact emails, plan history, invoice/payment history) and **⚠ Finance-adjacent** scope (the at-risk score reads overdue-invoice and last-payment signals; the tier-upgrade engine reads 12-month paid-invoice volume; renewal completion creates F4 invoices). Principle IV (PCI DSS) is **N/A** — F8 has zero payment surface; it delegates to F5 unchanged. Review gate requires **≥2 reviewers** under the default rule, or the Constitution § IX.5-stack solo-maintainer substitute when no second human reviewer is available (per F7 + F5 + F4 precedent).

**Scope confirmed from spec** (10 clarifications resolved across 2 sessions of `/speckit.clarify` — Session 2026-05-03 round 1 Q1–Q5 + round 2 Q1–Q5; full provenance in spec.md `## Clarifications`; refined further at /speckit.critique 2026-05-03 round 1 with 4 🎯 + 28 💡 + 2 🔄 findings remediated): 6 user stories (US1–US6; US1+US2 both **P1**), **66 functional requirements** (FR-001…FR-057 + amendments FR-005a lapsed-portal middleware + FR-007a canonical "active member" + FR-010a retry budget + FR-012a bounce-threshold detection + FR-019a NULL primary_contact graceful skip + FR-029a F6-readiness fallback + FR-052a RBAC matrix), 12 success criteria (SC-001…SC-012 with refined SC-004 baseline formula + SC-012 N/A-clause), **47 named audit events** (full taxonomy in `data-model.md` § 4; +4 from /speckit.critique round 1: `cron_dispatch_orchestrated`, `renewal_reminder_send_failed_permanent`, `renewal_reminder_retried`, `renewal_skipped_no_joined_at`, `tier_upgrade_pending_orphan_detected`), **8 new DB tables** (added `consumed_link_tokens` for FR-026 single-use enforcement) + **3 new columns on F3 `members`** + **1 new column on F2 `membership_plans`**, **1 new bounded context** `src/modules/renewals/`, **0 new npm dependencies** (F8 reuses F1+F4's `resend` + F4's `@js-joda/core` for fiscal-boundary date math + F4's `fast-check` for property-based at-risk score testing + the existing pino + OTel + zod stack), **9 migrations** (0086–0094 — extended at /speckit.tasks audit / M1; F2 cross-module `scheduled_plan_changes` table delivered as F8 migration 0086 per F7 precedent of F8-owns-all-migrations; F7 post-ship migrations 0084 + 0085 already on main), **5 cron-job.org HTTP triggers** (3 coordinator + 2 housekeeping per critique E7+E19). Forward-compat seam: `EventAttendeesPort.isAvailable()` returns `false` until F6 ships (mirrors F7's `EventAttendeesRepository` stub-port pattern).

**Technical approach**: Reuse the F1+F2+F3+F4+F5+F7 stack unchanged — Next.js 16 App Router + React 19 + TypeScript 5.7 strict + Drizzle ORM on Neon Postgres + Postgres RLS via `runInTenant(ctx, fn)` + shadcn/ui + Tailwind v4 + next-intl + Vitest + Playwright + pino + @vercel/otel + Resend (the existing F1+F4 transactional client; **NOT** the F7 Resend Broadcasts surface — renewal reminders are transactional communications and must not pollute the F7 broadcasts suppression list, sender reputation, or marketing-consent regime). Add **one new bounded context** `src/modules/renewals/` housing `RenewalCycle` + `TierUpgradeSuggestion` + `RenewalEscalationTask` + `RenewalLinkToken` aggregates plus the `RenewalGateway` (transactional email dispatch via F1+F4 client) + `RenewalLinkTokenSigner` + `RenewalLinkTokenVerifier` + `EventAttendeesPort` (feature-detection probe) + `AtRiskScorer` ports. Add **three new cron-job.org HTTP triggers** at `/api/cron/renewals/dispatch` (daily) + `/api/cron/renewals/at-risk-recompute` (weekly Sundays 02:00 Asia/Bangkok) + `/api/cron/renewals/tier-upgrade-evaluate` (weekly Sundays 03:00) — same `CRON_SECRET` Bearer-auth pattern reused from F4/F5/F7. Add **one new API route family**: `/api/admin/renewals/*` (admin pipeline + manual send + snooze + tier-upgrade actions + escalation-task lifecycle) + `/api/portal/renewal/[memberId]/*` (member self-service confirm + plan-change) + `/api/cron/renewals/*` (3 cron handlers) + `/api/portal/preferences/renewals` (member opt-out toggle). Pipeline UX is a dedicated `/admin/renewals` route (TanStack Table v8 — reuse F4 invoice-list + F7 broadcast-queue pattern); at-risk widget + tier-upgrade queue + escalation tasks are co-hosted on the F9 admin shell at ship time. Member self-service UX is `/portal/renewal/<member_id>` (server-rendered with token-verify entry path). F8 extends F4's public barrel with `markRenewalInvoicePaid` (event-driven hook for FR-023) and F2's barrel with `getMemberPlanForBucket(memberId)` + `applyPendingTierUpgrade(memberId, cycleId)` (FR-039 step 4). Enterprise UX per `docs/ux-standards.md`; WCAG 2.1 AA on every surface; SV+EN+TH at release; ≥5-year audit retention (no F4 tax-document overlap).

## Technical Context

**Language/Version**: TypeScript 5.7+ strict (`strict: true`, `noUncheckedIndexedAccess: true`, `exactOptionalPropertyTypes: true`) — unchanged from F1+F2+F3+F4+F5+F7
**Runtime**: Node.js 22 LTS (Vercel Fluid Compute) — unchanged. **All cron handlers + member self-service routes pinned to Node.js runtime** (NOT Edge) for `@js-joda/timezone` (Asia/Bangkok fiscal boundary date math reused from F4) + raw-DB-pool access via Drizzle. Mirrors the F4/F5/F7 cron handler runtime constraint.
**Framework**: Next.js 16 App Router + Cache Components + Turbopack — unchanged

**Primary Dependencies**:

- **from F1+F2+F3+F4+F5+F7** (unchanged versions): `next@^16`, `react@^19`, `drizzle-orm` + `drizzle-kit`, `next-intl`, `zod`, `react-hook-form` + `@hookform/resolvers/zod`, `shadcn/ui` + `tailwindcss@^4` + `lucide-react`, `next-themes`, `sonner`, `cmdk` (F8 extends palette with "Renewal pipeline" + "Send reminder to <member>" + "View at-risk widget" commands), `@tanstack/react-table@^8` (F8 reuses the F3+F4+F7 pattern for admin pipeline + tier-upgrade queue + escalation-task queue), `@vercel/otel` + `@opentelemetry/api`, `pino`, `vitest`, `playwright`, `@axe-core/playwright`, `resend` (F8 uses the **transactional** API surface only — same `RESEND_API_KEY` + same suppression list as F1+F4, NOT the F7 `RESEND_BROADCASTS_API_KEY` surface), `@js-joda/core` + `@js-joda/timezone` (reused from F4 for Asia/Bangkok fiscal-boundary date math on `expires_at` derivation + reminder offset-day eligibility), `@react-pdf/renderer` (NOT used by F8 directly — F4 issues the renewal tax invoice PDF on F8's behalf via the F4 barrel).
- **new in F8**: **NONE**. The deliberate design goal is to close the renewal/at-risk/tier-upgrade business gap without adding new third-party dependencies — the at-risk score is rule-based (no ML), the tier-upgrade rules read existing F2 + F4 columns, and the reminder cadence is rendered with the existing F1+F4 React Email template stack.
- **rejected** (YAGNI / constitutional / scope-creep guard):
  - **ML-based churn prediction** (e.g., a small scikit-learn or TensorFlow.js model trained on historical renewal data) — rejected by Constitution Principle X (Simplicity) and the smart-chamber-features.md § 3 rule-based scoring decision. ML adds a model-training pipeline, dataset-versioning concern, model-drift monitoring, and model-explainability obligation under PDPA Section 32 / GDPR Article 22 (automated decision-making) that the rule-based formula avoids. The 8-factor heuristic in FR-029 is transparent, defensible to a member who asks "why am I flagged at-risk", and recomputable in <60s for 5,000 members.
  - **Stripe Smart Retries / dunning automation** for failed renewal payments — out of MVP per spec § Out of Scope (OOS-5). F5's existing payment_failed audit trail + F8's at-risk widget are sufficient; admin handles manual retry today.
  - **SMS reminder channel** (Twilio / Vonage / etc.) — out of MVP per OOS-1. Email + manual escalation tasks are sufficient for SweCham's MVP scope; SMS adds a per-tenant credential, regional sender-ID compliance (Thai NBTC for SMS-from-business), and PDPA-consent obligation that the email transactional channel already covers.
  - **Calendar-year membership-anchor model** as a tenant-configurable alternative — rejected at /speckit.clarify Session 2026-05-03 Q1 (round 1) in favour of per-member anchor. If a future tenant requires it, ships as a small follow-up after MVP per OOS-11.
  - **Auto-DOWNGRADE tier suggestions** — rejected at /speckit.clarify Session 2026-05-03 Q5 (round 1) per OOS-3.
  - **Per-plan reminder schedule overrides** — rejected at /speckit.clarify Session 2026-05-03 Q2 (round 1) in favour of 5 fixed tier buckets per OOS-12.
  - **Bulk renewal actions** ("renew 30 members in one click" admin tool) — out of MVP per OOS-4.
  - **Multi-year auto-renew** (auto-charge stored payment method on `expires_at`) — out of MVP per OOS-9; every renewal is an explicit member-confirmed action.
  - **Member-facing risk-self-assessment** ("How likely are you to renew?" in-portal survey) — out of MVP per OOS-8 (privacy-sensitive).

**Storage**:

- Primary: PostgreSQL via Neon `ap-southeast-1` Singapore — unchanged. Adds **seven new tables**: `renewal_cycles`, `renewal_reminder_events`, `tenant_renewal_settings`, `tenant_renewal_schedule_policies`, `at_risk_outreach`, `tier_upgrade_suggestions`, `renewal_escalation_tasks`. Extensions to `audit_log` (new event types only — reuses F2/F3/F4/F5/F7 `payload jsonb` + `tenant_id` + `retention_years` columns). Extensions to F3 `members` (4 new columns: `renewal_reminders_opted_out` boolean, `email_unverified` boolean, `risk_score` smallint, `risk_score_band` text, `risk_score_factors` jsonb, `risk_score_last_computed_at` timestamptz, `risk_snoozed_until` timestamptz nullable) and F2 `membership_plans` (1 new column: `renewal_tier_bucket` enum — see Complexity Tracking entry #2 for the cross-module migration coordination note).
- Postgres RLS: every F8-introduced table has `ENABLE ROW LEVEL SECURITY` + `FORCE ROW LEVEL SECURITY` + `USING (tenant_id = current_setting('app.current_tenant', TRUE))` policy, identical to F2+F3+F4+F5+F7 pattern. `runInTenant(ctx, fn)` reused unchanged. `DEBUG_RLS_STATE=1` dev-mode safety net inherited. **Exception**: The renewal-link token verifier route (`/api/portal/renewal/<memberId>?token=…`) runs an unauthenticated public entry under a narrow bypass context — the recipient is unauthenticated and the tenant + member are resolved from the signed token payload, NOT from a user session; immediately after token verification the tx re-binds `app.current_tenant` via `runInTenant` for the cycle/state read + member sign-in. Same pattern as F5's webhook pre-tenant bypass + F7's unsubscribe-route pre-tenant bypass — narrowest possible window.
- Indexes (all `CREATE INDEX CONCURRENTLY` outside migration tx — same F4/F5/F7 pattern):
  - `renewal_cycles(tenant_id, member_id, status)` — pipeline dashboard + cron eligibility
  - `renewal_cycles(tenant_id, expires_at)` — pipeline dashboard urgency-bucket sort (FR-046 / SC-003)
  - `renewal_cycles(tenant_id, status, expires_at) WHERE status IN ('upcoming','reminded','awaiting_payment')` — partial index for daily reminder-cron eligibility scan (FR-010)
  - `renewal_cycles(tenant_id, member_id) WHERE status NOT IN ('lapsed','cancelled','completed')` — partial index for canonical-active-member resolver (FR-007a)
  - `renewal_reminder_events(cycle_id, step_id) UNIQUE` — idempotency primitive (FR-011)
  - `renewal_reminder_events(tenant_id, dispatched_at DESC)` — admin "recent reminders" audit view
  - `renewal_reminder_events(tenant_id, status) WHERE status = 'failed'` — partial index for "failed reminders" admin retry queue
  - `tier_upgrade_suggestions(tenant_id, member_id) UNIQUE WHERE status IN ('open','accepted_pending_apply')` — at most one open OR pending suggestion per member (FR-038 + FR-039 step 1)
  - `tier_upgrade_suggestions(tenant_id, status, suppressed_until) WHERE status = 'dismissed'` — cron skip-eligibility check (suppressed for 90 days)
  - `tier_upgrade_suggestions(tenant_id, target_apply_at_cycle_id) WHERE status = 'accepted_pending_apply'` — F4 renewal-invoice-creation hook reads pending applications per member (FR-039 step 4)
  - `renewal_escalation_tasks(tenant_id, status, due_at)` — admin task-queue listing
  - `renewal_escalation_tasks(tenant_id, assigned_to_user_id, status) WHERE status = 'open'` — per-user task tray
  - `renewal_escalation_tasks(tenant_id, member_id, cycle_id, task_type) UNIQUE WHERE status = 'open'` — task idempotency (one open task per type per cycle)
  - `at_risk_outreach(tenant_id, member_id, created_at DESC)` — member detail timeline
  - `members(tenant_id, risk_score DESC) WHERE risk_score >= 50 AND risk_snoozed_until IS NULL` — partial index for at-risk widget query
  - `tenant_renewal_settings(tenant_id) PRIMARY KEY` — one row per tenant
  - `tenant_renewal_schedule_policies(tenant_id, tier_bucket) UNIQUE` — five rows per tenant default
- **No new Blob storage** — F8 has no PDF surface (F4 issues the renewal invoice PDF + receipt PDF unchanged).
- Session / rate-limit cache: Upstash Redis (Singapore) — unchanged. F8 adds **five new token buckets**:
  - `POST /api/admin/renewals/[cycleId]/send-reminder-now` — **30 manual sends / 5 min per `(tenant_id, actor_user_id)`** (admin-only manual dispatch protection)
  - `POST /api/admin/renewals/at-risk/[memberId]/snooze` + `outreach` — **60 actions / 5 min per `(tenant_id, actor_user_id)`** (loose; admin)
  - `POST /api/admin/renewals/tier-upgrades/[suggestionId]/[accept|dismiss|escalate]` — **30 actions / 5 min per `(tenant_id, actor_user_id)`**
  - `GET /api/portal/renewal/[memberId]?token=...` — **20 hits / 5 min per source IP** (token-brute-force guard; legitimate user clicks once or twice from the email)
  - `POST /api/portal/renewal/[memberId]/confirm` — **10 confirmations / 1h per `(tenant_id, member_id)`** (prevent double-click duplicate-renewal attempts)
  - `POST /api/portal/preferences/renewals` — **20 toggles / 1h per `(tenant_id, member_id)`** (loose; member self-service)

**Testing**:

- `vitest` — unit + Application tests. Coverage thresholds: Domain 100% line; Application ≥ 80% line + 80% branch overall, **100% branch on security-critical use cases**:
  - `dispatch-reminder-cycle.ts` (every FR-010 + FR-011 + FR-012 + FR-012a + FR-014 + FR-015 precondition path; idempotency-hit branch; multi-year non-final-year skip branch; F6-readiness fallback for at-risk recompute is in a separate use-case)
  - `compute-at-risk-score.ts` (FR-028 + FR-029 + FR-029a + FR-030 — every factor activation/skip path with F6-readiness mock; band-crossing branch; min-tenure skip; deterministic snapshot tests for the 8-factor formula)
  - `evaluate-tier-upgrade.ts` (FR-037 + FR-038 — every eligibility-threshold branch; suppressed-until skip; auto-resolved branch when member already at target; tenant-disabled branch)
  - `accept-tier-upgrade.ts` (FR-039 — pending-state insert + member-email dispatch + T-180 task creation + audit emission of all 4 new audit event types)
  - `verify-renewal-link-token.ts` (single-use enforcement + TTL check + tenant-binding check + replay-rejection — generic error response for all failure modes per FR-027)
  - `confirm-renewal.ts` (FR-022 + FR-023 — F4 createMembershipInvoice invocation + F2 plan-change branch + atomic cycle transition; payment-failed branch leaves cycle in `awaiting_payment`)
  - `enforce-tenant-context-on-renewal.ts` (cross-tenant probe refusal + `renewal_cross_tenant_probe` audit; cross-member probe + `renewal_cross_member_probe`)
  - `enforce-rbac-on-f8-mutation.ts` (FR-052a — every mutating use-case rejects `manager` role at the application layer with 403 + `f8_role_violation_blocked` audit; `member` role rejected on admin endpoints; defence-in-depth alongside UI-layer hide/disable)
  - `enforce-lapsed-portal-scope.ts` (FR-005 — every blocked route returns 403 + `lapsed_member_action_blocked` audit; allowed routes pass through)
  - `detect-bounce-threshold.ts` (FR-012a — every trigger branch: hard-bounce / soft-streak-in-cycle / soft-rolling-30d; threshold-not-met no-op; verification-resets-flag branch; **synchronous in-process invocation from F1 webhook handler** per research.md R8 rev-2)
  - **Property-based at-risk score formula tests** (added /speckit.critique 2026-05-03 round 1 / E15): `at-risk-score.spec.ts` uses `fast-check@^4` (existing F4 devDep, no new dep) to assert score ∈ [0, active_max], monotonicity (more triggered factors → higher score), band classification matches threshold, F6-active toggle changes max but preserves ordering — covers all 256 factor-combinations × 2 F6-states = 512 cases. Snapshot tests retained for explainability documentation but property-based covers correctness.
- `playwright` — E2E with existing F1+F2+F3+F4+F5+F7 setup. New specs:
  - `tests/e2e/renewal-pipeline-dashboard.spec.ts` (US1 AS1–AS5 — pipeline render + tier filter + Lapsed tab + cross-tenant probe + 5k-member perf budget)
  - `tests/e2e/tier-aware-reminder-cron.spec.ts` (US2 AS1–AS7 — Premium T-30 dispatch + idempotent re-run + Partnership T-90 dual-channel + locale fallback + bounce skip + kill-switch + admin manual send)
  - `tests/e2e/member-self-service-renewal.spec.ts` (US3 AS1–AS7 — happy renewal + plan-change branch + payment-failed branch + post-lapse renewal + token-replay + token-expired)
  - `tests/e2e/at-risk-widget.spec.ts` (US4 AS1–AS6 — score recompute + band crossing + snooze + outreach + member-role hidden + per-tenant fault isolation)
  - `tests/e2e/auto-tier-upgrade.spec.ts` (US5 AS1–AS6 — suggestion creation + accept-pending flow + dismiss + auto-resolved + no-thresholds skip + tenant-disabled)
  - `tests/e2e/escalation-task-queue.spec.ts` (US6 AS1–AS4 — Partnership task creation + done-with-note + reassign + overdue highlight)
  - `tests/e2e/renewal-a11y.spec.ts` (axe-core on pipeline, at-risk widget, tier-upgrade queue, escalation tasks, portal-renewal-page, preferences page)
  - `tests/e2e/renewal-i18n.spec.ts` (TH + EN + SV coverage on every F8 surface + Buddhist Era display rule on `th-TH` for `expires_at`)
  - `tests/e2e/lapsed-portal-scope.spec.ts` (FR-005 — lapsed member sign-in + 4 allowed routes pass + 6 blocked routes 403-redirect)
  - `tests/e2e/manager-readonly.spec.ts` (FR-052a — manager sees pipeline + at-risk + tier-upgrade + tasks; mutating CTAs absent; direct API POST returns 403 + `f8_role_violation_blocked`)
- `@axe-core/playwright` — WCAG 2.1 AA on every new screen (admin pipeline + at-risk widget + tier-upgrade queue + escalation task list + member portal renewal page + preferences page).
- **New cross-tenant integration test for F8** (Constitution v1.4.0 Principle I clause 3 — Review-Gate blocker): `tests/integration/renewals/tenant-isolation.test.ts` — creates two tenants, seeds members + plans + cycles + reminder-events + suggestions + tasks + outreach for each, asserts zero cross-tenant visibility on SELECT / INSERT / UPDATE / DELETE across all 7 F8 tables, plus emission of `renewal_cross_tenant_probe` on every probe attempt from both directions. Plus a separate cross-tenant probe via the renewal-link-token route (a token signed for tenant A bound to a member-id from tenant B → reject + audit).
- **New cron-idempotency integration test** (FR-011): `tests/integration/renewals/dispatch-cron-idempotency.test.ts` — runs the daily dispatch cron 3 times in a row on the same fixture data, asserts (a) zero duplicate `renewal_reminder_events` rows inserted, (b) zero duplicate `renewal_reminder_sent` audit events, (c) zero duplicate Resend transactional API invocations (mocked).
- **New token-verification integration test** (FR-026 + FR-027): `tests/integration/renewals/renewal-link-token.test.ts` — happy first-use + replayed → reject + tampered MAC → reject + expired (>30d) → reject + cross-tenant token → reject + truncated payload → reject. All non-success paths render the SAME generic error page (no oracle).
- **New at-risk-fallback integration test** (FR-029a — F6 readiness): `tests/integration/renewals/at-risk-f6-fallback.test.ts` — with `EventAttendeesPort.isAvailable() === false`, run the recompute cron and assert event-attendance factors contribute 0; band thresholds are computed against active_max=70; transition to `EventAttendeesPort.isAvailable() === true` and re-run with seeded events, asserting bands shift to active_max=100 without code change.
- **New bounce-threshold integration test** (FR-012a): `tests/integration/renewals/bounce-threshold.test.ts` — F1 webhook seeds bounce events of varying classification + timing → assert (a) 1 hard-bounce flips `email_unverified=true` immediately, (b) 2 soft-bounces in same cycle does NOT trigger, (c) 3 soft-bounces in same cycle DOES trigger, (d) 4 soft-bounces with one stale (>30d) does NOT trigger, (e) 5 soft-bounces in rolling 30-day window DOES trigger, (f) member email update + verification resets flag.
- **New tier-upgrade-pending integration test** (FR-039 — Q5 round 2): `tests/integration/renewals/tier-upgrade-pending.test.ts` — admin accept on a suggestion → assert pending-state insert, member email dispatched (mock), T-180 task created when `expires_at - today > 180`, F4 renewal-invoice creation hook reads the pending suggestion and applies the upgraded plan price atomically, audit events `tier_upgrade_pending_member_notified` + `tier_upgrade_applied_at_renewal` emitted; secondary scenario: admin manually changes plan via F2 mid-pending → assert pending suggestion auto-cancels with `tier_upgrade_pending_superseded_by_manual_change`.
- **New RBAC-defence-in-depth integration test** (FR-052a): `tests/integration/renewals/rbac-defence-in-depth.test.ts` — manager role sends authenticated POST to every F8 mutating endpoint → asserts 403 + `f8_role_violation_blocked` audit + zero state mutation. Mirrors UI-layer-hide tests (which are visual) with application-layer-block tests (which are forensic).
- **New lapsed-portal-scope integration test** (FR-005): `tests/integration/renewals/lapsed-portal-scope.test.ts` — set member to `lapsed`, sign in as that member, exercise every allowed and blocked route, assert correct status codes + audit event emission for each blocked attempt.
- **New multi-year reminder-skip integration test** (FR-010 + Q4 round 1): `tests/integration/renewals/multi-year-cycle.test.ts` — Partnership member with 3-year cycle, run cron at year 1 / year 2 / year 3 simulated dates, assert email steps suppressed in years 1+2 with `multi_year_non_final_year` audit skip-reason, escalation tasks fire annually rebased on `year_in_cycle`, full email schedule fires in year 3.
- **New self-service end-to-end transactional integration test** (US3): `tests/integration/renewals/self-service-renewal-tx.test.ts` — mock F5 payment_succeeded → assert F8 listens for the F4 invoice_marked_paid event in the same DB transaction, advances `members.expires_at`, transitions cycle to `completed`, cancels remaining `renewal_reminder_events` for the cycle, dispatches confirmation email — all atomic; rollback path on any step failure leaves zero partial state.

**Target Platform**: Modern evergreen browsers (Chrome / Edge / Firefox / Safari latest 2 + Mobile Safari iOS 16+ + Chrome for Android 12+). Server: Vercel Fluid Compute Singapore region. Database: Neon Postgres `ap-southeast-1` Singapore with read-replica failover.

**Project Type**: Web application (Next.js App Router fullstack — admin portal + member portal + cron HTTP triggers + transactional email integration), reusing the F1+F2+F3+F4+F5+F7 monorepo structure. Single project; no separate `frontend/`+`backend/` split.

**Performance Goals** (per spec FR-046, FR-057, SC-003, SC-005):
- Renewal pipeline dashboard: **p95 render < 500ms** at 5,000 active members + 600 within 90-day window
- Daily reminder dispatch cron: **full pass < 60s** for a tenant with 5,000 active members
- Weekly at-risk recompute cron: **full pass < 60s** for a tenant with 5,000 active members
- Weekly tier-upgrade evaluate cron: **full pass < 30s** for a tenant with 5,000 active members
- Member self-service renewal page: **TTFB < 600ms**, post-token-verify
- Member self-service confirm endpoint: **p95 < 1.2s** (including F4 invoice creation; F5 redirect not counted)

**Constraints**:
- **Multi-tenant isolation** (Constitution v1.4.0 Principle I, NON-NEGOTIABLE) — every F8 table carries `tenant_id` + RLS+FORCE; cross-tenant integration test is a Review-Gate blocker
- **Test-first** (Constitution Principle II, NON-NEGOTIABLE) — every user story has ≥1 failing acceptance test before implementation
- **Clean Architecture** (Constitution Principle III, NON-NEGOTIABLE) — `src/modules/renewals/` ships with public barrel + ESLint `no-restricted-imports` boundary rule
- **PCI DSS** (Constitution Principle IV, NON-NEGOTIABLE) — N/A: F8 has zero payment surface; F5 unchanged
- **i18n** (Constitution Principle V) — EN+TH+SV at release; Thai BE display rules apply for `th` locale
- **Inclusive UX / WCAG 2.1 AA** (Constitution Principle VI) — keyboard-first dashboard, screen-reader landmarks, no colour-only signalling
- **Performance & Observability** (Constitution Principle VII) — `docs/observability.md` SLOs + § 14 metrics wired before /speckit.verify
- **Reliability** (Constitution Principle VIII) — every mutating action audited, every cron idempotent, every external call retry-with-backoff
- **Code Quality** (Constitution Principle IX) — TypeScript strict, ESLint clean, Conventional Commits, solo-maintainer substitute applies (per F1+F4+F5+F7 precedent)
- **Simplicity** (Constitution Principle X) — no ML, no SMS, no auto-downgrade, no calendar-year anchor; all deferrals captured in OOS-1..OOS-12

**Scale/Scope**: Per-tenant up to **5,000 active members + 600 within 90-day window** (current SweCham scale: ~131 members / 164 contacts; F8 budgets at 38× current load to absorb future SaaS tenants). Up to **50 tenants** under one Chamber-OS deployment (post-F10 SaaS phase). Daily reminder volume: ~20 emails/tenant/day at SweCham scale, ~200/tenant/day at full scale. Weekly at-risk recompute volume: 5,000 score writes per tenant per week. Weekly tier-upgrade evaluate volume: 5,000 reads + ~10 suggestion writes per tenant per week.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*
*Source: `.specify/memory/constitution.md` v1.4.0*

**NON-NEGOTIABLE gates** (any FAIL blocks the plan; no waivers):

- [X] **I. Data Privacy & Security** — F8 reads PII (member primary contact email, plan history, invoice history) under documented lawful basis (Art. 6(1)(b) GDPR — performance of the membership contract; PDPA Section 24(1) consent + Section 24(5) contract performance). RBAC checks on every protected route per FR-052a (admin / manager / member). OWASP Top 10 mitigations: A01 (broken access control) — RBAC matrix in FR-052a; A02 (cryptographic failures) — TLS 1.2+ inherited from Vercel + at-rest AES-256 inherited from Neon; A03 (injection) — Drizzle parameterised queries + zod-validated boundaries; A05 (security misconfiguration) — Postgres RLS+FORCE on every F8 table; A07 (auth failures) — F1 session model unchanged + renewal-link tokens HMAC-SHA256 with dedicated secret + replay-detection. Multi-tenant isolation: 7 new tables all carry `tenant_id` + RLS+FORCE policies; mandatory cross-tenant integration test (Review-Gate blocker — `tests/integration/renewals/tenant-isolation.test.ts`); cross-tenant access logged as high-severity (`renewal_cross_tenant_probe`); F1 `users` exception unchanged.
- [X] **II. Test-First Development** — Each user story (US1–US6) has ≥1 acceptance test planned in `tasks.md` ahead of implementation. Coverage targets: Domain 100% line, Application 80% line+branch overall, **100% branch on security-critical use cases** (token verify, RBAC enforcement, cross-tenant context, lapsed-portal scope, bounce-threshold detection, F2 plan-change-on-renewal). Integration tests against live Neon (no mocked DB) for every state-machine transition and every cron pass.
- [X] **III. Clean Architecture** — One new bounded context `src/modules/renewals/` with `domain/` + `application/` + `infrastructure/` + public barrel `index.ts`. Domain layer carries `RenewalCycle`, `TierUpgradeSuggestion`, `RenewalEscalationTask`, `RenewalLinkToken`, `AtRiskScore` value objects with no `next` / `drizzle-orm` / `resend` / `react` imports — enforced by ESLint `no-restricted-imports` rule scoped to `src/modules/renewals/domain/**`. Application layer orchestrates Domain via ports (`RenewalGateway`, `RenewalLinkTokenSigner`, `RenewalLinkTokenVerifier`, `EventAttendeesPort`, `AtRiskScorer`, `RenewalAuditEmitter`); Drizzle types live in Infrastructure only. Public barrel exports use-cases (`dispatchRenewalCycle`, `computeAtRiskScore`, `evaluateTierUpgrade`, `acceptTierUpgrade`, `verifyRenewalLinkToken`, `confirmRenewal`, `markCycleCompleteFromInvoicePaid`) + types — no deep imports allowed from outside the module.
- [X] **IV. Payment Security (PCI DSS)** — **N/A**. F8 has zero payment surface. Renewal payments delegate to F5 unchanged via `createPaymentIntent` from F5's barrel; F5's SAQ A scope is unaffected by F8.

**Core principle gates** (FAIL must be justified in Complexity Tracking):

- [X] **V. Internationalization (SV/EN/TH)** — All F8 user-facing strings use i18n keys. EN canonical + TH + SV all ship at release per FR-051. Missing EN fails build; missing TH/SV falls back to EN with CI warning that becomes blocking on release branches. Thai Buddhist Era display rule applies for `th-TH` rendering of `expires_at`, `due_at`, `cycle.period_to` — display only, storage remains ISO 8601 UTC Gregorian. Estimated new i18n keys: ~180 across 3 locales = 540 entries (admin pipeline labels + at-risk widget + tier-upgrade queue + escalation task UI + member portal renewal flow + preferences + 5 reminder email templates × 5 schedule offsets).
- [X] **VI. Inclusive UX (Mobile First + WCAG 2.1 AA)** — All admin + portal surfaces designed mobile-first 320px+. WCAG 2.1 AA verified per FR-050 via axe-core E2E. Reuses shadcn/ui primitives + Tailwind v4 design tokens established in `004-page-layout-standard` + `006-layout-container-tier2`. Renewal pipeline uses TanStack Table v8 with full keyboard navigation (proven in F3 + F4 + F7).
- [X] **VII. Performance & Observability** — Performance budgets stated in FR-046, FR-057. Observability per FR-054 (12 OTel metrics) + FR-055 (5 root spans) + FR-056 (4 alert rules). pino structured logs with forbidden-fields redact list extended for F8 secrets (FR-049). All cron jobs emit per-pass duration metric for SLO tracking.
- [X] **VIII. Reliability** — Every error path explicitly handled. State-machine transitions are transactional (FR-023 marks paid + advances expires_at + cancels reminders + sends confirmation atomically). All 3 cron handlers are idempotent (FR-011 + FR-036). Audit trail of 42 events per FR-048 with retention 5 years.
- [X] **IX. Code Quality Standards** — TypeScript strict, ESLint clean, Conventional Commits, solo-maintainer substitute applies (per F1+F4+F5+F7 precedent — see Complexity Tracking entry #1).
- [X] **X. Simplicity (YAGNI)** — Zero new npm dependencies. No ML, no SMS, no auto-downgrade, no calendar-year anchor (all explicitly deferred in OOS-1..OOS-12 with rejected-alternative rationale). Rule-based scoring formula (8 factors, 0–100) is transparent, defensible, and extensible.

**Result**: All 10 principles **PASS**. Standing Complexity Tracking entries: #1 (solo-maintainer substitute), #2 (cross-module schema migration), #3 (F4 callback hook), #4 (F2 scheduled-plan-change), #5 (documentation-sync ritual), and #6 (TierUpgradeSuggestionBase<R> mapped-type DU — added Round 4 remediation 2026-05-04).

## Project Structure

### Documentation (this feature)

```text
specs/011-renewal-reminders/
├── plan.md              # This file (/speckit.plan command output)
├── research.md          # Phase 0 output (/speckit.plan command)
├── data-model.md        # Phase 1 output (/speckit.plan command)
├── quickstart.md        # Phase 1 output (/speckit.plan command)
├── contracts/           # Phase 1 output (/speckit.plan command)
│   ├── admin-renewals-api.md
│   ├── portal-renewal-api.md
│   ├── cron-renewals-api.md
│   └── audit-port.md
├── checklists/
│   └── requirements.md  # Spec quality checklist (/speckit.specify already created)
└── tasks.md             # Phase 2 output (/speckit.tasks command - NOT created by /speckit.plan)
```

### Source Code (repository root)

```text
src/
├── modules/
│   └── renewals/                         # F8 bounded context (NEW)
│       ├── domain/                       # Pure types — zero framework imports
│       │   ├── renewal-cycle.ts          # RenewalCycle aggregate + state machine
│       │   ├── renewal-cycle.spec.ts
│       │   ├── tier-upgrade-suggestion.ts
│       │   ├── tier-upgrade-suggestion.spec.ts
│       │   ├── renewal-escalation-task.ts
│       │   ├── renewal-link-token.ts     # Token payload type + invariants
│       │   ├── at-risk-score.ts          # Score formula + factors VO
│       │   ├── at-risk-score.spec.ts     # Property-based tests of formula
│       │   ├── tenant-renewal-settings.ts
│       │   ├── tenant-renewal-schedule-policy.ts
│       │   └── value-objects/
│       │       ├── tier-bucket.ts        # 5-value enum
│       │       ├── reminder-step.ts
│       │       ├── cycle-status.ts
│       │       └── risk-band.ts
│       ├── application/                  # Use cases — orchestrate Domain via ports
│       │   ├── dispatch-renewal-cycle.ts # Daily cron entry point — FR-010+FR-011+FR-012
│       │   ├── send-reminder-now.ts      # Admin manual dispatch — FR-018
│       │   ├── compute-at-risk-score.ts  # Weekly cron — FR-028+FR-029+FR-029a+FR-030
│       │   ├── evaluate-tier-upgrade.ts  # Weekly cron — FR-037+FR-038
│       │   ├── accept-tier-upgrade.ts    # Admin action — FR-039 (pending flow)
│       │   ├── apply-pending-tier-upgrade.ts  # Hook called by F4 createMembershipInvoice
│       │   ├── dismiss-tier-upgrade.ts
│       │   ├── escalate-tier-upgrade.ts
│       │   ├── snooze-at-risk-member.ts
│       │   ├── record-at-risk-outreach.ts
│       │   ├── verify-renewal-link-token.ts  # Public-route entry point — FR-026+FR-027
│       │   ├── load-renewal-summary.ts
│       │   ├── confirm-renewal.ts        # FR-022+FR-023+FR-024+FR-025
│       │   ├── mark-cycle-complete-from-invoice-paid.ts  # F4 hook
│       │   ├── opt-out-renewal-reminders.ts  # FR-016
│       │   ├── opt-in-renewal-reminders.ts
│       │   ├── detect-bounce-threshold.ts # FR-012a — F1 webhook hook
│       │   ├── reset-email-unverified.ts
│       │   ├── create-escalation-task.ts
│       │   ├── complete-escalation-task.ts
│       │   ├── skip-escalation-task.ts
│       │   ├── reassign-escalation-task.ts
│       │   ├── enforce-tenant-context-on-renewal.ts
│       │   ├── enforce-rbac-on-f8-mutation.ts
│       │   ├── enforce-lapsed-portal-scope.ts
│       │   └── ports/                    # Application-layer port interfaces
│       │       ├── renewal-gateway.ts    # Transactional email dispatch
│       │       ├── renewal-link-token-signer.ts
│       │       ├── renewal-link-token-verifier.ts
│       │       ├── event-attendees-port.ts # F6-readiness probe + count queries
│       │       ├── at-risk-scorer.ts
│       │       ├── renewal-audit-emitter.ts
│       │       ├── renewal-cycle-repo.ts
│       │       ├── renewal-reminder-event-repo.ts
│       │       ├── tier-upgrade-suggestion-repo.ts
│       │       ├── renewal-escalation-task-repo.ts
│       │       ├── tenant-renewal-settings-repo.ts
│       │       └── tenant-renewal-schedule-policy-repo.ts
│       ├── infrastructure/               # Adapters — implements Application ports
│       │   ├── drizzle/
│       │   │   ├── schema.ts             # 7 new tables + 4 column additions on F3 members + 1 on F2 plans
│       │   │   ├── drizzle-renewal-cycle-repo.ts
│       │   │   ├── drizzle-renewal-reminder-event-repo.ts
│       │   │   ├── drizzle-tier-upgrade-suggestion-repo.ts
│       │   │   ├── drizzle-renewal-escalation-task-repo.ts
│       │   │   ├── drizzle-tenant-renewal-settings-repo.ts
│       │   │   └── drizzle-tenant-renewal-schedule-policy-repo.ts
│       │   ├── resend/
│       │   │   └── resend-transactional-renewal-gateway.ts  # Reuses F1+F4 client
│       │   ├── tokens/
│       │   │   ├── hmac-renewal-link-signer.ts
│       │   │   └── hmac-renewal-link-verifier.ts
│       │   ├── ports-adapters/
│       │   │   ├── f3-member-repo-bridge.ts
│       │   │   ├── f4-invoice-bridge.ts  # Reads + emits to F4 barrel
│       │   │   ├── f4-invoice-paid-listener.ts  # Subscribes to F4 invoice_marked_paid event
│       │   │   ├── f2-plan-change-bridge.ts # Calls F2 changeMemberPlan
│       │   │   ├── f6-event-attendees-port-stub.ts # Returns isAvailable=false until F6 ships
│       │   │   └── f1-bounce-event-listener.ts  # Subscribes to F1 email_delivery_events
│       │   └── audit-emitter.ts
│       ├── presentation/                 # OPTIONAL barrel — server-action wrappers reusable across pages
│       └── index.ts                      # Public barrel — only exported surface
├── app/
│   ├── (staff)/
│   │   └── admin/
│   │       └── renewals/                 # Admin pipeline + at-risk + tier-upgrade + tasks (NEW)
│   │           ├── page.tsx              # Pipeline list + tier filter
│   │           ├── loading.tsx           # Shimmer skeleton
│   │           ├── _components/
│   │           │   ├── pipeline-table.tsx
│   │           │   ├── urgency-bucket-tabs.tsx
│   │           │   ├── lapsed-tab.tsx
│   │           │   ├── at-risk-widget.tsx
│   │           │   ├── tier-upgrade-queue.tsx
│   │           │   ├── escalation-task-queue.tsx
│   │           │   └── send-reminder-button.tsx
│   │           ├── settings/
│   │           │   └── schedules/
│   │           │       ├── page.tsx      # Schedule policy editor (FR-009)
│   │           │       └── _components/
│   │           │           └── schedule-editor.tsx
│   │           └── tasks/
│   │               └── page.tsx          # Escalation task list
│   ├── (member)/
│   │   └── portal/
│   │       ├── renewal/
│   │       │   └── [memberId]/
│   │       │       ├── page.tsx          # Self-service renewal flow
│   │       │       ├── loading.tsx
│   │       │       ├── _components/
│   │       │       │   ├── benefit-summary.tsx
│   │       │       │   ├── plan-change-selector.tsx
│   │       │       │   └── confirm-renewal-button.tsx
│   │       │       └── confirm/
│   │       │           └── route.ts      # POST confirm endpoint
│   │       └── preferences/
│   │           └── renewals/
│   │               └── page.tsx          # Opt-out toggle (FR-016)
│   └── api/
│       ├── admin/renewals/               # Admin mutating endpoints
│       │   ├── [cycleId]/
│       │   │   ├── send-reminder-now/route.ts
│       │   │   └── cancel/route.ts
│       │   ├── at-risk/[memberId]/
│       │   │   ├── snooze/route.ts
│       │   │   └── outreach/route.ts
│       │   ├── tier-upgrades/[suggestionId]/
│       │   │   ├── accept/route.ts
│       │   │   ├── dismiss/route.ts
│       │   │   └── escalate/route.ts
│       │   ├── tasks/[taskId]/
│       │   │   ├── done/route.ts
│       │   │   ├── skip/route.ts
│       │   │   └── reassign/route.ts
│       │   └── settings/
│       │       ├── schedules/route.ts    # PUT update schedule policy
│       │       └── tenant/route.ts       # PUT update tenant settings
│       ├── portal/renewal/[memberId]/
│       │   ├── route.ts                  # GET renewal page data via token
│       │   └── confirm/route.ts          # POST confirm renewal
│       ├── portal/preferences/
│       │   └── renewals/route.ts         # POST toggle opt-out
│       └── cron/renewals/                # Cron-job.org HTTP triggers
│           ├── dispatch/route.ts         # Daily reminder dispatch
│           ├── at-risk-recompute/route.ts # Weekly at-risk recompute
│           └── tier-upgrade-evaluate/route.ts # Weekly tier-upgrade evaluate
├── components/
│   └── renewals/                         # Cross-module reusable F8 components
│       ├── tier-badge.tsx                # 5-bucket tier visual + a11y label
│       ├── urgency-pill.tsx              # T-90 / T-30 / T-7 / T-0 / Grace / Lapsed
│       ├── risk-score-badge.tsx
│       └── escalation-task-row.tsx
└── lib/
    └── env.ts                            # Extended with FEATURE_F8_RENEWALS + RENEWAL_LINK_TOKEN_SECRET

drizzle/migrations/
├── 0086_f8_create_scheduled_plan_changes_table.sql  # F2 cross-module table (Complexity #4) — F8-PR-delivered per F7 precedent
├── 0087_f8_create_renewal_cycles_table.sql
├── 0088_f8_create_renewal_reminder_events_table.sql
├── 0089_f8_create_tenant_renewal_config_tables.sql  # tenant_renewal_settings + tenant_renewal_schedule_policies consolidated
├── 0090_f8_create_at_risk_outreach_table.sql
├── 0091_f8_create_tier_upgrade_suggestions_table.sql
├── 0092_f8_create_renewal_escalation_tasks_table.sql
├── 0093_f8_create_consumed_link_tokens_table.sql
└── 0094_f8_extend_members_and_plans_columns.sql  # F3 + F2 column extensions
# Note: 0084 + 0085 are F7 post-ship migrations already on main (audit-log retention + R6 staff-review).
# F8 owns 9 migrations 0086-0094. Renumbered at /speckit.critique 2026-05-03 round 2 / M1, extended at /speckit.tasks audit / M1.

tests/
├── contract/
│   ├── admin-renewals-api.contract.test.ts
│   ├── portal-renewal-api.contract.test.ts
│   ├── cron-renewals-api.contract.test.ts
│   └── audit-port.contract.test.ts
├── integration/renewals/
│   ├── tenant-isolation.test.ts          # Review-Gate blocker (Principle I)
│   ├── dispatch-cron-idempotency.test.ts # FR-011
│   ├── renewal-link-token.test.ts        # FR-026+FR-027
│   ├── at-risk-f6-fallback.test.ts       # FR-029a (Q3 round 1)
│   ├── bounce-threshold.test.ts          # FR-012a (Q4 round 2)
│   ├── tier-upgrade-pending.test.ts      # FR-039 (Q5 round 2)
│   ├── rbac-defence-in-depth.test.ts     # FR-052a (Q1 round 2)
│   ├── lapsed-portal-scope.test.ts       # FR-005 (Q3 round 2)
│   ├── multi-year-cycle.test.ts          # FR-010 + Q4 round 1
│   └── self-service-renewal-tx.test.ts   # US3 atomic transaction
├── unit/renewals/
│   └── (mirrors src/modules/renewals/{domain,application}/* file names)
└── e2e/
    ├── renewal-pipeline-dashboard.spec.ts
    ├── tier-aware-reminder-cron.spec.ts
    ├── member-self-service-renewal.spec.ts
    ├── at-risk-widget.spec.ts
    ├── auto-tier-upgrade.spec.ts
    ├── escalation-task-queue.spec.ts
    ├── renewal-a11y.spec.ts
    ├── renewal-i18n.spec.ts
    ├── lapsed-portal-scope.spec.ts
    └── manager-readonly.spec.ts

src/i18n/messages/
├── en.json   # +~180 new F8 keys
├── th.json
└── sv.json
```

**Structure Decision**: F8 follows the established Chamber-OS bounded-context pattern (one module under `src/modules/renewals/` with explicit `domain/` + `application/` + `infrastructure/` subdirectories + a public barrel). Presentation lives in `src/app/(staff)/admin/renewals/**` and `src/app/(member)/portal/renewal/**` using Next.js App Router server components + server actions; cross-module reusable components go to `src/components/renewals/`. Cron handlers live under `src/app/api/cron/renewals/*`. All 7 new tables migrate under `drizzle/migrations/0084–0091`. ESLint `no-restricted-imports` rule extended with `@/modules/renewals/**` deep-import block + Domain-layer `@tiptap/*` `next` `drizzle-orm` `resend` `react` block (mirror F7 Domain rules). i18n keys live in the existing `src/i18n/messages/{en,th,sv}.json` files (no new locale files).

## PR Sequencing & Cross-Module Coordination (added /speckit.critique round 2 / E3-r2)

F8 implementation depends on small additive PRs to F1, F2, F4 modules (all owned by the same solo maintainer). PR sequencing MUST be respected to avoid blocking F8 PR merge:

1. **F4 callback PR** (Complexity Tracking #3) — extends `markPaidFromProcessor` with `onPaidCallbacks` parameter + adds `F4InvoicePaidEvent` canonical type to F4 barrel. ~10 lines + 1 contract test (callback fires once + rollback on callback failure). Merge first.
2. **F2 scheduled-plan-change PR** (Complexity Tracking #4) — adds `scheduleNextRenewalPlanChange` use-case + `scheduled_plan_changes` table + `getEffectivePlanForRenewal` resolver to F2 barrel. ~50 lines + 3 contract tests + 1 migration. Merge second.
3. **F1 subdomain-routing PR** (Complexity Tracking #5 — pre-condition for post-F10 era only) — F1's existing `resolveTenantFromRequest()` abstraction in `src/lib/tenant-context.ts` already handles MVP single-tenant era via constant `env.tenant.slug`. F8 does NOT extend F1 in this branch (per M4 round-2 verification: F8 verifier code is era-agnostic). When F10 ships multi-tenant routing later, F1's `resolveTenantFromRequest` body extends to subdomain resolution; F8 verifier picks up automatically. **No F1 PR required for F8 ship.**
4. **F8 PR** (this branch) — consumes F4 + F2 extensions. Merge last after PRs 1+2 land on main.

**Phase milestones inside F8 PR** (E4-r2 round 2; full task breakdown deferred to `/speckit.tasks`):

- **Phase 1 — Setup**: env vars + dependencies + module skeleton + 8 migrations 0086-0093 + RLS+FORCE policies
- **Phase 2 — Foundational**: Domain entities + value objects + ports + composition root + ESLint barrel rules
- **Phase 3 — US1 (Renewal Pipeline Dashboard)** + Phase 3 checkpoint
- **Phase 4 — US2 (Tier-Aware Reminder Cron + Schedule Editor)** + Phase 4 checkpoint
- **Phase 5 — US3 (Member Self-Service Renewal Flow)** + Phase 5 checkpoint
- **Phase 6 — US4 (At-Risk Widget)** + Phase 6 checkpoint
- **Phase 7 — US5 (Tier-Upgrade Suggestions)** + Phase 7 checkpoint
- **Phase 8 — US6 (Escalation Task Queue)** + Phase 8 checkpoint
- **Phase 9 — Cross-cutting** (RBAC matrix, observability, kill-switches, FR-005a middleware, FR-005b/c/d auto-reactivation flow, audit emitter wiring, OTel spans, alert rules)
- **Phase 10 — Polish & verify** (perf benchmarks, i18n coverage, a11y axe-core, E2E full pass, retrospective)

Each phase ends with a `pnpm test` + `pnpm test:integration` green checkpoint before next phase starts (mirrors F7 pattern). Solo-maintainer substitute review passes (per Complexity #1) ship at Phase 9 / Phase 10 transitions.

## Complexity Tracking

> **Filled because Constitution Check has 2 deliberate deviations that must be documented**

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| **#1 — Solo-maintainer substitute clause invoked for Principle IX (≥2-reviewer rule)** | Project is currently single-maintainer (Jirawat P.); no second human reviewer is available. Constitution v1.4.0 § IX explicitly authorises this substitute when `(a)` no second maintainer exists AND `(b)` the 5-stack of automated checks is run. **Substitute stack for F8**: (1) ≥3 `/speckit.review` passes with progressively decreasing severity counts, (2) ≥2 `/speckit.staff-review` rounds (correctness + security + tests triangulation; second round mandatory if any BLOCKER/CRITICAL surfaces in round 1), (3) test-coverage targets met (Domain 100% line; Application 80% line+branch; 100% branch on the 11 security-critical use cases enumerated in `## Technical Context › Testing`), (4) DB-level + RLS-level defence-in-depth on every invariant (RLS+FORCE on all 8 tables, partial unique indexes on idempotency keys, transactional state-machine constraints), (5) post-remediation verification by a fresh agent run for every finding. Maintainer co-signs the security checklist alongside the staff-review agent. | Default ≥2-reviewer rule cannot be satisfied because no second maintainer exists at this stage of Chamber-OS development. The substitute stack is the same one used for F1 + F4 + F5 + F7 (all shipped under the substitute clause); when a second maintainer joins the project, F8 reverts automatically to the default rule per the substitute's reversible nature. |
| **#2 — Cross-module schema migration: F8 adds `renewal_tier_bucket` enum column to F2's `membership_plans` table** | The /speckit.clarify Q2 round 1 decision (5 fixed tier buckets) requires a `renewal_tier_bucket` field on every F2 plan row to bucket-resolve schedule policies. Two architectural alternatives were considered: (a) F8 adds the column to F2's table directly via migration 0091, (b) F8 keeps the bucket mapping in a F8-owned join table `f2_plan_to_bucket_mapping` referencing F2's `plan_id`. Option (a) was chosen because the bucket attribute is a fundamental property of the plan (not metadata layered on top), F2's plan model is stable enough to extend, the column is NOT NULL with a default backfill in the same migration, and the /speckit.clarify Assumption A7 explicitly anticipated this with "F8's plan will add a small migration to F2's `membership_plans` table (must be coordinated with F2 maintainers)". Cross-module coordination: F8's migration 0091 includes `ALTER TABLE membership_plans ADD COLUMN renewal_tier_bucket text NOT NULL DEFAULT 'regular'` followed by a backfill `UPDATE membership_plans SET renewal_tier_bucket = ...` mapping each existing SweCham plan to the right bucket per `docs/membership-benefits-analysis.md`. F2's barrel is extended with `getPlanBucket(planId)` so F8's cron uses the F2 public surface, not direct table access. | Option (b) join-table was rejected because: (1) it introduces a 1:1 join on every cron eligibility query (perf cost on the hot path FR-046 budget), (2) the bucket value is semantically a plan attribute, not extrinsic metadata, (3) it creates a synchronisation hazard if a new F2 plan ships without a matching F8 mapping row (silent fallback to 'regular'), whereas a NOT NULL column makes it impossible to forget. The architectural intent is "bucket is part of what a plan IS", not "bucket is a thing F8 happens to associate with a plan". |
| **#3 — Cross-module integration: F4 invoice-paid hook for F8 cycle completion** (added /speckit.critique 2026-05-03 round 1 / E2; **LOCKED at /speckit.clarify Session 2026-05-03 round 3 Q3 — Option A**) | FR-022/FR-023 + the `markCycleCompleteFromInvoicePaid` use-case require F4 to expose an "invoice marked paid" event that F8 listens to inside the same DB transaction (preserves cycle-complete + invoice-paid atomicity per FR-023). F4's current `markPaidFromProcessor` is an internal mutation with no callback surface. **Coordinated extension** (Option A — locked): F4's `markPaidFromProcessor` use-case adds an optional `onPaidCallbacks: ((evt: F4InvoicePaidEvent) => Promise<void>)[]` parameter populated at composition-root wiring; F8 pushes a `markCycleCompleteFromInvoicePaid` callback into this array; F4 invokes each callback inside the same DB transaction that persists the invoice state change. If any callback throws, F4 rolls back the entire tx — invoice stays unpaid + cycle stays `awaiting_payment` + F5 webhook records failure for retry. F4 contract test asserts callback fires exactly once per state-transition + rollback path on callback failure. F4InvoicePaidEvent canonical shape documented in research.md R12. **Wave A implementation deviation (E1, /speckit.verify.run 2026-05-03)**: research draft placed `onPaidCallbacks` on `markPaidFromProcessor`'s second-argument options object; implementation places it on `RecordPaymentDeps` (composition-root surface) + threads via the wrapper input. Functionally equivalent for the locked Option A semantics — same atomic invocation point inside `withTx`, same first-rejection rollback — but the deps-side placement also benefits the F4 admin manual mark-paid path and any future direct `recordPayment` callers (e.g. F8's own `mark-paid-offline` use-case in Phase 3+) without needing to thread a fresh closure list through every call site. Plan auditors signed off on Option A; the deps-vs-input mechanism does not alter the locked atomic-rollback contract. | Polling F4 invoices for state changes (rejected): wasteful + introduces lag. Eventually-consistent pub-sub (research.md R12 Option B, REJECTED at Q3): risks "invoice paid but cycle not yet completed" inconsistency window, breaks the FR-023 atomic-transaction guarantee. New domain-event bus infra (Option C, REJECTED): YAGNI at MVP. F4 contract change is small (~10 lines + 1 test) and the architectural cleanliness justifies the cross-module coordination. |
| **#4 — Cross-module integration: F2 scheduled-plan-change use-case for tier-upgrade pending flow** (added /speckit.critique 2026-05-03 round 1 / E3) | The Q5 round-2 tier-upgrade pending lifecycle requires F2 awareness of "effective at next renewal cycle" timing. F2's current `changeMemberPlan` is immediate-only. **Coordinated extension** (per research.md R13): F2's barrel gains a new use-case `scheduleNextRenewalPlanChange(memberId, {effectiveAtCycleId, newPlanId})` plus a new F2-owned table `scheduled_plan_changes`. F4's renewal-invoice-creation hook calls F2's `getEffectivePlanForRenewal(memberId, cycleId)` to resolve the plan price; after F4 invoice marked paid, F2 transitions the scheduled-change row to `applied` + updates `members.plan_id` atomically. F2 emits `member_plan_manually_changed` event when admin manually overrides; F8 listens and transitions suggestion to `superseded`. | Storing the pending plan change in F8's table (rejected): F2 owns plan-related state per Clean Architecture Principle III. Calling F2's immediate `changeMemberPlan` at F4 invoice time (feasible but rejected): couples plan-change timing to invoice creation; misses rollback case. The chosen extension keeps F2 authoritative for plan state and lets F8 stay a "suggestion envelope" module. |
| **#5 — Documentation-sync ritual at end of each clarify round** (added /speckit.critique 2026-05-03 round 2 / X1-r2 + M2 finding) | Round 3 clarify session added schema deltas (frozen-price columns + admin-reactivation flag + new state + new task_type + 5 audit events) to spec.md but failed to propagate to data-model.md until critique round 2 caught the drift. Single solo maintainer working across 6 docs (spec, plan, research, data-model, contracts/*, quickstart) at >3000 lines = high context-switch cost; mid-round drift goes undetected. **Process commitment**: at end of each `/speckit.clarify` session, propagate every accepted decision to ALL affected artefacts in the same write window — no "I'll sync later" deferral. Add a sync-checklist as a sub-step of `/speckit.clarify` skill output. | Defer-to-/speckit.tasks pickup (rejected): rework cost grows linearly with each round; M2 round-2 critique demonstrated this. Per-round reviewer (rejected): solo maintainer can't add a second reviewer. The chosen process puts the discipline upstream at the round close. |
| **#6 — `TierUpgradeSuggestionBase<R>` mapped-type DU yields 21 concrete shapes** (added Round 4 review remediation, /speckit.verify.run 2026-05-04 G2) | Round 4 type-design review found the previous `TierUpgradeSuggestionBase` (non-generic) + `evidence: TierUpgradeEvidence` (closed 3-arm DU) admitted incoherent state where the two `reasonCode` discriminators could disagree (e.g. `{ reasonCode: 'multi_signal', evidence: { reasonCode: 'declared_turnover_above_threshold', ... } }`). **Coordinated extension**: the base interface now takes a generic `R extends TierUpgradeReasonCode` parameter that propagates to `evidence: Extract<TierUpgradeEvidence, { reasonCode: R }>`, and `TierUpgradeSuggestion` distributes via `{ [R in TierUpgradeReasonCode]: Base<R> & (...7 lifecycle arms) }[TierUpgradeReasonCode]`. Net effect: 21 valid concrete shapes (3 reasonCodes × 7 lifecycle arms) — the compiler now refuses to construct a suggestion with mismatched reasonCode discriminators. **Diverges from F7 `Suggestion` non-generic precedent** which uses a flat `reasonCode + payload` pair without the cross-discriminator tie. Justified because F8's evidence is forensics-load-bearing per audit-port.md `tier_upgrade_pending_superseded_by_manual_change` (the audit row depends on `evidence.reasonCode` matching the `reasonCode` to be coherent for reviewers); F7's broadcasts have no equivalent forensic constraint. | Keeping the non-generic shape (rejected): Round 4 review confirmed runtime invariant assertions cannot prevent the incoherent-state class — only the type system can. Adding a runtime `assertEvidenceMatchesReason()` (rejected): defensive but lossy; an incoherent suggestion would already be persisted before runtime catches it, requiring a delete + re-insert which violates the audit-trail-append-only invariant. The mapped-type form is the only mechanism that catches the bug at construction time. Verbosity (21 vs 7 inferred shapes) is acceptable given the IDE hover shows the resolved shapes per concrete `R`. |

## Phase 0: Outline & Research

See `research.md` (generated alongside this plan) for the consolidated findings on:

1. **Renewal-link token design** — HMAC-SHA256 vs JWT; secret rotation; single-use enforcement via `consumed_link_tokens` table; TTL 30 days
2. **Cron idempotency pattern** — `SELECT … FOR UPDATE SKIP LOCKED` + `pg_advisory_xact_lock` per tenant; namespace `renewals:` disjoint from F4 `invoicing:` and F5 `payments:` and F7 `broadcasts:`
3. **Membership year anchor maths** — `expires_at` derivation from F4 paid invoices; rollover atomicity; multi-year cycle handling per Q4 round 1
4. **At-risk score formula calibration** — 8-factor weighting validation against synthetic data; band threshold rationale
5. **F6 readiness probe pattern** — feature-port `EventAttendeesPort.isAvailable()` returning `false` until F6 ships; mirroring F7's `EventAttendeesRepository` stub-port
6. **Transactional vs marketing email separation** — why F8 uses F1+F4 transactional Resend (NOT F7 Resend Broadcasts); legal basis under PDPA §24 + GDPR Art. 6(1)(b)
7. **Tier-upgrade pending state lifecycle** — Q5 round 2 design; F4 invoice-creation hook integration; member email cadence; T-180 admin re-verification task
8. **F1 bounce-event integration** — event-driven threshold detection via F1 webhook; `email_delivery_events` schema reuse
9. **5 tier buckets backfill** — mapping SweCham 2026 Membership Package PDF tiers to canonical 5-bucket enum; migration safety
10. **Cron-job.org operational pattern** — reusing F4/F5/F7 setup (Bearer auth, secret rotation, runbook); 3 new endpoints (`dispatch` daily, `at-risk-recompute` weekly Sun 02:00, `tier-upgrade-evaluate` weekly Sun 03:00)

**Output**: `research.md` with all decisions documented (Decision / Rationale / Alternatives Considered format).

## Phase 1: Design & Contracts

**Prerequisites**: `research.md` complete

1. **Extract entities** → `data-model.md`:
   - Full schema for the 7 new tables + 5 new columns on `members` + 1 new column on `membership_plans`
   - State machine for `renewal_cycles.status` (`upcoming → reminded → awaiting_payment → completed | lapsed | cancelled`)
   - State machine for `tier_upgrade_suggestions.status` (`open → accepted_pending_apply → applied`; `open → dismissed`; `accepted_pending_apply → superseded`)
   - State machine for `renewal_escalation_tasks.status` (`open → done | skipped`)
   - 42 audit event types catalogued with payload schemas + retention 5 years
   - RLS policies + FORCE flag per table
   - Index list with rationale (perf vs storage trade-off)

2. **Define interface contracts** → `/contracts/`:
   - `admin-renewals-api.md` — every admin endpoint (pipeline read, manual send, snooze, accept/dismiss/escalate tier-upgrade, task mutations, schedule policy editor, settings editor)
   - `portal-renewal-api.md` — token-verify GET, confirm POST, plan-change selector, preferences toggle
   - `cron-renewals-api.md` — 3 cron endpoints (Bearer-auth contract, request shape, idempotency semantics, exit reasons)
   - `audit-port.md` — full taxonomy of 42 audit event types with payload TypeScript types

3. **Quickstart** → `quickstart.md`:
   - Local dev setup (env vars: `FEATURE_F8_RENEWALS=true`, `RENEWAL_LINK_TOKEN_SECRET`, `CRON_SECRET` reused)
   - Seed script for renewal-cycle test data
   - cron-job.org configuration cheat-sheet for staging
   - Bypass procedures for staging (manual cron trigger via curl + Bearer)
   - Rollback procedures (kill-switch flip + `READ_ONLY_MODE` interaction)

4. **Agent context update**:
   - Run `.specify/scripts/powershell/update-agent-context.ps1 -AgentType claude` to update `CLAUDE.md`'s Active Technologies section with F8 entries (no new dependencies, but new bounded context + new cron endpoints + new env vars).

**Output**: `data-model.md`, `contracts/admin-renewals-api.md`, `contracts/portal-renewal-api.md`, `contracts/cron-renewals-api.md`, `contracts/audit-port.md`, `quickstart.md`, updated `CLAUDE.md`.

## Post-Design Constitution Re-check

After Phase 1 design artefacts are generated, the Constitution Check is re-evaluated against the concrete data model + contracts:

- All 10 principles still **PASS** (no new violations introduced by the design phase).
- 6 Complexity Tracking entries (entries #1–#5 standing; #6 added Round 4 remediation 2026-05-04).
- Solo-maintainer substitute remains the operational mode for the Review gate.
- The cross-module migration in entry #2 is bounded and additive (NOT NULL with default + backfill in same tx; F2 barrel extension is additive only).

**Result**: Plan ready for `/speckit.tasks`.

## Stop & Report

`/speckit.plan` ends after Phase 0 + Phase 1 artefacts are generated. Next command: `/speckit.tasks`.

Generated artefacts (paths absolute when run via tool):

- `specs/011-renewal-reminders/plan.md` (this file)
- `specs/011-renewal-reminders/research.md`
- `specs/011-renewal-reminders/data-model.md`
- `specs/011-renewal-reminders/contracts/admin-renewals-api.md`
- `specs/011-renewal-reminders/contracts/portal-renewal-api.md`
- `specs/011-renewal-reminders/contracts/cron-renewals-api.md`
- `specs/011-renewal-reminders/contracts/audit-port.md`
- `specs/011-renewal-reminders/quickstart.md`
- `CLAUDE.md` (Active Technologies section appended)
