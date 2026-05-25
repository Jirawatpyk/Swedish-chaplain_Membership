# Accessibility (WCAG 2.1 AA) Requirements Quality Checklist: F9

**Purpose**: Validate that F9's **accessibility requirements** are complete, clear, and
measurable across all surfaces (dashboard, audit viewer, directory, timeline, benefits,
GDPR export) — *before* implementation. Tests the requirements, not the UI.
**Created**: 2026-05-25
**Feature**: [spec.md](../spec.md) · constitution v1.4.2 (Principle VI) · `docs/ux-standards.md`
**Depth**: Formal release gate · **Audience**: reviewer

> "Is the a11y requirement specified?" — not "Does the screen reader work?"

## Coverage Across Surfaces

- [ ] CHK001 Is the WCAG 2.1 AA conformance requirement stated for **every** F9 surface, not just "the feature" generally? [Completeness, Spec §FR-035]
- [ ] CHK002 Is mobile-first (≥320px) layout required for the data-dense dashboard, audit table, and directory? [Coverage, Constitution VI, Spec §FR-035]
- [ ] CHK003 Are keyboard-operability requirements (full nav, visible focus) specified for all interactive F9 elements (filters, dismiss buttons, table sort, export actions)? [Completeness, Spec §FR-035]

## Data Visualisation Accessibility

- [ ] CHK004 Is the requirement that dashboard charts render as **accessible SVG/CSS with a text/`<table>` equivalent** (no canvas-only data) stated and testable? [Clarity, research R8, Spec §FR-035]
- [ ] CHK005 Are non-color-dependent encodings required for the Engagement Score bands and benefit-usage bars (color is not the only signal)? [Coverage, Gap]
- [ ] CHK006 Is a contrast requirement (≥4.5:1 text) stated for the new KPI cards, bands, and warning states? [Measurability, Constitution VI]

## State Requirements (loading / empty / error)

- [ ] CHK007 Are shimmer-skeleton loading-state requirements specified for async dashboard/timeline/benefit data per the UX standard? [Completeness, `docs/ux-standards.md`, Spec §FR-035]
- [ ] CHK008 Are empty-state requirements defined for every section so a zero-data tenant never sees an error/NaN, and are they distinguishable from error states? [Coverage, Spec §FR-006, Edge Cases]
- [ ] CHK009 Is the dashboard cold-start ("computing…") presentation required to be an accessible status, not a silent blank? [Clarity, research R1/E3]
- [ ] CHK010 Are error-state requirements (friendly, localized, screen-reader-announced) defined for export/snapshot failures? [Completeness, Spec §FR-037]

## Dynamic Content & Announcements

- [ ] CHK011 Is the live activity feed required to update without trapping focus or spamming screen-reader announcements (politeness level defined)? [Clarity, Spec §FR-003, Gap]
- [ ] CHK012 Are toast/confirmation requirements specified for state-changing actions (dismiss insight, update directory visibility, request export) per the UX standard? [Completeness, `docs/ux-standards.md`]
- [ ] CHK013 Is incremental/virtualized timeline loading required to remain keyboard-reachable and announce newly loaded entries? [Coverage, Spec §FR-016, Gap]

## Forms & Controls

- [ ] CHK014 Are label/association + error-messaging requirements defined for the audit filter controls and directory-visibility toggles? [Completeness, Gap]
- [ ] CHK015 Is the logo upload control required to expose accessible labels, error feedback (reject reason), and a non-pointer path? [Coverage, Spec §FR-025a]
- [ ] CHK016 Are target-size / focus-not-obscured requirements considered for dense table controls (per the F3 opportunistic WCAG 2.2 adoption)? [Consistency, prior-art F3]

## Motion & Preferences

- [ ] CHK017 Is `prefers-reduced-motion` respected for any dashboard transitions/animated bars? [Completeness, Constitution VI, Spec §FR-035]
- [ ] CHK018 Is `prefers-color-scheme` (light/dark) required for the new surfaces, consistent with existing theming? [Consistency, Constitution VI]

## Verification Hooks

- [ ] CHK019 Is an automated WCAG scan requirement (`@axe-core/playwright`, `@a11y` E2E tag) stated for the new surfaces? [Measurability, quickstart §5]
- [ ] CHK020 Can each a11y requirement be objectively verified (no unquantified terms like "usable" without criteria)? [Measurability, Spec §FR-035]

## Notes

- `[Gap]` items indicate a11y aspects the spec/UX-standard reference doesn't yet pin for
  F9 specifically — resolve or consciously accept before the affected surface ships.
