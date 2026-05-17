# UX Requirements Quality Checklist: F6 — EventCreate Integration

**Purpose**: Validate the **UX + i18n + accessibility + discoverability + admin-affordance requirements** in spec.md + contracts/* are complete, clear, consistent, measurable, and ready for `/speckit.staff-review`.
**Created**: 2026-05-12
**Feature**: [Link to spec.md](../spec.md)
**Depth**: Formal Review Gate
**Scope**: Admin UI surfaces, Zapier walkthrough, i18n (EN/TH/SV), WCAG 2.1 AA, discovery + empty + error states, test-webhook UX, RBAC visibility.

## Admin UI Surface Coverage

- [ ] CHK001 - Are requirements specified for **every** admin surface F6 introduces (events list, event detail, archive view, CSV import, integration config, erase confirmation dialog)? [Completeness, Spec §FR-020..FR-025 + §FR-032a]
- [ ] CHK002 - Are the column requirements for the events list table specified (Date, Name, Category, Registrations, Partner Benefit badge, Match Rate %)? [Completeness, Spec §FR-020 + contracts/admin-events-api.md]
- [ ] CHK003 - Are the attendee-table column requirements for event detail specified (name, email, company, match status, ticket type, price paid, quota effect)? [Completeness, Spec §FR-021]
- [ ] CHK004 - Is the deep-link-to-EventCreate button requirement specified on event detail? [Completeness, Spec §FR-021]
- [ ] CHK005 - Is the "Show unmatched only" filter requirement specified for the attendee table (discovery affordance for relink workflow)? [Coverage, Spec US2 AS4 round-1 P4]
- [ ] CHK006 - Are visual-distinction requirements specified for unmatched rows (badge + sort-to-top option + filter shortcut)? [Clarity, Spec US2 AS4]
- [ ] CHK007 - Is the "over quota" indicator requirement specified for registrations that hit the allotment cap? [Clarity, Spec §FR-017]
- [ ] CHK008 - Is the "Archived" badge requirement specified for archived events when viewed via the include-archived filter? [Clarity, Spec §FR-019a]

## Zapier Setup Walkthrough (FR-025)

- [ ] CHK009 - Are the 8 walkthrough steps explicitly enumerated (connect EventCreate → choose trigger → POST action → URL → headers → body → test → publish)? [Completeness, research.md R12 + Spec §FR-025]
- [ ] CHK010 - Are the EN-only screenshot requirements explicit (Zapier UI is English-only globally) with TH/SV narration alongside? [Clarity, Session 2026-05-12 round 3 Q3]
- [ ] CHK011 - Is the localised "Zapier's interface is in English only" notice requirement specified for TH/SV walkthrough modes? [Coverage, research.md R12]
- [ ] CHK012 - Are the 6-month screenshot-staleness-review-cycle requirements documented (UI drift maintenance)? [Coverage, research.md R12 round-1 P9]
- [ ] CHK013 - Is the screenshot file-path convention (`public/walkthroughs/eventcreate-zapier/step-NN-<topic>-YYYY-MM.png`) specified? [Clarity, research.md R12]

## Tenant Onboarding (SC-001)

- [ ] CHK014 - Is the SC-001 15-minute end-to-end target measurable with explicit start/end-point definition (open wizard → green confirmation)? [Measurability, Spec §SC-001]
- [ ] CHK015 - Are the 3 wizard phases specified (generate-secret → walkthrough → test-webhook) with progressive disclosure gating? [Completeness, research.md R12]
- [ ] CHK016 - Is the one-time-reveal-acknowledgement checkbox requirement specified (gates the walkthrough phase)? [Clarity, research.md R12]
- [ ] CHK017 - Are the masked-secret display requirements for returning visits specified (`whsec_••••••••1234` with rotate button)? [Coverage, Spec US3 AS3]

## i18n (EN / TH / SV)

- [ ] CHK018 - Is the canonical EN locale + TH + SV all required at release specified (no F4-style TH-only-blocker since F6 has no tax-doc surface)? [Completeness, Spec §FR-030]
- [ ] CHK019 - Are the ~150 new i18n keys estimate documented (×3 locales = ~450 entries)? [Clarity, plan.md Constitution Check § V]
- [ ] CHK020 - Are i18n requirements for all **43** audit event human-readable descriptions (original spec scoped 35; extended to 43) explicit? [Coverage, Spec §FR-030 + data-model.md § 4 + canonical closed union at `src/modules/events/application/ports/audit-port.ts:76-171`]
- [ ] CHK021 - Is the EN-fail-build + TH/SV-warn-then-CI-block-on-release-branch policy explicit (inherited from F1+F2 i18n discipline)? [Clarity, plan.md Constitution Check § V]
- [ ] CHK022 - Are i18n requirements for CSV-import error messages specified per-locale (so admin sees errors in their locale)? [Coverage, contracts/csv-import-api.md]

## Accessibility (WCAG 2.1 AA — Constitution Principle VI)

- [ ] CHK023 - Are WCAG 2.1 AA requirements specified for every F6 admin surface? [Completeness, Spec §FR-031]
- [ ] CHK024 - Are keyboard-navigation requirements specified for the TanStack-table-based events list + attendee table? [Coverage, Spec §FR-031]
- [ ] CHK025 - Are colour-contrast requirements specified for match-status badges + quota-effect indicators (NOT colour-alone signalling)? [Coverage, plan.md Constitution Check § VI]
- [ ] CHK026 - Are axe-core E2E test requirements specified per admin surface (events list, event detail, integration config, CSV import, archive confirm dialog)? [Coverage, plan.md Testing §]
- [ ] CHK027 - Are the focus-management requirements specified for confirmation dialogs (relink, archive, erase)? [Coverage, Spec §FR-031]

## Discovery, Empty States, Error States

- [X] CHK028 - Are empty-state requirements specified for `/admin/events` when no events have been imported yet (pre-flag-flip OR fresh tenant)? [Coverage, Edge Case, Spec §FR-020 + §US2 AS5 — resolved 2026-05-12]
- [ ] CHK029 - Are empty-state requirements specified for `/admin/integrations/eventcreate` when no webhook secret has been generated yet? [Coverage, Spec §FR-022]
- [ ] CHK030 - Is the empty-state requirement to surface a "Set up EventCreate integration" entry from the events list specified (per R1 nav-visibility decision)? [Coverage, contracts/admin-integration-eventcreate-api.md round-2 R1]
- [ ] CHK031 - Are CSV-import error-state UX requirements specified (drag-drop feedback, file-too-large 413, malformed header 400)? [Completeness, contracts/csv-import-api.md]
- [ ] CHK032 - Are loading-state requirements specified for asynchronous data (events list pagination, attendee table render, CSV upload progress)? [Coverage, Spec §FR-031 / docs/ux-standards.md shimmer skeletons]
- [ ] CHK033 - Is the pseudonymised-row-relink-blocked UX message specified with clear remediation guidance? [Coverage, Spec §FR-014 round-2 R4]

## Test Webhook UX (FR-023)

- [ ] CHK034 - Is the "Test webhook" success-state UX specified (green confirmation + duration + processing outcome)? [Completeness, contracts/admin-integration-eventcreate-api.md]
- [ ] CHK035 - Is the "Test webhook" failure-state UX specified with failure-category diagnostic + remediation hint? [Coverage, contracts/admin-integration-eventcreate-api.md]
- [ ] CHK036 - Is the recent-deliveries panel default-filter requirement specified (`includeTestDeliveries=false` by default; toggle to show all)? [Clarity, contracts/admin-integration-eventcreate-api.md round-2 R5]
- [ ] CHK037 - Is the 10-tests/hour rate-limit feedback UX specified (HTTP 429 → friendly localised admin message, not raw error)? [Coverage, contracts/admin-integration-eventcreate-api.md]

## RBAC Visibility

- [ ] CHK038 - Are the UI-layer hide/disable requirements for manager-blocked mutating CTAs specified (in addition to the application-layer 403)? [Coverage, Spec §FR-035]
- [ ] CHK039 - Is the requirement that manager sees events list + detail in **read-only mode** specified (no relink/archive/erase buttons rendered)? [Clarity, Spec §FR-035]
- [ ] CHK040 - Is the requirement that `/admin/integrations/eventcreate` route returns 404 (not 403) for non-admin specified to drive the navigation visibility decision? [Consistency, Spec §FR-035]

## Notes

- This checklist is the canonical UX review gate for F6 per Constitution Principle VI.
- All "[Gap]" items require resolution before `/speckit.implement` or surface as `/speckit.tasks` line items.
- a11y + i18n + UX are interleaved here per F4 / F8 precedent (smaller scope than F7's a11y/i18n split).
