# UX Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that user-experience requirements (admin pipeline, at-risk widget, tier-upgrade queue, escalation tasks, member self-service renewal flow, preferences page, schedule policy editor) are complete, clear, consistent, measurable, and cover all relevant scenarios — including i18n EN/TH/SV, WCAG 2.1 AA, mobile-first 320px, error/empty/loading states.

**Created**: 2026-05-03
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## Requirement Completeness

- [ ] CHK001 - Are admin pipeline dashboard layout requirements (urgency-bucket grouping, tier filter, Lapsed tab) explicitly enumerated? [Completeness, Spec §FR-046, US1 AS1-AS3]
- [X] CHK002 - Are loading state requirements defined for the admin pipeline at 5,000-member scale? [Completeness, Spec §FR-046a — gap-resolved]
- [X] CHK003 - Are empty state requirements specified for tenants with zero active members in the 90-day window? [Coverage, Spec §FR-046a — gap-resolved]
- [ ] CHK004 - Are the 6 admin surfaces (pipeline, at-risk widget, tier-upgrade queue, escalation tasks, schedule editor, tenant settings) fully enumerated with their UI elements? [Completeness, Spec §FR-046, FR-009, FR-031, FR-039, FR-043]
- [ ] CHK005 - Is first-time-renewer onboarding banner specified with dismiss + reappear-next-year requirements? [Completeness, Spec §US3 AS1]
- [ ] CHK006 - Are member self-service renewal page UI requirements (frozen plan price, expires-at, benefit summary, change-plan CTA) fully defined? [Completeness, Spec §FR-021]
- [ ] CHK007 - Are schedule policy editor UI requirements (5 tier buckets, drag-reorder steps, save audit) specified? [Completeness, Spec §FR-009]
- [ ] CHK008 - Are tenant settings UI requirements (grace_period_days, auto_upgrade_enabled, min_tenure_days, dispatch_cron_enabled, reply_to) enumerated? [Completeness, Spec §contracts/admin-renewals-api.md § 6]

## Requirement Clarity

- [ ] CHK009 - Is "urgency" display quantified with specific colour/icon/badge mapping for T-90 / T-60 / T-30 / T-14 / T-7 / T-0 / Grace / Lapsed? [Clarity, Spec §FR-046]
- [ ] CHK010 - Is the year-in-cycle pill display rule for multi-year cycles measurable (format, position, sortability)? [Clarity, Spec §FR-043]
- [ ] CHK011 - Is "frozen plan price" display unambiguous (exact column from `renewal_cycles.frozen_plan_price_thb`, currency formatting per locale)? [Clarity, Spec §FR-021a, §FR-021]
- [ ] CHK012 - Is the manager read-only UX rule explicit (mutating CTAs hidden vs disabled with tooltip)? [Clarity, Spec §FR-052a]
- [ ] CHK013 - Is "Coming with F9" placeholder copy specified for surfaces deferred per A12? [Clarity, Spec §A12 v3 — superseded by user clarification: F8 ships full UI]
- [ ] CHK014 - Is the dual-format date display rule (BE + Gregorian) precise about WHEN it applies (always for `th-TH` body + footer; footer-only for `en`/`sv`)? [Clarity, Spec §FR-014]
- [X] CHK015 - Are "Confirm renewal" + "Change plan" CTA visual hierarchy requirements defined? [Clarity, Spec §FR-058 — gap-resolved]

## Requirement Consistency

- [ ] CHK016 - Are tier-bucket badge requirements consistent across pipeline + at-risk widget + tier-upgrade queue + escalation queue? [Consistency, Spec §FR-046, FR-031, FR-039, FR-043]
- [ ] CHK017 - Are i18n key naming requirements consistent across all 6 admin surfaces + 3 portal surfaces (member-facing pages)? [Consistency, Spec §FR-051]
- [ ] CHK018 - Are date formatting requirements consistent between reminder emails (FR-014 dual-format) and portal renewal page (FR-021)? [Consistency, Spec §FR-014, §FR-021]
- [X] CHK019 - Are confirmation dialog requirements consistent across destructive actions (cancel cycle, dismiss tier-upgrade, mark task skipped)? [Consistency, Spec §FR-058 — gap-resolved]
- [X] CHK020 - Are toast notification requirements consistent across mutating actions (manual send, snooze, accept, dismiss)? [Consistency, Spec §FR-058 — gap-resolved]

## Acceptance Criteria Quality

- [ ] CHK021 - Are p95 latency requirements (admin pipeline <500ms, member self-service <600ms, confirm <1.2s) measurable with specific load conditions? [Acceptance Criteria, Spec §FR-046, §FR-057]
- [ ] CHK022 - Are WCAG 2.1 AA acceptance requirements verifiable via axe-core E2E? [Acceptance Criteria, Spec §FR-050]
- [ ] CHK023 - Are i18n acceptance requirements (EN canonical, TH+SV with fallback to EN, missing TH/SV CI-blocks on release branch) testable? [Acceptance Criteria, Spec §FR-051]

## Coverage — Scenario Classes

- [ ] CHK024 - Are admin scenarios (5 user stories admin-side) covered with explicit acceptance flows? [Coverage, Spec §US1, US2, US4, US5, US6]
- [ ] CHK025 - Are member scenarios (US3 + preferences) covered with explicit acceptance flows? [Coverage, Spec §US3, §FR-016]
- [ ] CHK026 - Are manager scenarios (read-only + outreach exception) covered with explicit acceptance flows? [Coverage, Spec §FR-052a]
- [ ] CHK027 - Are lapsed-member scenarios (allowed routes + blocked routes + reactivation flow) covered? [Coverage, Spec §FR-005, §FR-005a, §FR-005b]
- [ ] CHK028 - Are mobile-first scenarios specified for all admin + portal surfaces (320px width minimum)? [Coverage, Spec §C-5]
- [X] CHK029 - Are reduced-motion scenarios documented for the renewal pipeline + tier-upgrade animations? [Coverage, Spec §FR-050a — gap-resolved]

## Edge Case Coverage

- [ ] CHK030 - Are NULL `joined_at` edge case requirements specified (member missing join date)? [Edge Case, Spec §Edge Cases — added round 2]
- [ ] CHK031 - Are NULL `primary_contact_email` edge case requirements defined for both reminder dispatch + portal display? [Edge Case, Spec §FR-019a, §A9]
- [ ] CHK032 - Are tier-mid-cycle change UX requirements specified (rebase schedule, audit display)? [Edge Case, Spec §Edge Cases]
- [ ] CHK033 - Are F8 `pending_admin_reactivation` UX requirements (member sees "awaiting admin review" page) specified? [Edge Case, Spec §FR-005b]
- [X] CHK034 - Are concurrent admin action UX requirements defined (admin sends reminder while another admin clicks send)? [Edge Case, Spec §Edge Cases / Concurrent admin actions — gap-resolved]

## Non-Functional Requirements

- [ ] CHK035 - Are accessibility requirements specified for keyboard navigation in TanStack Table (pipeline, queue, tasks)? [Coverage, Spec §FR-050]
- [ ] CHK036 - Are screen-reader requirements specified for tier badges, urgency pills, risk-score badges (no colour-only signalling)? [Coverage, Spec §FR-050]
- [ ] CHK037 - Are focus-visible requirements documented for all interactive controls? [Coverage, Spec §FR-050]
- [X] CHK038 - Are theme requirements (light/dark/system) documented for all F8 surfaces? [Coverage, Spec §FR-050a — gap-resolved]

## Ambiguities & Conflicts

- [ ] CHK039 - Is "Coming with F9" wording (pre-clarification) removed from spec since A12 v3 says F8 ships full UI? [Conflict, Spec §A12 v3]
- [ ] CHK040 - Is the "first-time-renewer banner" persistence rule unambiguous (per-cycle dismiss vs forever-dismiss)? [Ambiguity, Spec §US3 AS1]

## Notes

- Items marked `[Gap]` indicate missing requirement coverage in spec — should be added before /speckit.tasks
- Items referencing Spec §FR-XXX or US-N or §A12 are traceable to spec.md sections
- This checklist tests REQUIREMENTS QUALITY, not implementation behaviour. "Are X requirements defined?" not "Does X work?"
- Pair with reviews/staff-review agents to challenge any UX requirement that fails ≥1 quality dimension
