# UX Checklist: F2 — Membership Plans

**Purpose**: Validate the **quality of Enterprise UX requirements** in the F2 spec. The spec delegates heavily to `docs/ux-standards.md § 15` — this checklist tests whether the delegation is actionable for F2 reviewers, or whether it's a pointer without local specificity. This is a **unit-test suite for English** — each item asks whether the UX requirements themselves are complete, unambiguous, measurable, and specified at the spec level, NOT whether the implementation looks right.
**Created**: 2026-04-11
**Feature**: [spec.md](../spec.md)
**Depth**: Standard PR review (~18 items)
**Audience**: Maintainer self-review at `/speckit.tasks`, review agents at `/speckit.review`, reviewer at `/speckit.ship`

---

## Shimmer Skeleton & Loading States

- [ ] CHK041 Is the "shimmer skeleton in the final-table shape" rule quantified — specifically, does the spec define **what "final-table shape" means** (row count? column widths? padding?) with enough detail that a reviewer can tell a non-matching skeleton from a matching one? [Clarity, Spec FR-003, Plan §VI]
- [ ] CHK042 Is the target CLS value for the Plans list during skeleton-to-loaded transition specified as a measurable threshold (e.g., "0.0" vs. "< 0.1")? [Measurability, Plan §VI]
- [ ] CHK043 Are skeleton requirements specified for every loading surface in F2 — list, edit form, wizard steps, palette results, fee-config page — or only for the list? [Coverage, Spec FR-003]
- [ ] CHK044 Is the reduced-motion fallback from shimmer → static pulse explicitly specified as a requirement, with the behaviour of `prefers-reduced-motion: reduce` defined? [Completeness, Research §10.1]

## Toast Notifications

- [ ] CHK045 Are toast-duration requirements quantified for each variant — success (4s default?), success-with-undo (10s), error (8s?), info (6s) — or left as "auto-dismiss"? [Clarity, Research §10.2]
- [ ] CHK046 Is the rule *"exactly one toast per feedback path"* specified as a testable invariant, with the anti-pattern (two toasts for one action) named explicitly? [Measurability, Research §10.2]
- [ ] CHK047 Is screen-reader announcement behaviour for toasts specified — specifically, that sonner's built-in `aria-live` region is required? [Completeness, Research §10.2]

## Confirmation Dialogs

- [ ] CHK048 Is the confirmation-dialog copy template specified for each destructive action — deactivate, soft-delete, clone-when-target-exists — with the "explicit verb" rule enforced? [Clarity, Research §10.3]
- [ ] CHK049 Are the three copy requirements (title verb, body with concrete object, primary-button verb echo) enumerated as distinct rules rather than bundled as "follow ux-standards § 4.1"? [Completeness, Research §10.3]
- [ ] CHK050 Is the "secondary button is always Cancel, focused on open" rule stated as a testable requirement, not implied? [Clarity, Research §10.3]

## Keyboard-First & Focus Management

- [ ] CHK051 Is the complete keyboard-shortcut inventory for F2 documented in one place — `⌘K`, `/`, `Tab`, `Shift+Tab`, `Enter`, `Esc`, arrow navigation — so the reviewer can check a keyboard-only run covers every path? [Completeness, Research §10.5]
- [ ] CHK052 Is the rule *"focus returns to the triggering element when a dialog or palette closes"* specified as a requirement, not as a library-default assumption? [Clarity, Research §10.5]
- [ ] CHK053 Are keyboard-only test-suite requirements for `tests/e2e/plans-keyboard-only.spec.ts` specified — including the rule that the test file MUST NOT contain mouse calls (`page.click`, `page.hover`)? [Measurability, Plan tests]
- [ ] CHK054 Is "focus ring visibility" specified with objective criteria (e.g., "visible in both light and dark themes, meets WCAG 2.4.7 Focus Visible") rather than as "focus rings are visible"? [Measurability]

## i18n UX Requirements

- [ ] CHK055 Is the "missing translation" indicator for admin views specified visually — is it a badge, an icon, a coloured cell, inline text? — or left as "a visible indicator"? [Clarity, Spec FR-004]
- [ ] CHK056 Are the locale-aware currency-formatting requirements specified with concrete examples per locale (e.g., `฿36,000` for EN/TH, `36 000 ฿` for SV)? [Completeness, Assumptions]
- [ ] CHK057 Is the Thai Buddhist Era display rule scoped to `th-TH` user-facing surfaces only, with the storage rule (ISO 8601 UTC Gregorian) restated to prevent mixing? [Consistency, Spec Conventions]

## Empty States & Error States

- [ ] CHK058 Are empty-state copy requirements specified for each zero-state — no plans for current year, no palette matches, no deleted plans in "Show deleted" mode — or left as a generic "empty state component"? [Completeness, Research §10.7]
- [ ] CHK059 Is the "no palette matches" empty state's CTA behaviour specified (does it suggest creating a new plan? does it link to docs?) or left ambiguous? [Clarity, Research §10.7]

## Light + Dark Theme Parity

- [ ] CHK060 Are the required Tailwind theme tokens (`bg-background`, `text-foreground`, `border-border`) specified as the ONLY allowed tokens for new F2 components, or is it left as guidance? [Clarity, Research §10.6]
- [ ] CHK061 Is the visual-regression test requirement for both themes specified with the screenshot-storage location and naming convention? [Measurability, Research §10.6]

## Inline Banner — Prior-Year Lock

- [ ] CHK062 Is the prior-year-lock banner's copy template specified (localised for EN/TH/SV), or left as "a persistent banner explaining the lock"? [Clarity, Spec FR-014]
- [ ] CHK063 Is the banner's placement within the edit form specified (top of form? sticky? above the affected field?) or left ambiguous? [Clarity, Spec FR-014]

## Command Palette UX

- [ ] CHK064 Is the palette's cold-open vs. warm-open latency budget specified distinctly (per SC-008 split) and quantified in milliseconds? [Measurability, Spec SC-008]
- [ ] CHK065 Is the palette's result-grouping requirement specified — specifically, the three groups "Plans / Actions / Navigate" and their ordering rule? [Completeness, Research §4]

---

## Notes

- Check items off as completed: `[x]`
- Each item is a **test of the requirement's quality**, not of the implementation. "Pass" means the requirement is itself unambiguous and complete — not that a well-written implementation would satisfy it.
- Most F2 UX items delegate to `docs/ux-standards.md § 15`. A **gap** here usually means "the external doc is generic enough that a reviewer cannot map it onto this feature without extra interpretation". Fix gaps by either (a) inlining the applicable rule into the F2 spec, or (b) adding a cross-reference to a specific sub-section of ux-standards.md.
- **Target pass rate for `/speckit.review`**: 25/25 (100%). Gaps flagged during review become spec-edit tickets, not implementation-time surprises.
