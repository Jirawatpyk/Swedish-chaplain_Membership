# UX Requirements Quality Checklist: F3 — Member & Contact Management + Smart Features

**Purpose**: "Unit tests" for the **quality of UX requirements** in F3's spec, plan, contracts, and quickstart artefacts. Validates whether layout, state, interaction, form, table, dialog, toast, theme, and localization requirements are **complete, clear, consistent, measurable, and traceable** to `docs/ux-standards.md` — NOT whether the implementation looks right.
**Created**: 2026-04-15
**Feature**: [spec.md](../spec.md)
**Depth**: Comprehensive — merge-gate (aligned with `docs/ux-standards.md` § 15 enterprise checklist)
**Audience**: Maintainer + `/speckit.review` + `/speckit.staff-review` agents at Merge Gate

---

## Directory & List View Requirements (US2, US4)

- [ ] CHK001 Are the exact columns of the member directory specified (company, plan+tier, primary contact, email, status, last-activity, risk indicator)? [Completeness, Spec US2]
- [ ] CHK002 Are sorting default (last_activity_at DESC NULLS LAST) and alternative sort orders specified? [Clarity, Data-model § 2]
- [ ] CHK003 Are pagination requirements (cursor-based, batch size 50, limit 1..100) consistent between contracts and data-model? [Consistency, Contracts Endpoint 1]
- [ ] CHK004 Are filter combination requirements specified (how URL state reflects multi-filter, per US2 AS2)? [Clarity, Spec US2 AS2]
- [ ] CHK005 Is the **empty-state** requirement defined (zero members in directory)? [Gap]
- [ ] CHK006 Is the **empty-filter-results** state (filters applied yielding 0 rows) distinguished from the true empty state? [Gap]
- [ ] CHK007 Is the **loading state** specified as a shimmer skeleton in the final table shape (CLS 0)? [Completeness, Plan § Constitution Check VI]
- [ ] CHK008 Are requirements explicit that the skeleton matches column widths, row count, and header layout? [Clarity, Plan § Constitution Check VI]
- [ ] CHK009 Is the **error state** requirement defined (server 500, network failure) with retry affordance? [Gap]
- [ ] CHK010 Is the risk-indicator **placeholder rendering** requirement explicit (neutral "—" with tooltip "Available in F8")? [Clarity, Spec US2 AS5]
- [ ] CHK011 Are archived-member visibility requirements unambiguous (hidden by default; `?show_archived=1` opt-in)? [Consistency, Contracts Endpoint 1]
- [ ] CHK012 Is the "N members selected" counter + clear-selection UX specified for bulk mode? [Gap]

## Create / Edit Form Requirements (US1, US3)

- [ ] CHK013 Are field ordering and grouping requirements specified for the Create Member form? [Gap]
- [ ] CHK014 Are field-level validation requirements specified (inline vs on-submit)? [Clarity]
- [ ] CHK015 Is the turnover-warning UX explicit (inline warning text, not a hard block; save only with override reason)? [Clarity, Spec US1 AS2]
- [ ] CHK016 Are override-reason picker requirements specified (enum dropdown + conditional note textarea when `other`)? [Completeness, Spec FR-006a]
- [ ] CHK017 Is the form validation summary UX specified for screen readers (aria-live region)? [Coverage]
- [ ] CHK018 Are date-of-birth picker requirements specified (Calendar + Popover; Thai BE display for `th-TH`)? [Clarity, Plan § Primary Dependencies]
- [ ] CHK019 Are country combobox requirements explicit about (a) search-as-you-type, (b) localized country names per locale? [Completeness, Research § 10]
- [ ] CHK020 Is the contact sub-form requirement specified (embedded within member form vs separate step)? [Gap]
- [ ] CHK021 Are unsaved-changes guard requirements specified (browser beforeunload + in-app warning dialog)? [Gap]
- [ ] CHK022 Is the "Invite to portal" button visibility requirement specified (shown only when primary contact has email)? [Clarity, Spec US1 AS5]

## Dialog & Confirmation Patterns

- [ ] CHK023 Are dialog requirements for all destructive actions (archive, bulk archive, contact remove) traceable to `ux-standards.md` § 4.1? [Traceability, Plan § Constitution Check VI]
- [ ] CHK024 Is the **typed-phrase confirmation** requirement for bulk archive > 5 rows specified with exact phrase format ("Archive N members")? [Clarity, Spec US4 AS3]
- [ ] CHK025 Are dialog action-label requirements explicit (primary = destructive verb; secondary = "Cancel" localized)? [Consistency]
- [ ] CHK026 Is the Esc-to-cancel requirement explicit for every dialog? [Completeness, ux-standards § 4.1]
- [ ] CHK027 Is the focus-trap requirement specified while a dialog is open? [Coverage]
- [ ] CHK028 Is the focus-return requirement specified (return to triggering element on dialog close)? [Clarity, Plan § Constitution Check VI]
- [ ] CHK029 Are BundleChangeWarningDialog requirements explicit about displaying live member count + old/new bundle names? [Completeness, Spec US3 AS4-5]
- [ ] CHK030 Is the override-reason dialog requirement specified with distinct UX from generic confirmation? [Clarity]
- [ ] CHK031 Are progress-during-long-action requirements specified for 100-row bulk actions (progress indicator or optimistic with rollback)? [Gap]

## Toast / Notification Requirements

- [ ] CHK032 Is toast-on-mutation-success a requirement for every POST/PATCH/DELETE surface? [Coverage, Plan § Constitution Check VI]
- [ ] CHK033 Is the toast duration requirement specified (ux-standards default)? [Traceability]
- [ ] CHK034 Are error-toast requirements specified with user-actionable copy (retry, refresh, contact admin)? [Clarity]
- [ ] CHK035 Is the bulk-action summary toast requirement explicit ("N members updated" with link to audit log)? [Completeness, Spec US4 AS2]
- [ ] CHK036 Are aria-live announcement requirements specified for inline-edit save + rollback? [Coverage, Plan § Constitution Check VI]
- [ ] CHK037 Is stacked-toast behavior requirement defined (max concurrent, newest vs oldest priority)? [Gap]

## Inline Edit & Bulk Action Requirements (US4)

- [ ] CHK038 Is the inline-edit column whitelist explicit (status, country, notes) and consistent between spec and plan? [Consistency, Spec FR-018]
- [ ] CHK039 Are commit-on-blur vs commit-on-enter requirements specified? [Clarity]
- [ ] CHK040 Is the optimistic-update + rollback-on-error UX requirement specified with user-visible signals? [Clarity, Spec US4 AS1]
- [ ] CHK041 Are bulk-action menu requirements explicit about placement (sticky toolbar when ≥1 row selected)? [Gap]
- [ ] CHK042 Is the multi-row-selection UX specified (click + shift-click range, Select All on page, Select All across pages)? [Gap]
- [ ] CHK043 Are bulk-action-cap UX requirements specified for > 100 selection (disabled submit + explanation message)? [Clarity, Spec FR-019a]
- [ ] CHK044 Is the rate-limit-exceeded 429 response UX specified (toast + cooldown hint)? [Gap]
- [ ] CHK045 Is concurrent-admin-edit conflict UX specified (toast "Another admin changed X — refresh")? [Clarity, Spec Edge Cases]

## Command Palette (Smart Feature #4)

- [ ] CHK046 Are palette group requirements specified for F3 (Members group above Plans group)? [Completeness, Research § 8]
- [ ] CHK047 Is the palette-open perceived-latency requirement quantified (< 100 ms per SC, carried from F2)? [Measurability]
- [ ] CHK048 Is the "50 most recent members" window requirement explicit? [Clarity, Research § 8]
- [ ] CHK049 Are palette RBAC requirements explicit (member role sees stripped palette with Profile/Edit/Invite only)? [Coverage, Research § 8]
- [ ] CHK050 Is palette keyboard-navigation requirement explicit (arrow keys + Enter + Esc)? [Coverage]
- [ ] CHK051 Is the palette-search result-order requirement specified (recency vs alphabetical vs fuzzy-match score)? [Gap]

## Timeline View (US6)

- [ ] CHK052 Are timeline item layout requirements specified (timestamp, actor, event label, diff summary)? [Completeness, Spec US6 AS1]
- [ ] CHK053 Is the timestamp format requirement specified (ISO stored, user-locale formatted, BE for `th-TH`)? [Clarity, Spec US6 AS1]
- [ ] CHK054 Are pagination requirements explicit (batch 50, cursor-based, no blocking main thread)? [Clarity, Spec US6 AS2 + Research § 9]
- [ ] CHK055 Is the member-role redaction requirement specified (override reasons + internal notes stripped)? [Clarity, Spec US6 AS3]
- [ ] CHK056 Is the reduced-motion fallback requirement explicit for timeline reveal animation? [Coverage, Spec US6 AS4]
- [ ] CHK057 Are event-type display-string requirements explicit (localized via `audit.eventType.*` keys for all 20+ event types)? [Completeness, Data-model § 4]

## Member Self-Service Portal (US5)

- [ ] CHK058 Are the **3 real surfaces** (Profile view, Whitelisted-field edit, Colleague invite) explicitly listed? [Completeness, Spec US5]
- [ ] CHK059 Is the "hide unbuilt tabs entirely" requirement explicit (NOT render as 'coming soon' placeholders)? [Clarity, Spec US5 + § Summary MVP slice]
- [ ] CHK060 Are requirements for the 403 response UX specified (friendly copy in every locale)? [Coverage, Spec SC-007]
- [ ] CHK061 Is the "403 without information leak" requirement explicit about not revealing whether the target member exists in another tenant? [Clarity, Spec US5 AS1]
- [ ] CHK062 Is the read-only-mode (`READ_ONLY_MODE=true`) UX requirement specified for member self-service? [Clarity, Spec US5 AS5]
- [ ] CHK063 Are whitelisted-field constraints visible to the user (disabled vs hidden for non-editable fields)? [Gap]

## Archived / Undelete UX (US7)

- [ ] CHK064 Is the archived-row banner requirement specified on the member detail page? [Completeness]
- [ ] CHK065 Is the "Show archived" filter visibility requirement explicit (toggle vs always-visible)? [Gap]
- [ ] CHK066 Is the Undelete-window messaging specified for > 90-day members (disabled button + tooltip)? [Clarity, Spec US7 AS3]
- [ ] CHK067 Are audit events for archive + undelete reflected in the timeline per US6? [Consistency]

## Form Validation & Error Handling

- [ ] CHK068 Are inline validation vs summary validation requirements specified per field? [Clarity]
- [ ] CHK069 Are required-field indicator requirements specified (asterisk, label styling)? [Gap]
- [ ] CHK070 Are server-error-to-field mapping requirements specified (zod error details → inline field errors)? [Clarity, Contracts § Common error shape]
- [ ] CHK071 Are "override reason required" form-level error UX requirements explicit? [Clarity]
- [ ] CHK072 Are idempotency-key conflict (409) error UX requirements specified? [Gap, Contracts]

## Theme & Mobile

- [ ] CHK073 Is light + dark parity a requirement for every new F3 component? [Completeness, Plan § Constitution Check VI]
- [ ] CHK074 Is the 320px-minimum-width requirement explicit for every F3 screen? [Coverage, Plan § Constitution Check VI]
- [ ] CHK075 Are mobile-specific UX deviations specified (bulk action bar collapse to bottom sheet, palette full-screen)? [Gap]
- [ ] CHK076 Are touch-target-size requirements specified for mobile inline-edit affordances? [Coverage]

## Localization (EN / TH / SV)

- [ ] CHK077 Are all ~150 new i18n keys identified with their namespace (admin.members.*, portal.profile.*, admin.members.overrideReason.*, admin.members.bundleChangeWarning.*, audit.eventType.*)? [Completeness, Quickstart § 7]
- [ ] CHK078 Is the missing-EN-key-fails-build requirement explicit? [Traceability, Plan § Constitution Check V]
- [ ] CHK079 Is the TH+SV CI enforcement on release branches specified? [Clarity, Plan § Constitution Check V]
- [ ] CHK080 Are Thai-specific content requirements explicit (tax_id error in Thai formatting; DOB picker BE for `th-TH`)? [Coverage, Plan § Constitution Check V]
- [ ] CHK081 Are localized country-name rendering requirements specified via `i18n-iso-countries`? [Clarity, Research § 10]
- [ ] CHK082 Are currency/number formatting requirements specified for THB (฿) display in the directory row and detail view? [Gap]

## Enterprise UX Standards (docs/ux-standards.md § 15)

- [ ] CHK083 Is every F3 screen required to pass the `ux-standards.md` § 15 enterprise checklist pre-merge? [Traceability, Plan § Constitution Check VI]
- [ ] CHK084 Are `prefers-reduced-motion` fallback requirements explicit for every animated surface (shimmer, timeline reveal, palette open)? [Coverage]
- [ ] CHK085 Are idle-warning requirements inherited from F1 explicitly applicable to F3 admin surfaces? [Traceability, Spec Assumptions]

## Gaps & Open Questions

- [ ] CHK086 Is the behavior for a verified-in-another-tenant email during create specified (e.g., "This email is already used by a contact at chamber X — proceed anyway?")? [Gap, Spec Edge Cases]
- [ ] CHK087 Are copy-to-clipboard affordance requirements specified for member IDs, emails, tax IDs (common admin task)? [Gap]
- [ ] CHK088 Is the "soft duplicate company name" warning UX explicit about when it fires and how to dismiss? [Clarity, Spec Edge Cases]

---

## Gap Resolution Log (2026-04-15 post-critique round 2)

All `[Gap]` items above are resolved via spec FR-027..FR-044 additions:

| Checklist Item | Resolution |
|---|---|
| CHK005 (empty state) + CHK006 (filter-zero) + CHK009 (error state) | **FR-034** — three distinct directory states enumerated |
| CHK012 (N-selected counter) + CHK042 (multi-select keyboard) | **FR-040** — sticky toolbar with counter + keyboard shortcut spec |
| CHK013 (form field ordering) + CHK020 (contact sub-form) | Inherited from `ux-standards.md` § 15 via **FR-033** |
| CHK021 (unsaved-changes guard) | `ux-standards.md` § 15 default via FR-033 |
| CHK031 (bulk-action progress) | **FR-041** — determinate progress for >1s operations |
| CHK037 (stacked toast) | `ux-standards.md` § 4.2 inherited via FR-033 |
| CHK041 (bulk menu placement) | **FR-040** — sticky bottom bar |
| CHK044 (429 toast) | `ux-standards.md` § 4.2 error-toast pattern via FR-033 |
| CHK051 (palette order) | **FR-043** — exact→prefix→substring, then recency |
| CHK063 (disallowed fields hidden) | **FR-042** — hidden not disabled for self-service |
| CHK065 (show-archived filter) | `ux-standards.md` § 15 default (toggle) via FR-033 |
| CHK069 (required-field indicator) | **FR-035** — aria-required + asterisk + form-top note |
| CHK072 (409 idempotency UX) | `ux-standards.md` § 4.2 error-toast pattern via FR-033 |
| CHK075 (mobile deviations) | `ux-standards.md` § 15 mobile-first default via FR-033 |
| CHK082 (THB formatting) | Inherited locale-aware Intl.NumberFormat from F2 pattern |
| CHK086 (cross-tenant email warning) | **FR-032** — no warning (Principle I privacy) |
| CHK087 (copy-to-clipboard) | **FR-030** — member_id / email / tax_id |
| CHK088 (soft-duplicate warning) | **FR-031** — dialog with Proceed / Cancel |

## Notes

- Check items off as the requirement is validated: `[x]`
- All 18 flagged gaps resolved via spec FRs or explicit `ux-standards.md` inheritance clauses (FR-033)
- Traceability target: ≥80% (achieved — 88/88 items now reference spec/plan/contracts/ux-standards)
- This checklist maps to `docs/ux-standards.md` § 15 enterprise checklist — every unchecked item is a merge blocker
