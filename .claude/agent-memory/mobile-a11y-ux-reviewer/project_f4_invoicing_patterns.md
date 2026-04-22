---
name: F4 Invoicing UI Patterns & A11y Findings (post-Phase-10 final code audit)
description: Key UX/a11y/i18n patterns found during F4 (007-invoices-receipts) reviews — updated per final code-level sign-off audit 2026-04-22
type: project
---

F4 Invoicing UI patterns accumulated across three reviews (2026-04-19 MVP, 2026-04-21 Phase 10, 2026-04-22 final code-gate sign-off).

**Why:** Ongoing F4 review on branch 007-invoices-receipts.

**How to apply:** When reviewing further F4 follow-on work or related features, verify these patterns and gaps.

## Final Code-Gate Audit Findings (2026-04-22) — all non-blocking

1. **`src/app/(staff)/admin/invoices/[invoiceId]/page.tsx:617`** — `<section className="mt-6">` (invoice lines) missing `aria-labelledby`. Fix: add `id="invoice-lines-heading"` to the h3 and `aria-labelledby="invoice-lines-heading"` to section. Consistent with the 3 sibling sections above it.

2. **`src/app/(member)/portal/invoices/[invoiceId]/page.tsx:327-330`** — TH description string missing `lang="th"` when rendered as secondary language. Fix: wrap in `<span lang="th">`. Admin detail already does this (`[invoiceId]/page.tsx:653`).

3. **`src/components/invoices/invoice-settings-form.tsx:553`** — Submit button missing `aria-busy={submitting}`. Every other async submit button in the codebase has it. Fix: add `aria-busy={submitting}` to the `<Button type="submit">`.

4. **`src/app/(staff)/admin/members/[memberId]/_components/member-invoices-section.tsx:370-430`** — Table row action buttons use `size="sm"` (h-7 = 28px), no `min-h-11` override. On the dense admin-only member detail table this is within the design system's WCAG 2.2 SC 2.5.8 opportunistic floor (24px), but falls below WCAG 2.5.5 AAA (44px). Non-blocker: surface is admin-only (desktop-primary). Note for future mobile hardening pass.

## Known Gaps / Open Issues (as of 2026-04-21 Phase 10 review — carried forward)

1. **`{documentType}` interpolation anti-pattern in `admin.invoices.detail.actions.resendAria`** — The EN template uses `{documentType: 'invoice'}` / `{documentType: 'receipt'}` hardcoded strings that embed raw English into TH/SV aria-labels (WCAG SC 3.1.2 blocker). Fix: split into `resendInvoiceAria` + `resendReceiptAria` keys per locale. See invoice-more-menu.tsx lines 170–188.

2. **Admin invoice `loading.tsx` missing `PageSkeletonShell`** — `/admin/invoices/[invoiceId]/loading.tsx` does not wrap in `PageSkeletonShell`, so no `role="status" aria-live="polite"` is emitted. Credit-note loading (admin + portal) correctly uses `PageSkeletonShell`. Pattern: ALL detail loading.tsx files should use `PageSkeletonShell` unless the parent segment already provides a live region.

3. **Portal CN detail download link missing `aria-label`** — `/portal/credit-notes/[creditNoteId]/page.tsx` action uses generic "Download PDF" text without document number in the label. Admin surfaces already have `pdfAria` keys — add `portal.creditNotes.detail.actions.downloadAria` to match.

4. **Portal invoice detail shows `paidAt` field unconditionally** — `fields.paidDate` renders "Paid: —" for non-paid invoices (issued, overdue). Should be conditional on `invoice.paidAt` truthy. (page.tsx:276–280)

5. **`recentlySent` disabled state not explained to AT users** — More-menu resend items are `disabled` after send but provide no `aria-description` explaining why or when re-enabled. Suggestion-level, not blocker.

## Resolved Gaps (from 2026-04-19 first review)

- `detail/loading.tsx` mobile-first grid — Fixed: admin invoice loading uses `grid-cols-1 … sm:grid-cols-2` correctly.
- Status badges color-only — Fixed for `overdue`: T109 now uses icon (`AlertTriangle`) + text badge on portal invoice detail (`STATUS_ICON_MAP`). Admin detail uses `Badge` with `statusBadgeVariant('overdue')` → destructive which still relies on color + text label (acceptable AA).
- Download PDF links `aria-label` (admin) — Fixed: invoice-more-menu download uses `<a download>` inside `DropdownMenuItem`; credit note section in admin has `pdfAria` key.
- `issueDate`/`dueDate` ISO string rendering — Fixed: both use `formatDate(…, userLocale)` in Phase 10.
- US4 invoice-settings page — Shipped (T091–T097 complete per Phase 10 status).
- `/portal/invoices` (US3) — Shipped.

## Confirmed Strengths (Phase 10)

- i18n parity 100%: ALL EN keys present in TH + SV. `pnpm check:i18n` clean.
- `PageSkeletonShell` pattern: `role="status" aria-live="polite" aria-busy="true"` correct in CN loading files.
- Reduced-motion: `globals.css:335–379` covers shimmer (pulse fallback) + `animate-spin` neutralise globally.
- `SkeletonBlock` uses `.skeleton-shimmer` CSS utility (no inline `animate-pulse` Tailwind class) — single source of truth.
- Semantic HTML on skeletons: `<div role="presentation" aria-hidden="true">` correctly replaces `<dl>` in invoice loading (axe fix verified).
- Touch targets: `ResendInvoiceButton` uses `min-h-11` (44px); `size="icon-lg"` trigger is 36px per ux-standards § 19.
- More-menu pattern (ux-standards § 19): `flex-none!` on trigger prevents PageHeader mobile `[&>*]:flex-1` stretch.
- `PageHeader` mobile stacking: `flex flex-col items-stretch` base, `[&>*]:flex-1` on actions div → full-width tap targets on mobile, reverts to `flex-none` at `sm:`.
- `lang="th"` on Thai description cells in invoice lines table — correct SC 3.1.2 scoping.
- Logical CSS properties in `page-header.tsx` (`margin-block-start`) — RTL forward-compat.
- Theming: all F4 surfaces use semantic CSS variables only; no hardcoded colors.
- Keyboard: Radix DropdownMenu handles Arrow/Esc/Tab natively; focus returns to trigger on close.
