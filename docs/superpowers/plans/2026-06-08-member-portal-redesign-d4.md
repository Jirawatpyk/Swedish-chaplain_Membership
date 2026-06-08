# Member Portal Redesign — D4 Implementation Plan (Mobile card-view for the invoices list)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task (fresh subagent per task + two-stage review). Steps use `- [ ]` checkboxes.

**Goal:** Make the member-portal **invoices LIST** (`/portal/invoices`) usable on a phone. Today it renders a 7-column `<Table>` with only a horizontal-scroll shadow cue — so at 320–767px the member must scroll sideways to reach the status, total, and action buttons. This **fails `docs/ux-standards.md` § 9 / § 15** ("every layout starts at 320px"; "No horizontal scrolling at any viewport ≥ 320px"; member portal is the mobile priority). D4 renders a **card list on mobile (<md)** and keeps the existing **table on desktop (≥md)** — presentation-only, reusing the existing row data, badge, formatters, and action-button components.

**Architecture:** D4 of the member-portal redesign series (D1 #72 · D2 #73 · D3 #74; D4 stacks on D3 → branch `060-member-portal-d4` off `059`). Dual-render via Tailwind breakpoints — NO new data fetch, NO backend, NO route change. The desktop `<Table>` stays exactly as-is (wrapped in `hidden md:block`); a new `<PortalInvoiceCardList>` server component renders `md:hidden`. The page already computes every row's `displayStatus` + the per-row action flags (`isCombinedPaid`, `showInvoice`, `showReceipt`, `receiptPending`) once — those are lifted into a small shared row-view-model so the table and the card list stay in lockstep (single source of truth, no parity drift).

**Tech Stack:** Next.js 16 App Router (RSC) · Tailwind v4 breakpoints (`md` = 768px) · shadcn `Card`/`Badge` · existing `PortalInvoiceDownloadButton` / `PortalReceiptDownloadButton` / `ResendInvoiceButton` (reuse) · existing `formatLocalisedDate` + `formatSatangThb` + `statusBadgeVariant` + `statusIconName` (`_utils/format.ts`) · next-intl EN/TH/SV · Vitest + Playwright (`@axe-core/playwright`). ≥44px tap targets (§ 9.1). Zero new npm deps.

---

## Card layout (mobile, <md) — one card per invoice

```
┌───────────────────────────────────────────┐
│ INV-2026-0001                  [✓ Paid]    │   doc# = link (left) · status badge (right)
│ Issued 1 Apr 2026 · Due 15 Apr 2026        │   dates, muted, single wrapping line
│ Receipt RCP-2026-0042                       │   only when separate-mode receipt# exists
│ ─────────────────────────────────────────  │
│ 50,000.00 THB                               │   total — prominent (text-base font-semibold)
│ [ Invoice ]  [ Receipt ]  [ Resend ]        │   actions, ≥44px, full-width-ish (flex-wrap)
└───────────────────────────────────────────┘
```

- **Header**: `<Link href=/portal/invoices/{id}>` wrapping a real `font-mono` doc-number (keeps the row→detail affordance + tab order) + the status `<Badge>` (icon + text — WCAG 1.4.1) right-aligned.
- **Dates**: `Issued … · Due …` muted, reusing `columns.issueDate`/`columns.dueDate` label keys as inline labels (need 2 short label keys OR reuse — see Task 1).
- **Receipt#**: shown only when `receiptDocumentNumberRaw` (separate-mode); combined-mode omits it. Mirrors the just-shipped D3 receipt-visibility logic.
- **Total**: prominent, `tabular-nums`, `formatSatangThb`.
- **Actions**: the SAME conditional set as the table's action cell (Invoice / Receipt / Resend / "Receipt preparing" / void-aware label), reusing the existing button components at ≥44px; `flex flex-wrap gap-2` so they wrap on a 320px phone, never overflow.
- The whole card carries `aria-label` (e.g. "Invoice INV-2026-0001, Paid") so a screen reader announces the card identity; the doc-number link + buttons keep their own names.

---

## File Structure

### Create
- `src/app/(member)/portal/invoices/_components/portal-invoice-card-list.tsx` — server component: takes the row view-models + renders the mobile card list (`md:hidden`). Reuses `Card`, `Badge`, the 3 action-button components, and the `_utils/format.ts` helpers. Real `<h3>`/`<Link>` per card + `aria-label`.
- `src/app/(member)/portal/invoices/_utils/invoice-row-view-model.ts` — pure helper that maps a raw invoice row → `{ documentNumber, displayStatus, receiptNumber, issueDate, dueDate, total, showInvoice, showReceipt, receiptPending, resendable, isCombinedPaid }`. Lifts the per-row logic currently inline in `page.tsx`'s table so BOTH the table and the card list consume one source of truth (no parity drift). Unit-tested.
- `tests/unit/portal/invoice-row-view-model.test.ts` — boundary tests for the row VM (combined-mode vs separate-mode; paid/issued/void/credited; overdue derivation; receipt-pending/rendered/failed).
- `tests/e2e/portal/invoices-mobile-cards.spec.ts` — `@a11y`: at 375×812 (and 320px) the page shows the card list with NO horizontal scroll; each card has the doc link + status badge + total + working actions; at ≥md the table shows + cards hidden; axe 0 violations at mobile.

### Modify
- `src/app/(member)/portal/invoices/page.tsx` — extract the inline per-row table logic into the row VM; wrap the existing `<Table>` block in `<div className="hidden md:block">`; render `<PortalInvoiceCardList rows={…} className="md:hidden" />` below it; share the filters + pagination + empty/not-linked/error states above BOTH (they already gate the whole list). The desktop table markup itself is otherwise unchanged.
- `src/app/(member)/portal/invoices/loading.tsx` — add a `md:hidden` mobile card skeleton (≈5 card placeholders matching the card height: doc line + badge + dates + total + an action-button row) alongside the existing `hidden md:block` 7-col table skeleton, so the shimmer→content swap is CLS-0 on BOTH form factors.
- `src/i18n/messages/{en,th,sv}.json` — only if the card needs new short label keys (`portal.invoices.card.issued` / `card.due`, or reuse existing `columns.*`). Prefer REUSE; add ≤2 keys × 3 locales only if no clean existing key fits.

### Out of scope
- The desktop `<Table>` structure/columns (unchanged).
- The admin invoices list (enterprise/desktop — `docs/ux-standards.md` § 9: "Enterprise admin screens typically render at lg+").
- Sorting / client-side filtering / TanStack adoption (no current requirement — would be over-engineering; see Deferred).

---

## Tasks

### Task 1 — row view-model + i18n labels (red → green)
Extract the per-row table logic (`displayStatus`, `isCombinedPaid`, `showInvoice`, `showReceipt`, `receiptPending`, resendable) from `page.tsx` into a pure `invoice-row-view-model.ts`; unit-test the branches. Decide the date/receipt inline labels for the card — reuse `portal.invoices.columns.issueDate`/`columns.dueDate` if they read well as inline labels, else add `portal.invoices.card.{issued,due}` to EN/TH/SV. `pnpm check:i18n` green.
- **Acceptance:** VM unit tests cover combined/separate-mode + every status + overdue + receipt-pending; `page.tsx` table consumes the VM (no behavior change to the desktop table — existing tests stay green).

### Task 2 — `PortalInvoiceCardList` component (red → green)
Build the mobile card list per the layout above, reusing Badge + the 3 action buttons + format helpers. Real `<h3>` doc-link + status badge + dates + conditional receipt# + total + the conditional action set (incl. void-aware label + receipt-preparing live region) + per-card `aria-label`. ≥44px buttons, `flex-wrap` so 320px never overflows.
- **Acceptance:** renders a card per row; the action set + labels exactly match the table's per-row logic (both consume the VM); no horizontal overflow at 320px.

### Task 3 — wire dual-render into the page
Wrap the table in `hidden md:block`; render the card list `md:hidden`; keep filters/pagination/empty/error/not-linked above both. Confirm the empty + "no filter match" states render once (not duplicated per form factor).
- **Acceptance:** at <md only cards render, at ≥md only the table renders; filters + pagination work for both; empty/error states show once.

### Task 4 — mobile loading skeleton (CLS-0)
Add a `md:hidden` card-skeleton (≈5 cards matching card height) to `loading.tsx`; keep the `hidden md:block` table skeleton. 
- **Acceptance:** `pnpm check:layout` OK; shimmer→content swap shifts nothing on phone or desktop.

### Task 5 — e2e @a11y + verify
`tests/e2e/portal/invoices-mobile-cards.spec.ts`: at 375px (+320px) → card list visible, NO horizontal scroll, doc link + badge + total + actions present, axe 0 violations; at 1280px → table visible, cards hidden. (Local 320px noise per project memory is acceptable; authoritative run = preview.)
- **Acceptance:** spec passes on preview; unit + contract green; `check:i18n` + `check:layout` + typecheck + lint clean.

---

## Acceptance criteria (D4 gate)
- [ ] `/portal/invoices` renders at 320×568 with NO horizontal scroll (the § 15 criterion the list currently fails).
- [ ] Mobile (<md): one card per invoice — doc link, status badge (icon+text), issued/due dates, receipt# (separate-mode only), total, and the same conditional actions as the table, all ≥44px.
- [ ] Desktop (≥md): the existing 7-column table is byte-for-byte unchanged in behavior.
- [ ] Table + card list consume ONE row view-model (no parity drift); VM unit-tested.
- [ ] `loading.tsx` mirrors both form factors (CLS-0); `check:layout` OK.
- [ ] axe 0 violations at mobile; status badge keeps icon+text; cards have `aria-label`; doc link + buttons keep accessible names.
- [ ] EN/TH/SV parity (`check:i18n`); any new card label reviewed; typecheck + lint + existing tests green.
- [ ] Implemented via subagent-driven-development + two-stage review.

## Deferred / follow-up (NOT in D4)
- Same mobile treatment for the **admin** invoices list (enterprise/desktop priority — out of scope per § 9).
- Sorting / client-side filter / TanStack adoption for the invoice list (no current requirement).
- Extending the card-list pattern to other portal list surfaces (broadcasts, events) — separate follow-up once D4 proves the pattern.

**Status:** PLANNED on `060-member-portal-d4`. Approach = Option B (dual render, table desktop / cards mobile) per the 2026-06-08 list-surface audit.
