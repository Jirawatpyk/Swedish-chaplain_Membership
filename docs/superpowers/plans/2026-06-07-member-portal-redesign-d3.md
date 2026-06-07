# Member Portal Redesign — D3 Implementation Plan (Invoices polish)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task + two-stage review). Steps use `- [ ]` checkboxes.
>
> **Provenance note:** D3 is a *polish* pass (no new feature/data surface), so its scope was derived from a read-only audit of the existing member-portal **Invoices** surface against the D1/D2 polish bar + `docs/ux-standards.md`. The audit + implementation landed on branch `059-member-portal-d3` (commit `6a0bccb3`); this plan was authored alongside to keep the D-series record complete and to document the deferred items. Tasks already shipped are checked.

**Goal:** Bring the member-portal **Invoices** surface (list + `[invoiceId]` detail) up to the D1/D2 polish bar — card titles **inside** `CardHeader` (real `<h2>`, matching `benefit-usage-card.tsx`), page-header action buttons at the design-system **36px** height (`ux-standards.md` § 19), and small a11y/layout nits — **presentation-only**, no F4/F5 data or tax-document field-visibility changes.

**Architecture:** D3 of the 3-deliverable portal redesign (D1 nav+dashboard+profile → PR #72; D2 Benefits tabs + Account hub → PR #73 on branch `058-member-portal-d2`). D3 stacks on D2 (`059-member-portal-d3` off `058`) and touches the invoice **detail** page only — the list page is already at-bar (its loading skeleton, empty/not-linked states, status badges, and async receipt affordance all pass the audit). No backend, no new routes, no schema.

**Tech Stack:** Next.js 16 App Router (RSC) · shadcn `Card`/`CardHeader`/`CardContent` + a real `<h2>` (NOT the shadcn `CardTitle` div — see `benefit-usage-card.tsx` 056 fix #1) · `buttonVariants` size tokens (`ux-standards.md` § 19) · next-intl EN/TH/SV · Vitest. No new dependencies.

---

## Audit summary (what was checked, what passed)

A thorough read-only audit (Explore) mapped every file under `src/app/(member)/portal/invoices/**` against the D1/D2 bar + `ux-standards.md`. **Already at-bar (no change):** list loading skeleton (CLS-0, 7-col shape), list empty + not-linked states, status badge icon+text (WCAG 1.4.1), async receipt-preparing live region, bilingual TH/EN line display (§86), F5 pay-sheet PCI state, error/not-found boundaries, RLS-safe session `memberId` reads. **Polish gaps found** → Tasks 1–4 below.

---

## File Structure

### Modify (invoice detail polish)
- `src/app/(member)/portal/invoices/[invoiceId]/page.tsx` — move the **Line items** + **Credit notes** section `<h2>` into a `<CardHeader>`; add a `<CardHeader>` heading to the previously-unlabelled **Totals** `<dl>` card; normalize page-header action buttons (Download invoice / Download receipt / receipt-preparing / Resend / Pay) from `min-h-11` (44px) → `h-9` (36px) per § 19; add `break-words` to the void-reason `<dd>`.
- `src/app/(member)/portal/invoices/[invoiceId]/loading.tsx` — mirror the new shape: title skeletons **inside** `CardHeader` for the lines + totals cards; header action skeleton `h-11` → `h-9` (CLS-0).
- `src/app/(member)/portal/invoices/[invoiceId]/_components/pay-sheet/pay-now-button.tsx` — Pay button `size="sm"` + `min-h-11` → `size="default"` (h-9, 36px) so the whole page-header row aligns (§ 19 lists "Pay" as a 36px page-header button).
- `src/app/(member)/portal/invoices/_components/resend-invoice-button.tsx` — add an **additive** optional `size?: 'sm' | 'default'` prop (default `'sm'` → the list table-row resend button is byte-for-byte unchanged); the detail page passes `size="default"`.
- `src/i18n/messages/en.json` — add `portal.invoices.detail.totals.heading` = "Summary".
- `src/i18n/messages/th.json` — same key, TH "สรุปยอด".
- `src/i18n/messages/sv.json` — same key, SV "Sammanfattning".

### Out of scope (do NOT touch)
- `src/app/(member)/portal/invoices/page.tsx` (list) — table-row download/resend buttons stay at their denser-zone height (§ 19 allows tighter targets in table rows); list surface is already at-bar.
- Any tax-document **field-visibility** logic (e.g. the void-after-paid receipt-number conditional) — tax-adjacent (Thai RD § 105ทวิ), see Deferred.

---

## Tasks

### Task 1 — card titles into `CardHeader` (detail page) — `- [x]` DONE (`6a0bccb3`)
The Line-items + Credit-notes section titles were the first child of `CardContent` (inconsistent card chrome); the Totals `<dl>` had no heading at all (SR-landmark gap). Move/add each into a `<CardHeader>` with a real `<h2 className="font-heading text-base font-medium leading-snug">` (matching `benefit-usage-card.tsx`). The meta-fields grid (issue/due/paid/receipt) stays headingless (it is a data grid). The Totals heading uses the new key `portal.invoices.detail.totals.heading`.
- **Acceptance:** all three detail cards render a real `<h2>` inside a `CardHeader`; meta grid untouched; `getByRole('heading', { level: 2 })` resolves for each.

### Task 2 — page-header action buttons → 36px (`ux-standards.md` § 19) — `- [x]` DONE (`6a0bccb3`)
Page-header action rows use `h-9` (36px) per § 19 ("Pay / Issue / Void / Download"). The detail page used `size:'sm'`+`min-h-11` (44px). Change Download invoice, Download receipt, receipt-preparing pseudo-button, Resend (via an **additive** `size` prop so the list row is unchanged), and PayNowButton to `size:'default'` (h-9). Leave the bottom back-to-list nav link + per-row "View" credit-note link (denser/nav zones). 36px ≥ 24px → still WCAG 2.5.8 AA.
- **Acceptance:** the five page-header buttons are `h-9`; no `min-h-11` remains on them; the list table-row resend renders identically (default `'sm'`).

### Task 3 — void-reason `break-words` — `- [x]` DONE (`6a0bccb3`)
`<dd className="whitespace-pre-wrap">{invoice.voidReason}</dd>` → add `break-words` so a long unbroken admin reason can't overflow on narrow viewports.

### Task 4 — loading skeleton mirrors the new shape (CLS-0) + i18n parity — `- [x]` DONE (`6a0bccb3`)
Update `[invoiceId]/loading.tsx` so the lines + totals skeleton cards carry their title skeleton **inside** `CardHeader` and the header action skeleton is `h-9`. Add `totals.heading` to all three locales; `pnpm check:i18n` green (parity) + code-ref grep (every touched `t()` resolves in en.json).
- **Acceptance:** skeleton card shape matches the real cards (no shimmer→content shift); `check:i18n` OK; `check:layout` OK.

### Task 5 — invoice-download button label parallelism — `- [x]` DONE
The invoice-PDF download button rendered `portal.invoices.actions.download` = **"PDF"** while the receipt button beside it rendered `downloadReceipt` = **"Receipt"** — a format-vs-document-type mismatch (both download a PDF; only the document type distinguishes them). Audit confirmed every consumer of `portal.invoices.actions.download` is an invoice-download button (list, detail, dashboard summary-card; renewal-success uses aria-only; credit-notes uses its own `portal.creditNotes` namespace), so the value is safe to change. Relabel to the document type, matching the existing `downloadCombined` ("Tax Invoice / Receipt") terminology:
- EN "PDF" → **"Invoice"** (pairs with "Receipt")
- TH "PDF" → **"ใบกำกับภาษี"** (pairs with "ใบเสร็จ")
- SV "PDF" → **"Faktura"** (pairs with "Kvitto")
- **Acceptance:** the two download buttons read as a parallel "Invoice" / "Receipt" pair in all three locales; `check:i18n` OK; no other consumer regressed (aria labels unchanged).

---

## Deferred / follow-up (NOT in D3)

- **Mobile table card-view (list page):** the 7-column list table relies on a horizontal-scroll shadow cue; a true mobile card/stacked-row variant is a larger refactor than a polish pass — track as a separate D-series follow-up, not D3.
- **Void-after-paid receipt-number display:** showing the receipt number on an invoice voided *after* payment touches Thai-tax document semantics (RD § 105ทวิ) — route through a `thai-tax-compliance-auditor` review before changing field visibility; out of scope for a chrome/layout polish pass.
- **Dedicated invoices-i18n render lock test:** `check:i18n` (parity) + the code-ref grep cover the new key; a full detail-page render-sentinel test (like `account-hub.test.tsx`) is heavy (many F4/F5 deps) — optional follow-up.

---

## Acceptance criteria (D3 gate)

- [x] Detail cards: lines + credit-notes + totals titles are real `<h2>` inside `CardHeader` (matches D1/D2 + `benefit-usage-card.tsx`); meta grid untouched.
- [x] Detail page-header action buttons at 36px (`h-9`) per `ux-standards.md` § 19; list table-row buttons unchanged.
- [x] `totals.heading` present in EN/TH/SV (TH/SV reviewed for naturalness + corpus consistency); `pnpm check:i18n` OK.
- [x] `[invoiceId]/loading.tsx` mirrors the new shape (CLS = 0); `pnpm check:layout` OK.
- [x] `pnpm typecheck` (excl. `.next`) + `pnpm lint` clean; existing portal/payment unit tests green (258).
- [x] No list-page, tax-field-visibility, or noise-file changes; commit scoped to the 7 intended files.
- [x] Implemented via subagent-driven-development + two-stage review (spec-compliance: COMPLIANT; i18n-translation: ship).

**Status:** SHIPPED on `059-member-portal-d3` (`6a0bccb3`); reviewed clean. Deferred items tracked above.
