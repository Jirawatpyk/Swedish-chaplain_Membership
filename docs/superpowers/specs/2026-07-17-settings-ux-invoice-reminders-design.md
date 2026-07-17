# Settings UX Overhaul — Invoice Settings & Reminder Schedules

- **Date:** 2026-07-17
- **Status:** Approved (design) — pending implementation plan
- **Surfaces:** `/admin/settings/invoicing`, `/admin/settings/renewals/schedules`
- **Author:** brainstorming session (visual companion)

## 1. Context & Problem

Two admin settings screens have grown information-dense and hard to use.

**Invoice Settings** (`src/components/invoices/invoice-settings-form.tsx`, 1061 lines) is a
single flat `<form>` with **10 stacked `<fieldset>` blocks / ~40 fields** inside a 42rem
`FormContainer`. One Save button lives at the very bottom. The admin scrolls a long wall of
fields with no way to jump to a section and no overview of what is set.

**Reminder Schedules** (`src/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor.tsx`)
exposes raw wire fields on every step card: `step_id`, `offset_days`, and `template_id`
(e.g. `renewal.t-30`). These three fields are semantically coupled — the dispatch gateway
**derives the copy offset from `step_id` and the copy tier from `template_id`**, while
`offset_days` independently drives *when* the reminder fires (see
`resend-transactional-renewal-gateway.tsx` `deriveOffsetFromStepId` / `deriveTierFromTemplateId`).
A mismatch (fire at −30 days but copy says "14 days") is easy to create and invisible until an
email goes out. There is also no visual overview of when reminders fire across a tier.

## 2. Goals / Non-Goals

**Goals** (all four confirmed by the user):
1. Easier navigation / finding a setting.
2. Less visual clutter.
3. Fields that a non-engineer can understand.
4. A more modern, enterprise look.

**Non-Goals / explicit constraints:**
- **No changes to API routes, DB schema, migrations, save logic, or wire payload shapes.**
  The PATCH `/api/tenant-invoice-settings` body and the PUT
  `/api/admin/renewals/settings/schedules/[tierBucket]` body stay byte-identical. This keeps
  the tax-compliance surface (§86/4, §87 numbering) and all contract/integration tests intact.
- No live invoice-PDF preview on the settings page (out of scope — YAGNI).
- No new npm dependencies (Constitution X).

## 3. Design Decisions (chosen options + rationale)

| # | Decision | Chosen | Rationale |
|---|----------|--------|-----------|
| D1 | Invoice Settings layout | **Sticky section-nav + single form, single save** | Best for "find fast" while preserving one form / one save — matches enterprise settings patterns (Stripe/GitHub). |
| D2 | Reminder technical fields | **Auto-generate `step_id`/`template_id`, hidden by default, "Advanced" escape hatch** | Eliminates the 3-field-mismatch footgun without touching the API/DB — the UI just composes the same strings from `(tier, offset_days)`. |
| D3 | Invoice form file | **Split the 1061-line form into per-section sub-components** | Maintainability + Clean Architecture; each section becomes independently testable. |

## 4. Detailed Design — Invoice Settings

### 4.1 Layout
- **Desktop (≥ md):** two-column. Left = sticky section nav (~200px, `position: sticky`,
  `top` below the page header). Right = the form. New page container widens from `FormContainer`
  (42rem) to ~60rem to fit the rail + form comfortably.
- **Mobile (< md):** the rail collapses to a compact **"Jump to section…" control** at the top
  (a native-feeling select or a horizontally scrollable chip row). The form is full-width.
- Clicking a nav item smooth-scrolls to that section. A **scroll-spy** hook highlights the
  section currently in view (`aria-current="true"` on the active nav item).

### 4.2 Section grouping (10 fieldsets → 6 sections)

| Section | Fields folded in |
|---|---|
| 1. Organization | currency_code, legal_name_th/en, brand_name, tax_id, registered_address_th/en |
| 2. Tax & VAT | vat_percent, registration_fee, seller_is_head_office + seller_branch_code (§86/4) |
| 3. Numbering & fiscal year | invoice/credit-note/receipt prefixes, receipt_mode (read-only), fiscal_year_start_month, default_net_days, pro_rate_policy |
| 4. Document notes | wht_note_th/en, termination_notice_th/en, auto_email_enabled |
| 5. Payment (bank transfer) | full bank block (payee, name, account no/type, branch, SWIFT, address) + payment_instructions_th/en |
| 6. Branding | logo upload |

Each section keeps its existing `<fieldset>`/`<legend>` semantics, hint text, char counters,
and validation. Only the grouping and ordering change.

### 4.3 Sticky save bar
- A footer bar that appears only when the form is **dirty** (any field differs from
  `initialValues`): shows "You have unsaved changes" + the Save button. Removes the need to
  scroll to the bottom. On a clean form it is hidden.
- The existing **prefix-change confirmation dialog** (§87 numbering-stream warning) and
  **manager read-only** behaviour are preserved verbatim.

### 4.4 Component split
`InvoiceSettingsForm` becomes an orchestrator holding form state + submit logic. Each of the 6
sections extracts to a presentational sub-component under
`src/components/invoices/invoice-settings/` (e.g. `organization-section.tsx`,
`tax-vat-section.tsx`, …), receiving its slice of state + setters + `disabled`. The submit
handler, dirty-tracking, prefix-change dialog, and PATCH call stay in the parent. Section ids
(anchors) are the contract between the nav and the sections.

## 5. Detailed Design — Reminder Schedules

### 5.1 Timeline strip (headline feature)
- Rendered at the top of each tier tab, above the step list. A horizontal axis with a red
  **"Due date"** marker and one pin per step positioned by `offset_days` (blue = email,
  amber = task). Read-only overview; stays in sync with the editable cards below.
- **Accessibility:** the timeline is decorative-plus-informative — it carries a text
  alternative (visually-hidden list of "N days before/after · channel") so screen-reader users
  get the same overview. Pins are not the only way to read the schedule.

### 5.2 Friendly step card
- Card header: a plain-language sentence — "📧 Email · 30 days before expiry".
- **Channel** becomes a segmented control (Email / Task) with icons, implemented as an
  accessible `radiogroup`.
- **Timing** becomes a "[N] days [before/after] the due date" control (a number stepper + a
  before/after toggle) instead of a raw signed integer. It maps 1:1 to `offset_days`
  (before = negative, after = positive).
- **Email preview:** for email steps, show the resolved subject + first line for
  `(tier, offset)` using the existing copy matrix data. If the offset has no tier-specific copy
  entry, show a note: "will use the standard message." This makes the effect of a change
  visible before saving.

### 5.3 Auto-generated identifiers (the D2 mechanism)
- `step_id` and `template_id` are **not shown by default**. The UI composes them from the tab's
  tier and the step's `offset_days`, in the existing format `renewal.<offsetKey>.<tier>`, so the
  gateway's `deriveOffsetFromStepId` / `deriveTierFromTemplateId` keep resolving correctly and
  the persisted wire shape is unchanged.
  - `offsetKey` = the matching key from `RENEWAL_REMINDER_OFFSETS` (`t-120 … t+30`) when
    `offset_days` maps exactly; otherwise a `custom-<days>` token (the email then falls back to
    standard copy — surfaced by the 5.2 preview note).
  - **Uniqueness:** if two steps in a bucket would compose the same `step_id`, later ones get a
    numeric disambiguator suffix while keeping the offset token parseable.
- **Load behaviour (no surprise diffs):** existing stored `step_id`/`template_id` are preserved
  **verbatim** on load. Recomposition happens only when the admin edits timing/channel through
  the friendly controls, or explicitly clicks "reset to standard." So opening a policy and
  saving it unchanged does not rewrite identifiers.
- **Advanced disclosure:** a collapsible "Advanced" panel per card exposes the raw `step_id` /
  `template_id` (and, for task steps, `task_type` / `assignee_role` if not already surfaced) for
  power users. Editing there overrides the auto-composed values.

### 5.4 Preserved behaviour
Move up/down reorder, undo-on-remove (sonner 8s), per-tier Save with change-diff toast, manager
read-only banner, offline-fetch detection, and the wire contract all stay exactly as they are.

## 6. Shared Concerns

### 6.1 i18n
All new copy ships as keys in `src/i18n/messages/en.json` (canonical) + `th.json` + `sv.json`.
`pnpm check:i18n` must pass. No hardcoded strings (ux-standards § i18n).

### 6.2 Accessibility (WCAG 2.1 AA)
- Sticky nav is a `<nav>` with an accessible label; active item carries `aria-current`.
- "Jump to section" mobile control is a labelled native control.
- Timeline has the 5.1 text alternative.
- Segmented channel control is a proper `radiogroup` with labelled radios.
- Touch targets ≥ 44px; existing Switch `aria-label` SSR fixes retained.
- Reduced-motion: smooth-scroll and any count/transition respect `prefers-reduced-motion`.

### 6.3 Testing
- **No API/DB change** → existing contract + integration suites for both surfaces stay green
  (regression guard, not rewritten).
- New **unit tests** for the pure helpers: `offset_days ↔ (before/after, N)` mapping, the
  `(tier, offset_days) → step_id/template_id` composer + uniqueness/disambiguation, dirty-state
  detection, and scroll-spy active-section selection.
- **E2E**: navigate via the invoice section nav + save; edit a reminder step via the friendly
  controls and confirm the persisted payload is unchanged from the raw-field equivalent; axe
  scans on both pages.

## 7. Files Touched (indicative)

**Invoice Settings**
- `src/components/invoices/invoice-settings-form.tsx` — becomes orchestrator (state, submit,
  dirty tracking, prefix dialog).
- `src/components/invoices/invoice-settings/` — new per-section sub-components + a
  `section-nav.tsx` + a `useScrollSpy` hook + a `sticky-save-bar.tsx`.
- `src/app/(staff)/admin/settings/invoicing/page.tsx` — swap `FormContainer` for the new
  two-column container; pass section metadata.

**Reminder Schedules**
- `.../schedules/_components/schedule-editor.tsx` — becomes orchestrator.
- `.../_components/` — new `reminder-timeline.tsx`, `step-card.tsx` (friendly), an
  `email-preview.tsx`, an `advanced-fields.tsx`, and a pure `step-id-composer.ts` helper.

**Shared**
- `src/i18n/messages/{en,th,sv}.json` — new keys for both surfaces.

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Auto-composed identifiers silently change existing data | Preserve stored ids verbatim on load; recompose only on explicit timing/channel edit (§5.3). |
| Widening the container breaks `check:layout` container guard | Use an approved container wrapper; add/adjust the layout-check exemption if required, verified via `pnpm check:layout`. |
| Splitting the 1061-line form regresses submit/validation | Keep ALL logic in the orchestrator; sections are presentational only; unit + E2E on the save path. |
| Timeline math (pin positions) drifts from `offset_days` | Positions derived from a single pure function, unit-tested; cards + timeline read the same state. |

## 9. Open Questions

None blocking. Exact collision-suffix scheme for auto-composed `step_id` and the precise
mobile nav affordance (select vs. chip row) are implementation details to settle in the plan.
