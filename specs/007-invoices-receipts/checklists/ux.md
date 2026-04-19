# UX Requirements Quality Checklist: F4 — Membership Invoicing & Thai-Tax Receipts

**Purpose**: Validate the **quality of UX/UI requirements** in spec + plan — against `docs/ux-standards.md § 15` enterprise checklist, WCAG 2.1 AA, i18n (EN+TH+SV), mobile-first, state coverage (empty / loading / error / success), confirmation discipline for destructive actions, keyboard + screen-reader support. "Unit tests for English" — testing whether UX requirements are well-written, quantified, and consistent, NOT whether the UI renders correctly.
**Created**: 2026-04-18
**Feature**: [spec.md](../spec.md)
**Plan**: [plan.md](../plan.md)
**Depth**: Standard (PR review gate, pre-`/speckit.tasks`)
**Full audit**: 2026-04-18 post-commit c5370af — all 30 items evaluated

## State Coverage (Loading / Empty / Error / Success)

- [x] CHK001 Are empty-state requirements specified for every list surface (admin invoices, member portal invoices, member-page invoices section, credit-note list)? [Completeness, Spec US3 AS3, US4 AS5] — **PASS**: US3 AS3 ("member with no invoices yet ... helpful empty state"); US4 AS5 ("empty-state card" for settings bootstrap); US7 AS4 specifies latest-3 summary behaviour; admin list empty state inherits the F3 TanStack Table empty-state pattern (T057)
- [x] CHK002 Is the empty-state content requirement defined for the "no settings yet" bootstrap case (card + CTA + blocked actions)? [Clarity, Spec US4 AS5] — **PASS**: US4 AS5 explicit: "empty-state card displays 'Finish invoice setup to start billing' with a primary CTA button 'Configure Invoicing' linking to /admin/invoice-settings; draft creation + issuance are blocked with the same message"
- [x] CHK003 Are loading-state requirements (shimmer skeletons on CLS 0 shape per ux-standards § 2.1) specified for list surfaces + detail surfaces? [Completeness, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "Shimmer skeleton on invoice list + member invoices section (CLS 0 per ux-standards § 2.1)"; tasks T057 (invoice-table), T087 (member-invoices-section) implement
- [x] CHK004 Are error-state requirements specified for issuance failures (PDF render failed, member archived, settings incomplete) with user-facing copy rather than raw error codes? [Clarity, Spec §FR-010, Plan Complexity Tracking] — **PASS**: FR-010 ("explaining which fields are missing"); FR-037 ("Cannot issue invoice for an archived member — undelete first"); Contracts § 1.6 Errors enumerate `conflict`, `pdf_render_failed`, `rate_limited` with user-facing semantics
- [x] CHK005 Are success-state requirements (sonner toasts on every mutation) specified per action (draft saved, issued, paid, voided, credit-note issued, resent)? [Completeness, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "sonner toasts on every mutation"; T057/T064/T066/T080/T100/T107 each wire sonner feedback per ux-standards § 4.2

## Draft Lifecycle UX

- [x] CHK006 Is the draft-vs-issued distinction specified in a way that makes the transition (and its irreversibility) obvious to the admin — not left as "click Issue"? [Clarity, Spec §FR-001] — **PASS**: FR-001 explicit: "An explicit Issue action transitions draft → issued ... thereafter the invoice is immutable"; FR-039 + FR-040 add visual + typed-phrase confirmation for irreversibility
- [x] CHK007 Is the draft-preview PDF watermark requirement specified with exact bilingual text ("DRAFT / ร่าง — NOT A TAX DOCUMENT") rather than abstract "watermark"? [Clarity, Spec §FR-001a] — **PASS**: FR-001a explicit: "stamps a clear 'DRAFT / ร่าง — NOT A TAX DOCUMENT' watermark"; US1 AS5 reiterates the exact bilingual text
- [x] CHK008 Is the default list filter behaviour (exclude drafts) specified at the UI level AND as an API contract default? [Consistency, Spec US1 AS6, Contracts §1.2] — **PASS**: US1 AS6 ("drafts are excluded by default; drafts accessible via a clearly-labelled 'Drafts' tab or filter pill with a count badge"); Contracts § 1.2 API default matches: "if the `status` query param is absent, drafts are excluded"
- [x] CHK009 Are the preview-vs-issue affordances specified to avoid confusing "Preview" with "Issue"? [Clarity, Gap] — **PASS**: FR-039 — Preview = secondary/outline; Issue = primary/solid + typed-phrase confirmation; visual separation required

## Confirmation Dialogs (Destructive Actions)

- [x] CHK010 Are typed-phrase confirmation requirements specified for Issue (consumes seq number — irreversible)? [Clarity, Plan Constitution Check VI] — **PASS**: FR-040: "Every destructive or irreversible F4 action — Issue (consumes sequence number), Void (terminal), Credit Note issuance (creates a new tax document) — MUST require a typed-phrase confirmation dialog"
- [x] CHK011 Are typed-phrase confirmation requirements specified for Void (terminal state)? [Consistency, Plan Constitution Check VI] — **PASS**: FR-040 covers Void uniformly (see CHK010)
- [x] CHK012 Are typed-phrase confirmation requirements specified for Credit Note issuance (creates a new tax document)? [Completeness, Gap] — **PASS**: FR-040 covers Issue + Void + Credit Note uniformly
- [x] CHK013 Is the confirmation language localised per EN+TH+SV with matching typed phrases (or locale-independent phrase like document number)? [Consistency, i18n, Gap] — **PASS**: FR-040 specifies locale-independent typed phrase (document number OR "ISSUE"/"VOID"/"CREDIT" keyword)

## Internationalisation (EN + TH + SV)

- [x] CHK014 Is the set of new i18n keys planned (~180) enumerated at category granularity (admin.invoices.*, portal.invoices.*, admin.creditNotes.*, admin.invoiceSettings.*, audit.invoice.*, auto-email subjects)? [Completeness, Plan Project Structure] — **PASS**: Plan Project Structure i18n/messages/*.json section explicit: "+~180 keys under admin.invoices.* + portal.invoices.* + audit.invoice.*"; Plan Auto-email Template Conventions § adds `admin.invoices.autoEmail.subject.*` namespace; tasks T060/T067/T073/T081/T089/T096/T103 add category-specific keys per phase
- [x] CHK015 Are bilingual PDF requirements (TH primary + EN translations on the same document) specified distinctly from UI-locale switching (EN+TH+SV)? [Consistency, Spec §FR-018] — **PASS**: FR-018: "System MUST support SV + EN + TH locale rendering for all non-PDF admin and member UI; the PDF MUST render Thai + English regardless of the viewer's locale (tax documents are locale-independent for Thai RD purposes)"
- [x] CHK016 Are EN-key-missing-fails-build + TH/SV-fall-back-with-CI-failure requirements reiterated for F4 or explicitly inherited? [Completeness, Plan Constitution Check V] — **PASS**: Plan Constitution Check V: "Missing EN keys fail the build. TH+SV enforced on release branches via `pnpm check:i18n`"
- [x] CHK017 Are Thai amount-in-words and English amount-in-words specified as required PDF elements with unambiguous precision (satang vs. baht)? [Clarity, Plan research §6] — **PASS**: Plan Technical Context declares `thai-baht-text@^1`; T043 wraps it; Research § 6 + § 10 specify satang precision; PDF templates T044/T065/T079/T101 include amount-in-words TH + EN
- [x] CHK018 Is the auto-email subject/body i18n coverage specified per event type (issued, paid, voided, credit-note, resend) for EN+TH? [Completeness, Plan Auto-email Template Conventions §] — **PASS**: Plan Auto-email Template Conventions § enumerates subject keys for `issued`, `paid`, `voided`, `creditNote`, `resend` under `admin.invoices.autoEmail.subject.*`; body templates enumerated under `src/modules/invoicing/infrastructure/email/templates/{issued,paid,voided,credit-note}.tsx`

## Accessibility (WCAG 2.1 AA)

- [x] CHK019 Is the WCAG 2.1 AA conformance gate declared with explicit scope (every new screen) and automated tooling (axe-core in Playwright)? [Measurability, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "`docs/ux-standards.md` § 15 checklist is a merge blocker. ... Automated `@axe-core/playwright` WCAG 2.1 AA scan in `tests/e2e/invoice-a11y.spec.ts`"; T061 includes axe-core scan
- [x] CHK020 Are aria-live announcement requirements specified for seq-number-on-issue and payment-recorded-confirmation events? [Completeness, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "aria-live announces seq-number on successful issue"; T058 wires aria-live region for the issue-confirm-dialog success announcement + payment-recorded feedback via sonner (which uses aria-live internally)
- [x] CHK021 Is full keyboard-navigation requirement specified per surface (list, draft form, confirmation dialogs, credit-note form)? [Coverage, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "Full keyboard nav on draft form, list, bulk select, credit-note dialog"
- [x] CHK022 Is focus-return-on-dialog-close specified as a standard behaviour rather than per-dialog? [Consistency, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI inherits the F1/F3 pattern ("Focus returns to triggering element on dialog close" — inherited from F3 spec + ux-standards § 7)
- [x] CHK023 Is `prefers-reduced-motion` behaviour specified with a concrete swap (instant transition) rather than abstract "respect it"? [Clarity, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "`prefers-reduced-motion` swaps any motion-y transitions for instant"; spec Edge Cases: "all toasts, skeletons, and state transitions must respect `prefers-reduced-motion` per `docs/ux-standards.md`"; T114c manual pass verifies

## Mobile-First + Responsive

- [x] CHK024 Are mobile-first layout requirements specified with an exact minimum breakpoint (320 px from Constitution Principle VI)? [Measurability, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "Layouts start at 320px"; Constitution Principle VI mandates 320px mobile-first baseline inherited
- [x] CHK025 Are PDF download interactions specified for mobile (native share vs. download behaviour)? [Gap, Plan Project Structure] — **PASS**: FR-041 — iOS Safari share sheet, Chrome Android download, no blocking inline iframe, `Content-Disposition: attachment` + deterministic filename

## Member Portal Parity

- [x] CHK026 Are member-portal surfaces specified to inherit the same standards as admin surfaces ("no degraded UX for member persona")? [Consistency, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "Member self-service portal (/portal/invoices) inherits identical standards — no degraded UX for the member persona"
- [x] CHK027 Are portal-landing compact summary requirements (latest 3 + "view all" link + empty state) specified with item counts and link behaviour? [Completeness, Spec US7 AS4] — **PASS**: US7 AS4: "compact invoice-history summary (latest 3 + 'view all' link) is visible — this is a read-only surface that links into US3's full list"; T072 implements `invoices-summary-card.tsx`

## Enterprise UX Standards (§ 15 checklist)

- [x] CHK028 Are every § 15 checklist item (shimmer skeletons, toasts, confirmation dialogs, idle warning, theming, keyboard & focus management) mapped to at least one F4 surface? [Traceability, ux-standards §15] — **PASS**: Plan Constitution Check VI enumerates each § 15 requirement: shimmer (invoice list + member section CLS 0), sonner toasts (every mutation), confirmation dialogs (FR-040 typed-phrase on Issue/Void/Credit), idle warning (inherited from F1 auth), theming (light/dark parity via `next-themes`), keyboard + focus (full kb nav + focus return)
- [x] CHK029 Are light/dark theme parity requirements specified or explicitly inherited? [Completeness, Plan Constitution Check VI] — **PASS**: Plan Constitution Check VI: "Light + dark parity via `next-themes`" (inherited from F1+F2+F3 unchanged); theme-aware PDF templates N/A (PDFs are locale-fixed, no theming)
- [x] CHK030 Are skip-to-content + ARIA landmark requirements specified for every new layout? [Coverage, Gap] — **PASS**: FR-042 — skip-to-content first tab stop, `main` + `navigation` + `complementary` landmarks matching F1+F3 pattern; T056a in tasks explicitly adds

---

**Traceability summary**: 30/30 items verified with evidence citations to spec/plan/data-model/research/contracts/tasks. Coverage 100%. **All items PASS.**
