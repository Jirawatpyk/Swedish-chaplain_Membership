# Accessibility (WCAG 2.1 AA) Requirements Quality Checklist: F9

**Purpose**: Validate that F9's **accessibility requirements** are complete, clear, and
measurable across all surfaces (dashboard, audit viewer, directory, timeline, benefits,
GDPR export) — *before* implementation. Tests the requirements, not the UI.
**Created**: 2026-05-25
**Feature**: [spec.md](../spec.md) · constitution v1.4.2 (Principle VI) · `docs/ux-standards.md`
**Depth**: Formal release gate · **Audience**: reviewer

> "Is the a11y requirement specified?" — not "Does the screen reader work?"

## Coverage Across Surfaces

- [x] CHK001 Is the WCAG 2.1 AA conformance requirement stated for **every** F9 surface, not just "the feature" generally? [Completeness, Spec §FR-035] → VERIFIED 2026-05-25: FR-035 + SC-010 ("All F9 surfaces").
- [x] CHK002 Is mobile-first (≥320px) layout required for the data-dense dashboard, audit table, and directory? [Coverage, Constitution VI, Spec §FR-035] → VERIFIED 2026-05-25: plan Principle VI ("layouts from 320px") + FR-035.
- [x] CHK003 Are keyboard-operability requirements (full nav, visible focus) specified for all interactive F9 elements (filters, dismiss buttons, table sort, export actions)? [Completeness, Spec §FR-035] → VERIFIED 2026-05-25: FR-035 (keyboard operable) + plan VI (visible focus).

## Data Visualisation Accessibility

- [x] CHK004 Is the requirement that dashboard charts render as **accessible SVG/CSS with a text/`<table>` equivalent** (no canvas-only data) stated and testable? [Clarity, research R8, Spec §FR-035] → VERIFIED 2026-05-25: research R8 + plan VI (accessible SVG + table equivalent, no canvas-only).
- [x] CHK005 Are non-color-dependent encodings required for the Engagement Score bands and benefit-usage bars (color is not the only signal)? [Coverage, Spec §FR-035] → RESOLVED 2026-05-25: FR-035 requires text label and/or icon/shape (WCAG 1.4.1), not colour alone.
- [x] CHK006 Is a contrast requirement (≥4.5:1 text) stated for the new KPI cards, bands, and warning states? [Measurability, Constitution VI] → VERIFIED 2026-05-25: WCAG 2.1 AA conformance (FR-035/SC-010) mandates ≥4.5:1 text contrast.

## State Requirements (loading / empty / error)

- [x] CHK007 Are shimmer-skeleton loading-state requirements specified for async dashboard/timeline/benefit data per the UX standard? [Completeness, `docs/ux-standards.md`, Spec §FR-035] → VERIFIED 2026-05-25: FR-035 (loading skeletons) + plan VI (shimmer skeletons).
- [x] CHK008 Are empty-state requirements defined for every section so a zero-data tenant never sees an error/NaN, and are they distinguishable from error states? [Coverage, Spec §FR-006, Edge Cases] → VERIFIED 2026-05-25: FR-006 + Edge Cases + research R1/E3 (empty vs snapshot_unavailable error distinct).
- [x] CHK009 Is the dashboard cold-start ("computing…") presentation required to be an accessible status, not a silent blank? [Clarity, research R1/E3] → VERIFIED 2026-05-25: research R1/E3 (friendly "computing…" state) + FR-035 (all surfaces accessible).
- [x] CHK010 Are error-state requirements (friendly, localized, screen-reader-announced) defined for export/snapshot failures? [Completeness, Spec §FR-037] → VERIFIED 2026-05-25: FR-037 (no silent failure) + FR-035 (SR-announced errors) + FR-034 (localised).

## Dynamic Content & Announcements

- [x] CHK011 Is the live activity feed required to update without trapping focus or spamming screen-reader announcements (politeness level defined)? [Clarity, Spec §FR-003] → RESOLVED 2026-05-25: FR-003 requires a **polite** live region, no focus steal, no reordering of items in use.
- [x] CHK012 Are toast/confirmation requirements specified for state-changing actions (dismiss insight, update directory visibility, request export) per the UX standard? [Completeness, `docs/ux-standards.md`] → VERIFIED 2026-05-25: FR-035 (toasts for actions) + docs/ux-standards.md.
- [x] CHK013 Is incremental/virtualized timeline loading required to remain keyboard-reachable and announce newly loaded entries? [Coverage, Spec §FR-016/035] → RESOLVED 2026-05-25: covered by FR-035 (keyboard-operable + screen-reader-labelled) applied to FR-016 incremental loading.

## Forms & Controls

- [x] CHK014 Are label/association + error-messaging requirements defined for the audit filter controls and directory-visibility toggles? [Completeness, Spec §FR-035] → RESOLVED 2026-05-25: FR-035 now requires programmatic labels + screen-reader-announced validation for all F9 form controls.
- [x] CHK015 Is the logo upload control required to expose accessible labels, error feedback (reject reason), and a non-pointer path? [Coverage, Spec §FR-025a] → VERIFIED 2026-05-25: FR-035 (logo upload programmatic labels + SR error messaging + keyboard operable) + FR-025a.
- [x] CHK016 Are target-size / focus-not-obscured requirements considered for dense table controls (per the F3 opportunistic WCAG 2.2 adoption)? [Consistency, prior-art F3] → RESOLVED 2026-05-25: FR-035 now opportunistically adopts F3 WCAG 2.2 SC 2.5.8 (target ≥24×24px) + SC 2.4.11 (focus not obscured) on dense controls.

## Motion & Preferences

- [x] CHK017 Is `prefers-reduced-motion` respected for any dashboard transitions/animated bars? [Completeness, Constitution VI, Spec §FR-035] → VERIFIED 2026-05-25: FR-035 + plan VI (reduced-motion respected).
- [x] CHK018 Is `prefers-color-scheme` (light/dark) required for the new surfaces, consistent with existing theming? [Consistency, Constitution VI] → RESOLVED 2026-05-25: FR-035 now requires F9 surfaces honour `prefers-color-scheme`, consistent with platform theming.

## Verification Hooks

- [x] CHK019 Is an automated WCAG scan requirement (`@axe-core/playwright`, `@a11y` E2E tag) stated for the new surfaces? [Measurability, quickstart §5] → VERIFIED 2026-05-25: plan Testing + tasks T097 (@a11y) + quickstart §5.
- [x] CHK020 Can each a11y requirement be objectively verified (no unquantified terms like "usable" without criteria)? [Measurability, Spec §FR-035] → VERIFIED 2026-05-25: FR-035 enumerates concrete criteria; SC-010 axe-core verifiable.

## Notes

- All previously-flagged `[Gap]` items (CHK005, CHK011, CHK013, CHK014) were **resolved
  2026-05-25** via FR-003 (polite live region) and FR-035 (non-colour encoding + form
  labels/error messaging).
- **Requirements-quality verification PASS (2026-05-25)**: all 20 items confirmed
  specified; CHK016 (WCAG 2.2 target-size/focus) + CHK018 (prefers-color-scheme) closed by
  an FR-035 amendment. No open a11y gaps. The *axe-core scan* of the implementation remains
  a Verify-gate action per tasks T097.
