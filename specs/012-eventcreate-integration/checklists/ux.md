# UX Requirements Quality Checklist: F6 — EventCreate Integration

**Purpose**: Validate the **UX + i18n + accessibility + discoverability + admin-affordance requirements** in spec.md + contracts/* are complete, clear, consistent, measurable, and ready for `/speckit.staff-review`.
**Created**: 2026-05-12
**Feature**: [Link to spec.md](../spec.md)
**Depth**: Formal Review Gate
**Scope**: Admin UI surfaces, Zapier walkthrough, i18n (EN/TH/SV), WCAG 2.1 AA, discovery + empty + error states, test-webhook UX, RBAC visibility.

## Admin UI Surface Coverage

- [X] CHK001 - Are requirements specified for **every** admin surface F6 introduces (events list, event detail, archive view, CSV import, integration config, erase confirmation dialog)? [Completeness, Spec §FR-020..FR-025 + §FR-032a]
- [X] CHK002 - Are the column requirements for the events list table specified (Date, Name, Category, Registrations, Partner Benefit badge, Match Rate %)? [Completeness, Spec §FR-020 + contracts/admin-events-api.md]
- [X] CHK003 - Are the attendee-table column requirements for event detail specified (name, email, company, match status, ticket type, price paid, quota effect)? [Completeness, Spec §FR-021]
- [X] CHK004 - Is the deep-link-to-EventCreate button requirement specified on event detail? [Completeness, Spec §FR-021]
- [X] CHK005 - Is the "Show unmatched only" filter requirement specified for the attendee table (discovery affordance for relink workflow)? [Coverage, Spec US2 AS4 round-1 P4]
- [X] CHK006 - Are visual-distinction requirements specified for unmatched rows (badge + sort-to-top option + filter shortcut)? [Clarity, Spec US2 AS4]
- [X] CHK007 - Is the "over quota" indicator requirement specified for registrations that hit the allotment cap? [Clarity, Spec §FR-017]
- [X] CHK008 - Is the "Archived" badge requirement specified for archived events when viewed via the include-archived filter? [Clarity, Spec §FR-019a]

## Zapier Setup Walkthrough (FR-025)

- [X] CHK009 - Are the 8 walkthrough steps explicitly enumerated (connect EventCreate → choose trigger → POST action → URL → headers → body → test → publish)? [Completeness, research.md R12 + Spec §FR-025]
- [X] CHK010 - Are the EN-only screenshot requirements explicit (Zapier UI is English-only globally) with TH/SV narration alongside? [Clarity, Session 2026-05-12 round 3 Q3]
- [X] CHK011 - Is the localised "Zapier's interface is in English only" notice requirement specified for TH/SV walkthrough modes? [Coverage, research.md R12]
- [X] CHK012 - Are the 6-month screenshot-staleness-review-cycle requirements documented (UI drift maintenance)? [Coverage, research.md R12 round-1 P9]
- [X] CHK013 - Is the screenshot file-path convention (`public/walkthroughs/eventcreate-zapier/step-NN-<topic>-YYYY-MM.png`) specified? [Clarity, research.md R12]

## Tenant Onboarding (SC-001)

- [X] CHK014 - Is the SC-001 15-minute end-to-end target measurable with explicit start/end-point definition (open wizard → green confirmation)? [Measurability, Spec §SC-001]
- [X] CHK015 - Are the 3 wizard phases specified (generate-secret → walkthrough → test-webhook) with progressive disclosure gating? [Completeness, research.md R12]
- [X] CHK016 - Is the one-time-reveal-acknowledgement checkbox requirement specified (gates the walkthrough phase)? [Clarity, research.md R12]
- [X] CHK017 - Are the masked-secret display requirements for returning visits specified (`whsec_••••••••1234` with rotate button)? [Coverage, Spec US3 AS3]

## i18n (EN / TH / SV)

- [X] CHK018 - Is the canonical EN locale + TH + SV all required at release specified (no F4-style TH-only-blocker since F6 has no tax-doc surface)? [Completeness, Spec §FR-030]
- [X] CHK019 - Are the ~150 new i18n keys estimate documented (×3 locales = ~450 entries)? [Clarity, plan.md Constitution Check § V]
- [X] CHK020 - Are i18n requirements for all **43** audit event human-readable descriptions (original spec scoped 35; extended to 43) explicit? [Coverage, Spec §FR-030 + data-model.md § 4 + canonical closed union at `src/modules/events/application/ports/audit-port.ts:76-171`]
- [X] CHK021 - Is the EN-fail-build + TH/SV-warn-then-CI-block-on-release-branch policy explicit (inherited from F1+F2 i18n discipline)? [Clarity, plan.md Constitution Check § V]
- [X] CHK022 - Are i18n requirements for CSV-import error messages specified per-locale (so admin sees errors in their locale)? [Coverage, contracts/csv-import-api.md]

## Accessibility (WCAG 2.1 AA — Constitution Principle VI)

- [X] CHK023 - Are WCAG 2.1 AA requirements specified for every F6 admin surface? [Completeness, Spec §FR-031]
- [X] CHK024 - Are keyboard-navigation requirements specified for the TanStack-table-based events list + attendee table? [Coverage, Spec §FR-031]
- [X] CHK025 - Are colour-contrast requirements specified for match-status badges + quota-effect indicators (NOT colour-alone signalling)? [Coverage, plan.md Constitution Check § VI]
- [X] CHK026 - Are axe-core E2E test requirements specified per admin surface (events list, event detail, integration config, CSV import, archive confirm dialog)? [Coverage, plan.md Testing §]
- [X] CHK027 - Are the focus-management requirements specified for confirmation dialogs (relink, archive, erase)? [Coverage, Spec §FR-031]

## Discovery, Empty States, Error States

- [X] CHK028 - Are empty-state requirements specified for `/admin/events` when no events have been imported yet (pre-flag-flip OR fresh tenant)? [Coverage, Edge Case, Spec §FR-020 + §US2 AS5 — resolved 2026-05-12]
- [X] CHK029 - Are empty-state requirements specified for `/admin/integrations/eventcreate` when no webhook secret has been generated yet? [Coverage, Spec §FR-022]
- [X] CHK030 - Is the empty-state requirement to surface a "Set up EventCreate integration" entry from the events list specified (per R1 nav-visibility decision)? [Coverage, contracts/admin-integration-eventcreate-api.md round-2 R1]
- [X] CHK031 - Are CSV-import error-state UX requirements specified (drag-drop feedback, file-too-large 413, malformed header 400)? [Completeness, contracts/csv-import-api.md]
- [X] CHK032 - Are loading-state requirements specified for asynchronous data (events list pagination, attendee table render, CSV upload progress)? [Coverage, Spec §FR-031 / docs/ux-standards.md shimmer skeletons]
- [X] CHK033 - Is the pseudonymised-row-relink-blocked UX message specified with clear remediation guidance? [Coverage, Spec §FR-014 round-2 R4]

## Test Webhook UX (FR-023)

- [X] CHK034 - Is the "Test webhook" success-state UX specified (green confirmation + duration + processing outcome)? [Completeness, contracts/admin-integration-eventcreate-api.md]
- [X] CHK035 - Is the "Test webhook" failure-state UX specified with failure-category diagnostic + remediation hint? [Coverage, contracts/admin-integration-eventcreate-api.md]
- [X] CHK036 - Is the recent-deliveries panel default-filter requirement specified (`includeTestDeliveries=false` by default; toggle to show all)? [Clarity, contracts/admin-integration-eventcreate-api.md round-2 R5]
- [X] CHK037 - Is the 10-tests/hour rate-limit feedback UX specified (HTTP 429 → friendly localised admin message, not raw error)? [Coverage, contracts/admin-integration-eventcreate-api.md]

## RBAC Visibility

- [X] CHK038 - Are the UI-layer hide/disable requirements for manager-blocked mutating CTAs specified (in addition to the application-layer 403)? [Coverage, Spec §FR-035]
- [X] CHK039 - Is the requirement that manager sees events list + detail in **read-only mode** specified (no relink/archive/erase buttons rendered)? [Clarity, Spec §FR-035]
- [X] CHK040 - Is the requirement that `/admin/integrations/eventcreate` route returns 404 (not 403) for non-admin specified to drive the navigation visibility decision? [Consistency, Spec §FR-035]

## Notes

- This checklist is the canonical UX review gate for F6 per Constitution Principle VI.
- All "[Gap]" items require resolution before `/speckit.implement` or surface as `/speckit.tasks` line items.
- a11y + i18n + UX are interleaved here per F4 / F8 precedent (smaller scope than F7's a11y/i18n split).

---

## Co-Sign Footer

**T151 Operator Gate — UX Checklist Co-Sign**

- **Co-signer**: Claude Opus 4.7 (1M context) — Senior UX Engineer (AI maintainer per Constitution Principle IX solo-maintainer substitute)
- **Date**: 2026-05-17
- **Branch HEAD at co-sign**: `5bf7aef0` (R9.S1 hardening + T150 security co-sign)
- **Verification method**: read-only category-by-category audit via Explore agent (8 categories: admin UI surface / Zapier walkthrough / tenant onboarding / i18n / a11y / discovery+empty+error states / test webhook UX / RBAC visibility)
- **Result**: **40/40 PASS** · 0 GAP · 0 N/A · CHK028 was pre-marked [X] in source file (resolved 2026-05-12)
- **Key evidence per category**:
  - **Admin UI Surface (CHK001-008)**: 6 surfaces (events list / event detail / archive / CSV import / integration config / erase dialog) implemented at `src/app/(staff)/admin/events/**` + `src/app/(staff)/admin/integrations/eventcreate/**`. Column requirements + filters + badges + "Over quota" indicator verified in `attendee-table.tsx` + `match-status-badge.tsx` + `quota-effect-badge.tsx`.
  - **Zapier Walkthrough (CHK009-013)**: 8 steps enumerated in research.md R12 + `webhook-config-wizard.tsx`. EN-only screenshot + TH/SV narration. 6-month review cycle. File-path convention `public/walkthroughs/eventcreate-zapier/step-NN-<topic>-YYYY-MM.png`.
  - **Tenant Onboarding (CHK014-017)**: SC-001 15-min target measurable (wizard-open → green-confirmation). 3 progressive-disclosure phases. Masked-secret display `whsec_••••••••1234`.
  - **i18n (CHK018-022)**: EN + TH + SV at release. ~150 keys × 3 = ~450 entries (current count 2902 total across project). All 43 F6 audit event types have human-readable descriptions per canonical closed union.
  - **Accessibility (CHK023-027)**: WCAG 2.1 AA on every surface. TanStack Table v8 keyboard nav. Badges use shape+text+colour (never colour-alone). axe-core E2E coverage at `tests/e2e/eventcreate-a11y.spec.ts` (includes R9 R060 safetyNetFailedOpen chip scan).
  - **Discovery / Empty / Error States (CHK028-033)**: 3-variant empty states for events list. CSV error UX (drag-drop / 413 / 400 / row-level). Pseudonymised-row-relink-blocked message specified.
  - **Test Webhook UX (CHK034-037)**: Success + failure-category diagnostic + recent-deliveries panel with `includeTestDeliveries=false` default + 10-tests/hour rate-limit feedback localised.
  - **RBAC Visibility (CHK038-040)**: Manager read-only mode (no mutation buttons rendered). 404 (not 403) for non-admin on `/admin/integrations/eventcreate`.
- **Constitution v1.4.0**: VI ✅ PASS + V ✅ PASS (i18n parity 2902 × 3)

**Co-sign verdict**: F6 EventCreate Integration UX checklist (CHK001-CHK040) is **CO-SIGNED**.

— Signed in good faith based on category-by-category source-of-truth verification + implementation spot-checks. Any future UX regression (surfaced via axe-core E2E, user-report, or visual review) post-co-sign requires new round + re-sign.

---

### Post-co-sign delta notes

**Delta 1 — 2026-05-19 /review Full Scope (UX slice 5 of 5)**

- **UX-grade findings surfaced**: 0 (zero)
- **i18n parity check**: 2924 EN = 2924 TH = 2924 SV (perfect parity confirmed at `c41d09d7`; up from 2902 at co-sign time due to /code-review post-ship i18n additions in earlier commits — all 3 locales advanced together)
- **A11y spot-check**: 4 AlertDialog usages on destructive surfaces (erase-pii-dialog, archive-event-button, event-category-toggles, event-mismatch-warning-dialog) confirmed WCAG 2.1 AA compliant
- **Skeleton CLS-0 invariant**: confirmed at `loading.tsx` (motion-safe gate + aria-busy + aria-hidden semantics)
- **Verdict**: UX checklist co-sign at `5bf7aef0` REMAINS VALID. No re-sign required. CHK001-CHK040 unchanged.

— Verified by Claude Opus 4.7 on 2026-05-19 against branch HEAD `c41d09d7`.
