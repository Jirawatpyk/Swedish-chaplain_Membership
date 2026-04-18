# UX Requirements Quality Checklist: F4 — Membership Invoicing & Thai-Tax Receipts

**Purpose**: Validate the **quality of UX/UI requirements** in spec + plan — against `docs/ux-standards.md § 15` enterprise checklist, WCAG 2.1 AA, i18n (EN+TH+SV), mobile-first, state coverage (empty / loading / error / success), confirmation discipline for destructive actions, keyboard + screen-reader support. "Unit tests for English" — testing whether UX requirements are well-written, quantified, and consistent, NOT whether the UI renders correctly.
**Created**: 2026-04-18
**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Depth**: Standard (PR review gate, pre-`/speckit.tasks`)

## State Coverage (Loading / Empty / Error / Success)

- [ ] CHK001 Are empty-state requirements specified for every list surface (admin invoices, member portal invoices, member-page invoices section, credit-note list)? [Completeness, Spec US3 AS3, US4 AS5]
- [ ] CHK002 Is the empty-state content requirement defined for the "no settings yet" bootstrap case (card + CTA + blocked actions)? [Clarity, Spec US4 AS5]
- [ ] CHK003 Are loading-state requirements (shimmer skeletons on CLS 0 shape per ux-standards § 2.1) specified for list surfaces + detail surfaces? [Completeness, Plan Constitution Check VI]
- [ ] CHK004 Are error-state requirements specified for issuance failures (PDF render failed, member archived, settings incomplete) with user-facing copy rather than raw error codes? [Clarity, Spec §FR-010, Plan Complexity Tracking]
- [ ] CHK005 Are success-state requirements (sonner toasts on every mutation) specified per action (draft saved, issued, paid, voided, credit-note issued, resent)? [Completeness, Plan Constitution Check VI]

## Draft Lifecycle UX

- [ ] CHK006 Is the draft-vs-issued distinction specified in a way that makes the transition (and its irreversibility) obvious to the admin — not left as "click Issue"? [Clarity, Spec §FR-001]
- [ ] CHK007 Is the draft-preview PDF watermark requirement specified with exact bilingual text ("DRAFT / ร่าง — NOT A TAX DOCUMENT") rather than abstract "watermark"? [Clarity, Spec §FR-001a]
- [ ] CHK008 Is the default list filter behaviour (exclude drafts) specified at the UI level AND as an API contract default? [Consistency, Spec US1 AS6, Contracts §1.2]
- [x] CHK009 Are the preview-vs-issue affordances specified to avoid confusing "Preview" with "Issue"? [Clarity, Gap] — **RESOLVED**: FR-039 — Preview = secondary/outline; Issue = primary/solid + typed-phrase confirmation; visual separation required

## Confirmation Dialogs (Destructive Actions)

- [ ] CHK010 Are typed-phrase confirmation requirements specified for Issue (consumes seq number — irreversible)? [Clarity, Plan Constitution Check VI]
- [ ] CHK011 Are typed-phrase confirmation requirements specified for Void (terminal state)? [Consistency, Plan Constitution Check VI]
- [x] CHK012 Are typed-phrase confirmation requirements specified for Credit Note issuance (creates a new tax document)? [Completeness, Gap] — **RESOLVED**: FR-040 covers Issue + Void + Credit Note uniformly
- [x] CHK013 Is the confirmation language localised per EN+TH+SV with matching typed phrases (or locale-independent phrase like document number)? [Consistency, i18n, Gap] — **RESOLVED**: FR-040 specifies locale-independent typed phrase (document number OR "ISSUE"/"VOID"/"CREDIT" keyword)

## Internationalisation (EN + TH + SV)

- [ ] CHK014 Is the set of new i18n keys planned (~180) enumerated at category granularity (admin.invoices.*, portal.invoices.*, admin.creditNotes.*, admin.invoiceSettings.*, audit.invoice.*, auto-email subjects)? [Completeness, Plan Project Structure]
- [ ] CHK015 Are bilingual PDF requirements (TH primary + EN translations on the same document) specified distinctly from UI-locale switching (EN+TH+SV)? [Consistency, Spec §FR-018]
- [ ] CHK016 Are EN-key-missing-fails-build + TH/SV-fall-back-with-CI-failure requirements reiterated for F4 or explicitly inherited? [Completeness, Plan Constitution Check V]
- [ ] CHK017 Are Thai amount-in-words and English amount-in-words specified as required PDF elements with unambiguous precision (satang vs. baht)? [Clarity, Plan research §6]
- [ ] CHK018 Is the auto-email subject/body i18n coverage specified per event type (issued, paid, voided, credit-note, resend) for EN+TH? [Completeness, Plan Auto-email Template Conventions §]

## Accessibility (WCAG 2.1 AA)

- [ ] CHK019 Is the WCAG 2.1 AA conformance gate declared with explicit scope (every new screen) and automated tooling (axe-core in Playwright)? [Measurability, Plan Constitution Check VI]
- [ ] CHK020 Are aria-live announcement requirements specified for seq-number-on-issue and payment-recorded-confirmation events? [Completeness, Plan Constitution Check VI]
- [ ] CHK021 Is full keyboard-navigation requirement specified per surface (list, draft form, confirmation dialogs, credit-note form)? [Coverage, Plan Constitution Check VI]
- [ ] CHK022 Is focus-return-on-dialog-close specified as a standard behaviour rather than per-dialog? [Consistency, Plan Constitution Check VI]
- [ ] CHK023 Is `prefers-reduced-motion` behaviour specified with a concrete swap (instant transition) rather than abstract "respect it"? [Clarity, Plan Constitution Check VI]

## Mobile-First + Responsive

- [ ] CHK024 Are mobile-first layout requirements specified with an exact minimum breakpoint (320 px from Constitution Principle VI)? [Measurability, Plan Constitution Check VI]
- [x] CHK025 Are PDF download interactions specified for mobile (native share vs. download behaviour)? [Gap, Plan Project Structure] — **RESOLVED**: FR-041 — iOS Safari share sheet, Chrome Android download, no blocking inline iframe, `Content-Disposition: attachment` + deterministic filename

## Member Portal Parity

- [ ] CHK026 Are member-portal surfaces specified to inherit the same standards as admin surfaces ("no degraded UX for member persona")? [Consistency, Plan Constitution Check VI]
- [ ] CHK027 Are portal-landing compact summary requirements (latest 3 + "view all" link + empty state) specified with item counts and link behaviour? [Completeness, Spec US7 AS4]

## Enterprise UX Standards (§ 15 checklist)

- [ ] CHK028 Are every § 15 checklist item (shimmer skeletons, toasts, confirmation dialogs, idle warning, theming, keyboard & focus management) mapped to at least one F4 surface? [Traceability, ux-standards §15]
- [ ] CHK029 Are light/dark theme parity requirements specified or explicitly inherited? [Completeness, Plan Constitution Check VI]
- [x] CHK030 Are skip-to-content + ARIA landmark requirements specified for every new layout? [Coverage, Gap] — **RESOLVED**: FR-042 — skip-to-content first tab stop, `main` + `navigation` + `complementary` landmarks matching F1+F3 pattern

---

**Traceability summary**: 30/30 items reference spec, plan, ux-standards, or explicit quality markers. Coverage ≥ 80% achieved.
