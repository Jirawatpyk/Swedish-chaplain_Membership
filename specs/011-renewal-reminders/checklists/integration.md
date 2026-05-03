# Cross-Module Integration Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that cross-module integration requirements (F1 / F2 / F3 / F4 / F5 / F6 / F7) + external service contracts (Resend transactional vs Broadcasts, cron-job.org, F1 tenant-context abstraction) + PR sequencing + migration coordination + env var dependencies are complete, clear, consistent, and unambiguous.

**Created**: 2026-05-03
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## F1 Integration Requirements

- [ ] CHK001 - Are F1 transactional Resend usage requirements explicit (use F1 surface, NOT F7 Broadcasts)? [Clarity, Spec §FR-019]
- [ ] CHK002 - Are F1 webhook → F8 `detectBounceThreshold` synchronous-call contract requirements documented (failure-mode, retry, idempotent, fast)? [Completeness, Spec §research.md R8 rev-2]
- [ ] CHK003 - Is F1's `resolveTenantFromRequest()` usage rule era-agnostic (compatible with MVP single-tenant + post-F10 multi-tenant)? [Consistency, Spec §FR-026, §research.md R1]
- [ ] CHK004 - Are F1 `email_delivery_events` schema dependency requirements specified for FR-012a bounce detection? [Completeness, Spec §FR-012a]
- [ ] CHK005 - Are F1 audit_log retention scheme + tenant_id + retention_years column dependencies documented? [Completeness, Spec §FR-048]

## F2 Integration Requirements

- [ ] CHK006 - Are F2 `scheduleNextRenewalPlanChange` use-case requirements specified with full TS signature? [Completeness, Spec §research.md R13, §Complexity Tracking #4]
- [ ] CHK007 - Are F2 `getEffectivePlanForRenewal(memberId, cycleId)` resolver requirements clear about return shape (current OR pending plan)? [Clarity, Spec §research.md R13]
- [ ] CHK008 - Are F2 `renewal_tier_bucket` coordinated migration requirements (NOT NULL backfill + 5-bucket enum CHECK) specified? [Completeness, Spec §Complexity Tracking #2]
- [ ] CHK009 - Is F2 `getPlanBucket(planId)` barrel-export requirement documented? [Completeness, Spec §Complexity Tracking #2]
- [ ] CHK010 - Are F2 `member_plan_manually_changed` event listener requirements (F8 listens, transitions suggestion to `superseded`) specified? [Completeness, Spec §research.md R13, §FR-039 step 5]

## F3 Integration Requirements

- [ ] CHK011 - Are F3 `members.primary_contact_email` dependency requirements specified for renewal communications? [Completeness, Spec §A9]
- [ ] CHK012 - Are F3 archive cascade requirements complete (cycle cancel + tasks cancel + suggestions cancel) for all F8 entities? [Coverage, Spec §FR-053]
- [ ] CHK013 - Are F3 GDPR erasure cascade requirements specified for F8 entities (audit kept, PII fields scrubbed)? [Completeness, Spec §FR-053]
- [ ] CHK014 - Are F3 column extension requirements (9 new columns including `blocked_from_auto_reactivation` group) consistent across spec + data-model + migration? [Consistency, Spec §FR-005b, §data-model.md § 3.1]

## F4 Integration Requirements

- [ ] CHK015 - Is the `F4InvoicePaidEvent` canonical shape unambiguously defined? [Clarity, Spec §research.md R12]
- [ ] CHK016 - Are F4 `markPaidFromProcessor` callback parameter requirements (Option A LOCKED) consistent? [Consistency, Spec §research.md R12, §Complexity Tracking #3]
- [ ] CHK017 - Are F4 `createMembershipInvoice` input requirements (member_id, plan_id, period, frozen-price-from-cycle) specified? [Completeness, Spec §FR-022]
- [ ] CHK018 - Are F4 renewal-invoice creation hook requirements (consult F2 `getEffectivePlanForRenewal` for pending tier upgrades) specified? [Completeness, Spec §research.md R13]
- [ ] CHK019 - Are F4 receipt-PDF generation requirements (delegated to F4, F8 just links) clear? [Clarity, Spec §FR-023]

## F5 Integration Requirements

- [ ] CHK020 - Is F5 admin-triggered `issueRefund(invoiceId, reason)` use-case pre-condition documented (verify F5 exposes this)? [Dependency, Spec §FR-005d]
- [ ] CHK021 - Are F5 payment_succeeded → F4 markPaidFromProcessor → F8 onPaidCallback chain requirements clear about ordering + atomicity? [Clarity, Spec §research.md R12, §FR-023]
- [ ] CHK022 - Are F5 payment_failed handling requirements (cycle stays awaiting_payment + reminder schedule resumes) specified? [Completeness, Spec §FR-024]

## F6 Integration Requirements

- [ ] CHK023 - Are `EventAttendeesPort.isAvailable()` contract requirements specified for both stub-port (returns false) AND future F6 implementation (returns true + count)? [Coverage, Spec §FR-029a, §research.md R5]
- [ ] CHK024 - Are at-risk score F6-readiness fallback requirements (skip event-attendance factors when port unavailable; proportional bands) measurable? [Measurability, Spec §FR-029a, §FR-030]
- [X] CHK025 - Is the F6 contract assertion (F6's `findRecentAttendeeEmails` returns `string[]` lowercase emails) stable for F8 consumption? [Clarity, Spec §research.md R5 §F6 contract assertion + contract test — gap-resolved]

## F7 Integration Requirements (Operational pattern reuse only)

- [ ] CHK026 - Is the F7 cron-job.org operational pattern reuse explicit (Bearer auth via shared `CRON_SECRET` rotated atomically)? [Completeness, Spec §plan.md Predecessors, §research.md R10]
- [ ] CHK027 - Is the F7 tenant-isolation integration test scaffold reuse rule documented (F8 ships matching test scaffold pattern)? [Completeness, Spec §plan.md Testing]
- [ ] CHK028 - Are F8 vs F7 audit event taxonomy boundaries clear (F8 owns 56 events, none overlap with F7)? [Consistency, Spec §FR-048]

## Cron-job.org Operational Requirements

- [ ] CHK029 - Are 6 cron-job.org jobs (3 main coordinator + 3 housekeeping) configured with explicit endpoints + cadence + Bearer auth? [Completeness, Spec §contracts/cron-renewals-api.md § 4]
- [ ] CHK030 - Are cron-job.org failure-notification requirements (ops@... email) consistent across all 6 jobs? [Consistency, Spec §contracts/cron]
- [ ] CHK031 - Are secret-rotation procedure requirements (single env var update across F4/F5/F7/F8) documented? [Completeness, Spec §contracts/cron § 4]

## Env Vars & Configuration

- [ ] CHK032 - Are F8 env var requirements (`FEATURE_F8_RENEWALS`, `FEATURE_F8_AT_RISK_DISABLED`, `RENEWAL_LINK_TOKEN_SECRET_PRIMARY`, optional `_FALLBACK`, reused `CRON_SECRET` + `RESEND_API_KEY` + `DATABASE_URL`) enumerated? [Completeness, Spec §quickstart.md § 1, §FR-052b]
- [ ] CHK033 - Are env var validation requirements (zod schema in `src/lib/env.ts`) consistent (32-byte minimum for tokens; refuse boot if missing)? [Consistency, Spec §quickstart.md § 1]

## Migration Coordination

- [ ] CHK034 - Are F8 migration numbering requirements (0086-0093) consistent across plan + data-model + quickstart? [Consistency, Spec §plan.md, §data-model.md § 6, §quickstart.md § 2]
- [ ] CHK035 - Are migration atomicity requirements (DDL + RLS + seed in same tx; CREATE INDEX CONCURRENTLY out-of-tx) consistent across all 8 migrations? [Consistency, Spec §data-model.md § 6]
- [ ] CHK036 - Are F2 + F3 cross-module column extension requirements (migration 0093 owns the cross-table changes) explicit about coordination with F2/F3 maintainer? [Completeness, Spec §Complexity Tracking #2]
- [ ] CHK037 - Are migration rollback (DOWN script) requirements specified for emergency revert? [Completeness, Spec §data-model.md § 6]

## PR Sequencing

- [ ] CHK038 - Are PR sequencing requirements (F4 callback PR → F2 schedule-plan-change PR → F8 PR) explicitly enumerated with prerequisite tasks? [Completeness, Spec §plan.md PR Sequencing]
- [ ] CHK039 - Are F1 subdomain-routing-extension requirements clearly out-of-scope-for-F8 (deferred to F10 per M4 round 2)? [Clarity, Spec §plan.md PR Sequencing, §research.md R1]
- [ ] CHK040 - Are phase milestone requirements (10 phases mirroring F7) defined with green-checkpoint exit criteria? [Completeness, Spec §plan.md PR Sequencing]

## Forward-Compat & Future Eras

- [ ] CHK041 - Are F12 custom-domain forward-compat requirements explicit (URL pattern works with custom domain at post-MVP)? [Coverage, Spec §FR-026]
- [ ] CHK042 - Are F1 single-tenant (MVP) → multi-tenant (post-F10) era-transition requirements documented for F8 verifier code (no F8 changes needed)? [Coverage, Spec §research.md R1]
- [ ] CHK043 - Is the documentation-sync ritual (Complexity #5) actionable for future clarify rounds + critique rounds? [Acceptance Criteria, Spec §plan.md Complexity Tracking #5]

## Dependencies & Pre-conditions

- [ ] CHK044 - Are F8 dependencies on shipped features (F1, F2, F3, F4, F5, F7) enumerated with version/branch references? [Completeness, Spec §plan.md Predecessors]
- [ ] CHK045 - Are F8 dependencies on planned-but-not-shipped features (F6 stub-port, F12 custom-domain) explicitly handled with feature-port abstraction? [Completeness, Spec §FR-029a, §FR-026]

## Notes

- Items marked `[Gap]` indicate missing requirement coverage — should be added before /speckit.tasks
- Cross-module coordination is high-risk for solo-maintainer (F4 + F2 + F8 all owned by same person)
- PR sequencing must be documented before /speckit.tasks generates dependency graph
- Pair with /speckit.review architect agent for cross-module contract validation
