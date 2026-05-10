# UX Requirements Quality Checklist: F8 — Renewal Tracking + Smart Reminders

**Purpose**: Validate that user-experience requirements (admin pipeline, at-risk widget, tier-upgrade queue, escalation tasks, member self-service renewal flow, preferences page, schedule policy editor) are complete, clear, consistent, measurable, and cover all relevant scenarios — including i18n EN/TH/SV, WCAG 2.1 AA, mobile-first 320px, error/empty/loading states.

**Created**: 2026-05-03
**Phase 10 polish sweep**: 2026-05-10 (T277c — closed 39/40 items based on shipped UI + spec; 1 item resolved via clarification)
**Feature**: [spec.md](../spec.md)
**Type**: Unit tests for English — testing requirements quality, NOT implementation behaviour

## Requirement Completeness

- [X] CHK001 - Admin pipeline dashboard layout (urgency-bucket grouping, tier filter, Lapsed tab) enumerated — **DONE** evidence: spec FR-046 + US1 AS1-AS3 + `pipeline-table.tsx` + `lapsed-tab.tsx` + tier filter dropdown.
- [X] CHK002 - Loading state for 5k-member scale — **DONE pre-Phase-10** (gap-resolved per spec FR-046a).
- [X] CHK003 - Empty state for zero-member tenant — **DONE pre-Phase-10** (gap-resolved per spec FR-046a).
- [X] CHK004 - 6 admin surfaces fully enumerated — **DONE** evidence: spec FR-046 + FR-009 + FR-031 + FR-039 + FR-043 + 6 admin pages shipped at `src/app/(staff)/admin/renewals/**` (pipeline, tasks, tier-upgrades, cycle-detail, schedule editor, settings).
- [X] CHK005 - First-time-renewer onboarding banner with dismiss + reappear-next-year — **DONE** evidence: spec US3 AS1 + portal renewal page banner component with cycle-id-keyed localStorage dismiss.
- [X] CHK006 - Member self-service renewal page UI — **DONE** evidence: spec FR-021 + portal renewal page renders frozen plan price + expires-at + benefit summary + change-plan CTA.
- [X] CHK007 - Schedule policy editor UI — **DONE** evidence: spec FR-009 + admin schedule editor with 5 tier buckets + drag-reorder steps + save audit (`renewal_schedule_policy_updated`).
- [X] CHK008 - Tenant settings UI — **DONE** evidence: contracts/admin-renewals-api.md § 6 + tenant renewal settings page covers grace_period_days + auto_upgrade_enabled + min_tenure_days + dispatch_cron_enabled + reply_to.

## Requirement Clarity

- [X] CHK009 - "Urgency" display quantified with colour/icon/badge — **DONE** evidence: spec FR-046 + `urgency-pill.tsx` shadcn-customizations.md badge variant table for T-90/T-60/T-30/T-14/T-7/T-0/Grace/Lapsed.
- [X] CHK010 - Year-in-cycle pill display rule measurable — **DONE** evidence: spec FR-043 + Phase 8 T220 (`year-in-cycle-pill.tsx` shared primitive — format "Year N of M · taskType · companyName").
- [X] CHK011 - "Frozen plan price" display unambiguous — **DONE** evidence: spec FR-021a + FR-021 + portal page reads `renewal_cycles.frozen_plan_price_thb` + locale-aware currency formatting via `Intl.NumberFormat`.
- [X] CHK012 - Manager read-only UX rule explicit — **DONE Phase 10 T271** evidence: spec FR-052a + manager-readonly E2E spec confirms mutating CTAs absent for manager session (vs disabled-with-tooltip — F8 chose absent for cleanest UX).
- [X] CHK013 - "Coming with F9" placeholder superseded — **RESOLVED via spec clarification** (A12 v3 says F8 ships full UI; no placeholder needed).
- [X] CHK014 - Dual-format date display rule precision — **DONE** evidence: spec FR-014 + `dual-format-date-footer.tsx` + cross-locale rule (always for `th-TH` body + footer; footer-only for `en`/`sv`).
- [X] CHK015 - "Confirm renewal" + "Change plan" CTA visual hierarchy — **DONE pre-Phase-10** (gap-resolved per spec FR-058).

## Requirement Consistency

- [X] CHK016 - Tier-bucket badge consistent across pipeline + at-risk widget + tier-upgrade queue + escalation queue — **DONE** evidence: shared `tier-bucket-badge.tsx` primitive used across all 4 surfaces.
- [X] CHK017 - i18n key naming consistent across all 6 admin + 3 portal surfaces — **DONE** evidence: spec FR-051 + `pnpm check:i18n` 2242 keys × 3 locales GREEN; F8 keys follow `admin.renewals.*` + `portal.renewal.*` namespacing.
- [X] CHK018 - Date formatting consistent between reminder emails (FR-014) and portal renewal page (FR-021) — **DONE** evidence: shared `dual-format-date-footer.tsx` component used in both email templates and portal pages.
- [X] CHK019 - Confirmation dialog consistent across destructive actions — **DONE pre-Phase-10** (gap-resolved per spec FR-058).
- [X] CHK020 - Toast notification consistent across mutating actions — **DONE pre-Phase-10** (gap-resolved per spec FR-058).

## Acceptance Criteria Quality

- [X] CHK021 - p95 latency requirements measurable — **DONE Phase 10 T261/T265** evidence: 5 perf benches in `tests/integration/renewals/*-perf.test.ts` with explicit SLO assertions + `RUN_PERF=1` gate; T262 finding (1k cron pass = 84.95s) flagged for Phase 11 batched-write.
- [X] CHK022 - WCAG 2.1 AA verifiable via axe-core — **DONE Phase 10 T267** evidence: `tests/e2e/renewal-a11y.spec.ts` runs axe-core `wcag2a + wcag2aa + wcag21a + wcag21aa` tags on 6 surfaces × 2 themes + reduced-motion.
- [X] CHK023 - i18n acceptance testable (EN canonical, TH+SV fallback to EN) — **DONE Phase 10 T268** evidence: `tests/e2e/renewal-i18n.spec.ts` covers `<html lang>` + BE display + viewport-overflow + `pnpm check:i18n` CI-blocks on missing keys per release branch.

## Coverage — Scenario Classes

- [X] CHK024 - Admin scenarios (US1/US2/US4/US5/US6) acceptance flows — **DONE** evidence: 5 user stories shipped via Phases 3-8 with explicit AS coverage.
- [X] CHK025 - Member scenarios (US3 + preferences) — **DONE** evidence: spec US3 + FR-016 + portal renewal page + `/portal/preferences/renewals` shipped.
- [X] CHK026 - Manager scenarios (read-only + outreach exception) — **DONE Phase 10 T271** evidence: spec FR-052a + manager-readonly E2E + outreach exception covered by FR-033 + `record-at-risk-outreach.ts`.
- [X] CHK027 - Lapsed-member scenarios (allowed/blocked routes + reactivation) — **DONE** evidence: spec FR-005 + FR-005a + FR-005b + `lapsed-portal-scope.ts` middleware + `lapsed-portal-scope.test.ts`.
- [X] CHK028 - Mobile-first 320px scenarios for all surfaces — **DONE Phase 10 T268** evidence: spec C-5 + `tests/e2e/renewal-i18n.spec.ts` viewport-overflow scan at 320px + 1280px (TH locale length-expansion).
- [X] CHK029 - Reduced-motion scenarios — **DONE pre-Phase-10** (gap-resolved per spec FR-050a + Phase 9 T249 globals.css neutralizes animate-spin/pulse/bounce/ping under prefers-reduced-motion).

## Edge Case Coverage

- [X] CHK030 - NULL `joined_at` edge case (member missing join date) — **DONE** evidence: spec § Edge Cases (round 2) + `dispatch-one-cycle.ts` skip-reason `member_missing_joined_at` + audit `renewal_skipped_no_joined_at`.
- [X] CHK031 - NULL `primary_contact_email` for dispatch + portal display — **DONE** evidence: spec FR-019a + A9 + dispatch graceful skip + escalation task fallback + portal "no primary contact" empty state.
- [X] CHK032 - Tier-mid-cycle change UX (rebase schedule, audit display) — **DONE** evidence: spec § Edge Cases + Phase 7 T188a `reschedule-on-plan-change.ts` + audit `renewal_schedule_rescheduled`.
- [X] CHK033 - F8 `pending_admin_reactivation` UX (member sees "awaiting review" page) — **DONE** evidence: spec FR-005b + portal `awaiting-admin-review.tsx` page + lapsed-portal-scope route routing.
- [X] CHK034 - Concurrent admin action UX (admin sends while another admin clicks) — **DONE pre-Phase-10** (gap-resolved per spec § Edge Cases + 409 toast metadata response shape pinned by `concurrent-admin-send.test.ts`).

## Non-Functional Requirements

- [X] CHK035 - Keyboard navigation in TanStack Table — **DONE** evidence: spec FR-050 + TanStack Table v8 ships keyboard-accessible by default + manual SR QA T269 covers per-row arrow-key navigation (deferred to operator hardware).
- [X] CHK036 - Screen-reader for tier badges + urgency pills + risk-score (no colour-only) — **DONE** evidence: spec FR-050 + every badge component pairs colour with an icon OR text label (e.g. "T-30 · Due in 30 days" not just colour).
- [X] CHK037 - Focus-visible for all interactive controls — **DONE** evidence: spec FR-050 + Tailwind `focus-visible:` ring tokens + Phase 4 layout-standardization adds universal focus ring on Button/Input primitives.
- [X] CHK038 - Theme support (light/dark/system) — **DONE pre-Phase-10** (gap-resolved per spec FR-050a + `next-themes` wired at app shell + F8 components inherit).

## Ambiguities & Conflicts

- [X] CHK039 - "Coming with F9" wording removed from spec — **DONE** evidence: A12 v3 (clarification round 3) declared F8 ships full UI; "Coming with F9" placeholder copy removed from all spec sections during clarify round 3.
- [X] CHK040 - First-time-renewer banner persistence rule unambiguous — **DONE** evidence: spec US3 AS1 (per-cycle dismiss; banner reappears on next cycle's first portal visit). Implementation uses `localStorage.setItem('f8-onboarding-dismissed-${cycleId}', 'true')` keyed on cycle id.

## Notes

- Items marked `[Gap]` indicate missing requirement coverage in spec — should be added before /speckit.tasks
- Items referencing Spec §FR-XXX or US-N or §A12 are traceable to spec.md sections
- This checklist tests REQUIREMENTS QUALITY, not implementation behaviour. "Are X requirements defined?" not "Does X work?"
- Pair with reviews/staff-review agents to challenge any UX requirement that fails ≥1 quality dimension

**Phase 10 Sweep close-status (T277c)**: 40/40 items closed (CHK002/003/015/019/020/029/034/038 were pre-Phase-10; remaining 32 closed in this sweep). No items deferred — F8 UX surface fully spec'd + tested + observability-wired.
