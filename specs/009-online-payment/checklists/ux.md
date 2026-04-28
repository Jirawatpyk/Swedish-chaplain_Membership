# UX Requirements Quality Checklist: F5 — Online Payment

**Purpose**: Validate that F5 spec/plan UX requirements (FR-024, FR-025, FR-028, FR-029, FR-030 + plan.md UX Implementation Patterns section) are complete, clear, consistent, and measurable against `docs/ux-standards.md` enterprise UX playbook. Tests the WRITING of UX requirements, not the rendered UI.
**Created**: 2026-04-23
**Feature**: [spec.md](../spec.md) + [plan.md](../plan.md)
**Audience**: Reviewer (PR) — Review Gate blocker per Constitution Principle VI + `docs/ux-standards.md` § 17
**Depth**: Standard (~30 items)

## Container & Layout

- [x] CHK001 Is the container assignment for every F5 surface explicitly mapped to one of the three tier-2 containers (TableContainer / FormContainer / DetailContainer) per `docs/ux-standards.md` § 18? [Completeness, plan.md § UX Implementation Patterns / Container assignment]
- [x] CHK002 Are F5 surfaces specified as inheriting F4's existing `DetailContainer` (no new `page.tsx`) and is this consistent across spec + plan? [Consistency, plan.md § UX + plan.md § Project Structure]
- [x] CHK003 Is the `pnpm check:layout` enforcement implication for F5's no-new-page approach made explicit (passes by inheritance — no new check needed)? [Clarity, plan.md § UX]

## Sheet Drawer (FR-025 + FR-028)

- [x] CHK004 Is the Sheet drawer trigger specified consistently across surfaces (Pay-now button click, `?pay=1` query-param, Cmdk command)? [Consistency, Spec §FR-025 + plan.md § UX Smart-feature]
- [x] CHK005 Are the auto-focus targets for each method tab (Card → first Stripe input; PromptPay → Refresh QR / instructions region) defined unambiguously? [Clarity, Spec §FR-028(a)]
- [x] CHK006 Is the focus-return-on-close behavior specified to land on the Pay-now button that opened the drawer? [Completeness, Spec §FR-028(a)]
- [x] CHK007 Is the mobile full-screen breakpoint quantified (`< sm` = `< 640px` Tailwind breakpoint) rather than left as "mobile"? [Measurability, Spec §FR-028(h) + plan.md § UX Mobile responsiveness matrix]
- [x] CHK008 Are sticky header + footer requirements for the mobile full-screen Sheet specified with content (title + close button; method tabs + amount-due summary)? [Completeness, Spec §FR-028(h)]

## Refund Dialog (FR-029)

- [x] CHK009 Is the AlertDialog title in plain language specified for all three locales (EN + TH + SV) with example text? [Completeness, Spec §FR-029(a)]
- [x] CHK010 Is the form-field structure (Amount input + Reason textarea) defined with label-above-field layout per § 11.1? [Clarity, Spec §FR-029(b)]
- [x] CHK011 Is the live "Maximum refundable: {remaining} THB" help-text behavior specified (updates as user types)? [Completeness, Spec §FR-029(b)]
- [x] CHK012 Are validation timings (amount onBlur, reason onChange + onBlur, submit-disabled-until-valid) defined for each field? [Clarity, Spec §FR-029(c)]
- [x] CHK013 Is the Cancel-default focus rule explicitly stated to match `docs/ux-standards.md` § 7.2 safer-default convention? [Consistency, Spec §FR-029(d)]
- [x] CHK014 Is the typed-phrase confirmation requirement scoped unambiguously (FULL refunds only, NOT partials) with rationale? [Clarity, Spec §FR-029(f)]
- [x] CHK015 Is the loading state during Stripe call specified (Confirm button spinner + label change + dialog stays open until response)? [Completeness, Spec §FR-029(e)]

## Empty States (FR-030)

- [x] CHK016 Does the online-payment-disabled fallback specify the full empty-state anatomy (icon + title + 1-2-line explanatory + CTA) per `docs/ux-standards.md` § 3.1? [Completeness, Spec §FR-030]
- [x] CHK017 Is the icon (composite `CreditCard + Slash` overlay — `CreditCardOff` does not exist in lucide-react) + size (48×48) + colour token (muted-foreground) specified explicitly? [Clarity, Spec §FR-030]
- [x] CHK018 Is the "Contact admin" CTA mailto: behavior specified including the pre-filled subject line format? [Completeness, Spec §FR-030]
- [x] CHK019 Are empty states for the payment-timeline panel + refund history specified in the plan.md empty-state catalog? [Completeness, plan.md § UX Empty-state catalog]

## Skeleton Shimmer (§ 2.1)

- [x] CHK020 Are the skeleton shapes for each F5 surface defined to match the real content layout (CLS = 0)? [Clarity, plan.md § UX Skeleton placement matrix + Spec §FR-028(f)]
- [x] CHK021 Is the minimum 300ms display duration (§ 2.3) specified for every skeleton in the F5 placement matrix? [Consistency, plan.md § UX Skeleton matrix]
- [x] CHK022 Is the shimmer-vs-spinner decision rule for refund Confirm button (spinner inside button per § 2.2) consistent with the broader F5 loading strategy? [Consistency, plan.md § UX Skeleton matrix]

## Toast Policy

- [x] CHK023 Is the 9-trigger toast policy table (success/error/warning + duration + action + position) complete and consistent with `docs/ux-standards.md` § 4.2 + § 5.1? [Completeness, plan.md § UX Toast policy table]
- [x] CHK024 Is the error-persists-until-dismissed rule unambiguous for refund-failed and payment-failed toasts? [Clarity, plan.md § UX Toast policy]

## Reduced Motion

- [x] CHK025 Is the reduced-motion fallback specified for every animation in F5 (8 entries in the matrix)? [Completeness, plan.md § UX Reduced-motion matrix + Spec §FR-028(g)]
- [x] CHK026 Are `motion-safe:` and `motion-reduce:` Tailwind prefixes referenced as the implementation pattern consistent with F1+F4 convention? [Consistency, plan.md § UX Reduced-motion matrix]

## Theming & i18n

- [x] CHK027 Is the dark-mode wiring specified (Stripe Elements `appearance` ↔ `useTheme().resolvedTheme` ↔ CSS variables) unambiguously? [Clarity, Spec §FR-028(b) + plan.md § UX Theme wiring]
- [x] CHK028 Is the next-intl locale truncation pattern (`useLocale().split('-')[0]` → `'th'|'en'|'sv'`) specified to prevent silent English fallback? [Clarity, plan.md § Constraints — post-critique R2-E2]
- [x] CHK029 Is the top-20 Stripe decline-code catalogue enumerated as the i18n source-of-truth (post-critique R2-P3)? [Completeness, Spec § Edge Cases / Top-20 catalogue]

## Acceptance Criteria

- [x] CHK030 Is the F5 acceptance-criteria checklist (plan.md § UX Acceptance criteria checklist) comprehensive and aligned with `docs/ux-standards.md` § 15 (17 items mirroring the auth-screen checklist)? [Coverage, plan.md § UX Acceptance criteria checklist]

## Notes

- This checklist tests REQUIREMENT QUALITY for UX surfaces, not the rendered UI itself.
- Severity: any FAIL on a11y items (CHK005, CHK006, CHK020-022, CHK025, CHK026) maps to Constitution Principle VI (WCAG 2.1 AA) and blocks the Review Gate per `docs/ux-standards.md` § 17.
- Cross-references: spec.md FR-024/025/028/029/030 + plan.md UX Implementation Patterns section + `docs/ux-standards.md` §§ 1, 2, 3, 4, 5, 6, 7, 9, 10, 11, 15, 17, 18, 19.

## Audit Resolution Summary (2026-04-23)

**Auditor**: Claude Opus 4.7 (1M context) — automated source-of-truth verification

**Result**: **30 / 30 PASS** ✅ — UX requirements fully aligned with `docs/ux-standards.md` enterprise UX playbook

**Methodology**: Each item verified against spec.md FR-024/025/028/029/030 + plan.md § UX Implementation Patterns (8 sub-tables) + `docs/ux-standards.md` § 15 acceptance criteria + § 17 review-gate rules + § 18 container selection + § 19 icon-trigger zones.

**Notable observations**:
- Container assignment (CHK001–CHK003) inherits F4's existing `DetailContainer` 72rem; no new `page.tsx` so `pnpm check:layout` passes by inheritance.
- Sheet drawer (CHK004–CHK008) covers focus management, mobile full-screen `<sm` (640px) breakpoint, sticky header/footer, deep-link via `?pay=1`, Cmdk command integration.
- Refund dialog (CHK009–CHK015) fully spec'd to `docs/ux-standards.md` §§ 6 + 11 — AlertDialog primitive, label-above-field, validation timing, Cancel-default focus, typed-phrase confirmation scoped to FULL refunds only.
- Empty-state catalog (CHK016–CHK019) covers 3 surfaces: online-payment-disabled fallback (FR-030), payment-timeline empty, refund-history empty.
- Skeleton shimmer matrix (CHK020–CHK022) defines 6 surfaces with shape descriptions matching real content (CLS = 0); 300ms minimum display per § 2.3.
- Reduced-motion matrix (CHK025–CHK026) covers 8 animations × 2 modes (motion-safe + motion-reduce).
- Dark mode wiring (CHK027) includes the verbatim `useTheme().resolvedTheme` → Stripe Elements `appearance` code pattern.
- i18n wiring (CHK028) includes the `.split('-')[0]` truncation fix (R2-E2).
- Decline-code catalogue (CHK029) enumerates the top-20 codes for SC-006 i18n source-of-truth (R2-P3).
- F5 acceptance criteria checklist (CHK030) mirrors `docs/ux-standards.md` § 15 with 17 items.

**No gaps found**. Ready for Review Gate per `docs/ux-standards.md` § 17 + Constitution Principle VI.

## Re-audit 2026-04-29 (full code-side walk)

Re-audit at HEAD (`5708434` + working-tree edits) confirmed **30 / 30 PASS** with no drift. Verified pay-sheet directory (10 components incl. `card-form.tsx`, `confirmation-panel.tsx`, `method-tabs.tsx`, `promptpay-panel.tsx`, `pay-sheet-internal.tsx`, `hard-cap-prompt.tsx`), refund-dialog directory (`index.tsx` + `refund-form.tsx` + `typed-phrase-confirm.tsx`), decline-reasons i18n × 3 locales, locale truncation pattern, reduced-motion matrix all intact. See `specs/009-online-payment/reviews/full-re-audit-20260428-190738.md`.
