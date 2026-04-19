---
name: F4 Invoicing UI Patterns & Known Gaps
description: Key UX/a11y/i18n patterns found during F4 (007-invoices-receipts) review — useful for future F4 reviews or related features
type: project
---

F4 Invoicing MVP (US1+US2) shipped with strong foundational patterns but several targeted gaps.

**Why:** First full review of the invoicing surface on branch 007-invoices-receipts (2026-04-19).

**How to apply:** When reviewing F4 follow-on work (US3 portal, US4 settings, US6 credit notes, US7 timeline integration), verify these gaps are addressed in scope.

## Known Gaps (as of 2026-04-19)

1. **US4 invoice-settings page (admin/invoice-settings) does NOT EXIST yet** — T091–T097 all unchecked. No UI for `tenant_invoice_settings` CRUD. The only settings are seeded via `seed-f4-invoice-settings.ts` script. This is by design (US4 = P2, not in MVP slice), but the R3-P2 empty-state guard (redirect to settings if no row) is also not implemented.

2. **`/portal/invoices` (US3) does NOT EXIST yet** — no portal route files. US3 is P2, not in MVP slice.

3. **`detail/loading.tsx` uses `grid-cols-2` (no `grid-cols-1` base)** — detail skeleton DL grid at line 26 has no mobile-first single column, causing potential layout squeeze at 320px.

4. **Download PDF links lack invoice-specific `aria-label`** — both `invoice-table.tsx` and detail `page.tsx` use generic "Download PDF" text. Screen readers cannot distinguish which invoice is being downloaded when multiple rows are visible.

5. **`issueDate` and `dueDate` rendered as raw ISO string** on detail page (lines 278/282) — not locale-formatted. `paidAt` and `voidedAt` use `formatDate()` with locale. Inconsistent.

6. **Back link in `new/page.tsx` uses literal `←` Unicode arrow** (line 89) instead of `<ArrowLeftIcon aria-hidden="true" />` from lucide-react. Inconsistent with F3 pattern (members/new, members/[id]/edit all use ArrowLeftIcon).

7. **Status badges are color-only differentiators** — no icon or shape variation between statuses. Fine for most WCAG AA interpretations but `overdue` (red) vs `issued` (grey) relies on color alone for urgency distinction. Low-severity in practice because the text label is always visible.

## Confirmed Strengths

- `SkipToContent` is in root `app/layout.tsx`, `<main id="main-content">` in admin layout — FR-042 landmark structure is sound.
- `motion-reduce:duration-0` applied to `alert-dialog.tsx` overlay and content — reduced-motion respected.
- i18n coverage: 117 EN keys × 3 locales, 0 missing in TH/SV.
- `prefers-reduced-motion` handled at the CSS-variable level via `--modal-duration`.
- Typed-phrase confirm uses `toLocaleUpperCase(locale)` — locale-aware, not hardcoded `toUpperCase()`.
- Shimmer skeletons: all 3 loading.tsx files use correct container + Skeleton primitives.
- `aria-describedby` + `aria-invalid` + `role="alert"` pattern on issue confirm input — correct.
- `AlertDialog` (Base UI) provides `role="alertdialog"`, focus-trap, Esc-to-close, `aria-modal` natively.
- `SearchableCombobox` popover uses `w-[var(--anchor-width)]` to prevent mobile overflow.
