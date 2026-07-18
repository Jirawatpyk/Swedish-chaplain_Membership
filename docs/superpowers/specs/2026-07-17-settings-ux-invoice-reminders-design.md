# Settings UX Overhaul — Invoice Settings & Reminder Schedules

- **Date:** 2026-07-17
- **Status:** Approved (design, rev.2 — review corrections folded in) — pending implementation plan
- **Surfaces:** `/admin/settings/invoicing`, `/admin/settings/renewals/schedules`
- **Author:** brainstorming session (visual companion) + 3 review agents (UX/a11y, architecture, Thai-tax)

## 0. Review Corrections (rev.2)

Three read-only review agents audited rev.1 against live code. Their confirmed,
code-grounded findings are folded into the sections below. Headline correction:
**the rev.1 auto-compose identifier format was wrong and would have silently
stopped renewal emails** — see §5.3. Other material corrections: container width
(§4.1), sticky-save-bar must reuse the single submit path (§4.3), copy matrix must
stay out of the client bundle (§5.2), and several a11y/i18n specifics (§6).

## 1. Context & Problem

Two admin settings screens have grown information-dense and hard to use.

**Invoice Settings** (`src/components/invoices/invoice-settings-form.tsx`, 1061 lines) is a
single flat `<form>` with **10 stacked `<fieldset>` blocks / ~40 fields** inside a 42rem
`FormContainer`. One Save button lives at the very bottom. The admin scrolls a long wall of
fields with no way to jump to a section and no overview of what is set.

**Reminder Schedules** (`src/app/(staff)/admin/settings/renewals/schedules/_components/schedule-editor.tsx`)
exposes raw wire fields on every step card: `step_id`, `offset_days`, and `template_id`.
These fields are semantically coupled — the dispatch gateway **derives the copy offset from
`step_id` and the copy tier from `template_id`** (`resend-transactional-renewal-gateway.tsx`
`deriveOffsetFromStepId` / `deriveTierFromTemplateId`), while `offset_days` independently drives
*when* the reminder fires. A mismatch is easy to create and invisible until an email goes out
(or fails to). There is also no visual overview of when reminders fire across a tier.

## 2. Goals / Non-Goals

**Goals** (all four confirmed by the user):
1. Easier navigation / finding a setting.
2. Less visual clutter.
3. Fields that a non-engineer can understand.
4. A more modern, enterprise look.

**Non-Goals / explicit constraints:**
- **No changes to API routes, DB schema, migrations, save logic, or wire payload shapes.**
  The PATCH `/api/tenant-invoice-settings` body and the PUT
  `/api/admin/renewals/settings/schedules/[tierBucket]` body stay schema-identical.
  (Note: the reminder redesign *does* normalize identifier VALUES the admin edits — see §5.3/§5.4
  — but never the payload SHAPE.)
- No live invoice-PDF preview on the settings page (out of scope — YAGNI).
- No new npm dependencies (Constitution X).

## 3. Design Decisions

| # | Decision | Chosen | Rationale |
|---|----------|--------|-----------|
| D1 | Invoice Settings layout | **Sticky section-nav + single form, single save** | Best for "find fast" while preserving one form / one save — enterprise settings pattern. |
| D2 | Reminder technical fields | **Auto-generate `step_id`/`template_id`, hidden by default, "Advanced" escape hatch** | Eliminates the multi-field-mismatch footgun. The UI composes the SAME format the gateway parses (§5.3), so the persisted wire shape is unchanged. |
| D3 | Invoice form file | **Split the 1061-line form into per-section sub-components** | Maintainability + testability; logic stays in the orchestrator (§4.4). |

## 4. Detailed Design — Invoice Settings

### 4.1 Layout & container
- **Desktop (≥ md):** two-column. Left = sticky section nav (~200px, `position: sticky`).
  Right = the form. The page uses **`DetailContainer` (72rem)** — NOT a new 60rem width.
  `pnpm check:layout` requires every `page.tsx` to import exactly one approved container
  (`FormContainer` 42rem / `DetailContainer` 72rem / `TableContainer` 96rem) and requires the
  page and its sibling `loading.tsx` to use the **same** one. 72rem fits rail (~200px) + form
  (~42rem) + gap. Do **not** use a raw `max-w-[60rem]` div or override `max-w` via className.
- **Mobile (< md):** the rail collapses to a compact **"Jump to section…" labelled control** at
  the top. The form is full-width.
- Clicking a nav item smooth-scrolls to that section. A **scroll-spy** hook highlights the
  section in view with `aria-current="location"` (matching the project's member-nav). The nav is
  **not** an `aria-live` region (an `aria-current` flip during scroll must not be announced).
  Nav-click **moves focus** to the target section heading (`tabindex={-1}` + `focus()`) so
  keyboard/SR users land in the content, not stranded on the link.
- Scroll-spy must handle a short **last section** (which may never reach the top of the viewport)
  via the IntersectionObserver root-margin / "nearest to top" fallback.

### 4.2 Section grouping (10 fieldsets → 6 sections)

| Section | Fields folded in |
|---|---|
| 1. Organization | currency_code, legal_name_th/en, brand_name, tax_id, registered_address_th/en, **seller_is_head_office + seller_branch_code** |
| 2. Tax & VAT | vat_percent, registration_fee |
| 3. Numbering & fiscal year | invoice/credit-note/receipt prefixes, receipt_mode (read-only), fiscal_year_start_month, default_net_days, pro_rate_policy |
| 4. Document notes | wht_note_th/en, termination_notice_th/en, auto_email_enabled |
| 5. Payment (bank transfer) | full bank block (payee, name, account no/type, branch, SWIFT, address) + payment_instructions_th/en |
| 6. Branding | logo upload |

**Change from rev.1 (Thai-tax review):** the §86/4 seller head-office/branch pair moves into
**Organization** so the seller-identity block (legal name, tax_id, address, head-office/branch)
stays coherent — these render together as the seller block on the tax document. The
`seller_is_head_office` toggle + its conditional `seller_branch_code` input + `BRANCH_CODE_RE`
guard MUST live in the **same** sub-component (never split). A hint notes that the toggle controls
how the seller block prints. Each section keeps its existing hint text, char counters, and
field-level validation; only grouping/ordering change.

### 4.3 Sticky save bar (single submit path — MANDATORY)
- A footer bar appears only when the form is **dirty** (any field differs from `initialValues`,
  compared across **every** key). It shows an accessible, announce-once "You have unsaved changes"
  region + the Save button.
- **The sticky Save button MUST call `form.requestSubmit()`** so submission always flows through
  the existing single `handleSubmit`. That handler is where every tax guard lives; bypassing it
  would let a non-compliant config save. **Regression checklist — these 6 submit-handler guards
  MUST still fire from the sticky Save path:**
  1. prefix-change confirmation dialog (§87 numbering-stream restart)
  2. `'RE'` reserved receipt-prefix guard
  3. seller branch-pairing (`!sellerIsHeadOffice && !BRANCH_CODE_RE` → block)
  4. VAT range 0–30
  5. SWIFT / bank-account-no regex
  6. currency `^[A-Z]{3}$`
- Validation errors currently render as one `<p>` at the form bottom and do **not** toast. With a
  two-column layout + bottom bar, that error can scroll off-screen above the Save action. So on a
  blocked submit: surface the error **at the save action** and **scroll-to + focus the first
  invalid field**.
- **Keep a reachable Save affordance even if dirty-detection has a gap** (do not remove the ability
  to save). Mobile: the fixed bar uses `env(safe-area-inset-bottom)`, sits in a sensible tab order,
  and must not obscure the field being edited (WCAG 2.4.11 Focus Not Obscured — already adopted
  since F3).
- **Navigate-away guard:** when dirty, warn on `beforeunload` and on Next.js route change.
- The existing **prefix-change confirmation dialog** and **manager read-only** behaviour are
  preserved verbatim.

### 4.4 Component split
`InvoiceSettingsForm` becomes an orchestrator that owns ALL form state, dirty-tracking, the submit
handler, prefix-change dialog, and the PATCH call. Each of the 6 sections extracts to a
**controlled, presentational** sub-component under `src/components/invoices/invoice-settings/`,
receiving its state slice + setters + `disabled`. **Hard rule:** sections MUST NOT hold their own
copy of tax-field state and MUST NOT be conditionally unmounted — because the PATCH sends the full
body, an unmounted section reverting to defaults would overwrite `tax_id`/`legal_name`/`address`/
`branch`/VAT with empty values. Section ids (anchors) are the nav↔section contract. These files
live under `src/components/**` (not `src/modules/**`), so they are outside the module-barrel
ESLint rule; keep imports to UI primitives + `next-intl` only (no infra/domain).

## 5. Detailed Design — Reminder Schedules

### 5.1 Timeline strip (headline feature)
- Rendered at the top of each tier tab. A horizontal axis with a red **"Due date"** marker and one
  pin per step positioned by `offset_days` (blue = email, amber = task).
- **Base UI `Tabs.Panel` keeps all 5 inactive panels mounted via `hidden`** (see the `idPrefix`
  comment in `schedule-editor.tsx`). So the timeline + its text-alternative exist **5× in the
  DOM** — every id/anchor inside the timeline MUST be prefixed with `tierBucket` (same pattern as
  the step fields) to avoid duplicate-id (WCAG 4.1.1).
- **A11y:** the timeline carries a visually-hidden text alternative (an ordered list of "N days
  before/after · channel") so it is not the only way to read the schedule.
- **Empty case:** a tier with zero steps renders the due-date marker only (no pins).
- Channel is shown with **lucide icons** (`Mail` / `ListTodo`), `aria-hidden`, alongside text —
  **no emoji** (ux-standards § icon rule: lucide only).

### 5.2 Friendly step card + email preview
- Card header: a plain-language sentence built from the existing localized ICU keys
  (`stepCard.offsetDay.before` / `.after` / `.exact`, already used by `formatOffset`) — e.g.
  "Email · 30 days before the due date". **Do not concatenate the sentence from DOM fragments**
  (TH/SV word order differs from EN); render it as one ICU display string with plural rules
  (EN/SV pluralize "day/days"; TH does not).
- **Channel** = an accessible segmented control (Email / Task) implemented on Base UI `RadioGroup`
  (roving tabindex, arrows/Home/End, single tab-stop, Space no double-toggle). The **visible**
  selected segment's focus indicator MUST be full-opacity `ring-ring` / `border-ring` — **never**
  `ring-ring/50` (that is ~2.24:1 on white → fails SC 1.4.11/2.4.7). Segment + stepper ± buttons
  are ≥44px on mobile.
- **Timing** = "[N] days [before/after] the due date": a number stepper (≥44px controls) + a
  **separately-labelled** before/after control. Maps 1:1 to `offset_days` (before = negative).
  The before/after control has its own label; the summary sentence is the ICU display string above.
- **Email preview:** for email steps, show the resolved subject + first line for `(tier, offset)`.
  The offset picker is **constrained to the tier's known offsets** (the offsets that actually have
  copy in the matrix for that tier) so every email step is deliverable and previewable. See §5.3
  for why arbitrary offsets are unsafe. Preview data must come through a **client-safe source**
  (§5.5), and must guard against `resolveCopy` throwing when EN copy is absent.

### 5.3 Auto-generated identifiers (the D2 mechanism) — CORRECTED FORMAT
`step_id` and `template_id` are hidden by default; the UI composes them from `(tier, offset,
channel)`. **The two fields use DIFFERENT formats** (this is the rev.1 blocking bug — verified
against `tests/integration/helpers/seed-renewal-policies.ts` + the gateway parsers):

- **`step_id`** — offset token **FIRST** (no `renewal.` prefix), then channel, then (for tasks)
  the task type:
  - email: `` `${offsetKey}.email` `` → e.g. `t-30.email`
  - task:  `` `${offsetKey}.task.${taskType}` `` → e.g. `t-60.task.phone_call`
  - `deriveOffsetFromStepId` does `stepId.slice(0, firstDot)` and checks membership in
    `RENEWAL_REMINDER_OFFSETS`, so the offset token MUST be the first segment.
- **`template_id`** — `` `renewal.${offsetKey}.${tierBucket}` `` (tier **LAST**, underscore form
  straight from the tab, e.g. `renewal.t-30.thai_alumni`). `deriveTierFromTemplateId` matches via
  `endsWith('.'+tier)`.
- **`offsetKey`** is computed arithmetically — `` `t${days < 0 ? '-' : '+'}${Math.abs(days)}` `` —
  then **membership-checked** against `RENEWAL_REMINDER_OFFSETS`. The friendly picker only offers
  in-set offsets, so a composed key is always valid.
- **Natural key = `(offset, channel[, taskType])`, NOT `(offset)`** — two steps can share an
  offset with different channels (seed: premium has `t-60.email` + `t-60.task.phone_call`). A
  collision disambiguator, if ever needed, is appended at the **end** (`t-30.email.2`) so the
  leading offset token stays parseable.
- **Arbitrary / out-of-set offsets do NOT fall back to "standard copy" — they are NOT sent at
  all** (`deriveOffsetFromStepId` returns `null` → gateway errors `template_variables_missing`).
  So: the default friendly picker forbids them; an Advanced-only arbitrary offset shows a hard
  warning "no copy for this offset — this email will not be sent." Task steps are unaffected
  (they don't go through the email path).
- **Load behaviour (no surprise diffs):** existing stored `step_id`/`template_id` are preserved
  **verbatim** on load. Recomposition happens only when the admin edits timing/channel via the
  friendly controls, or clicks "reset to standard."
- **Advanced disclosure:** a collapsible per-card panel exposes raw `step_id` / `template_id`;
  for task steps, `task_type` becomes a friendly **Select** of the known task types (seed uses
  `phone_call`, `admin_notify`), with the raw value editable under Advanced. `assignee_role`
  stays the existing Select.
- **Latent bug fixed in passing:** today's `emptyStep()` default `template_id: 'renewal.t-30'`
  has no tier suffix → `deriveTierFromTemplateId` returns null → newly-added email steps already
  can't send. The composer fixes this. (This is why the E2E oracle is "dispatch-resolvable", not
  "byte-identical to the current raw default" — see §6.3.)
- **Due-track guard:** the composer/recompose must never touch positive-offset due-track steps
  (`due+7.email` / `due+30.email`) — these are a separate track and do not appear in the 5 editable
  tier policies today; guard against them if they ever do.

### 5.4 Behaviour that changes vs. stays
**Stays exactly:** move up/down reorder, undo-on-remove (sonner 8s), per-tier Save, manager
read-only banner, offline-fetch detection, and the wire **shape**.
**Changes (documented, intended):** editing a step's timing/channel recomposes its `step_id`, so
the per-tier Save **change-diff** (`computeStepDiff` compares the step_id set) reports that step as
remove+add rather than "unchanged", and the reminder-event idempotency key
`(cycle, stepId, yearInCycle)` changes (a retimed step may fire again in-cycle). This is acceptable
and correct — but it is a behaviour change, so §5.4 does not claim "identical."

### 5.5 Module boundaries for preview/composer
`RENEWAL_REMINDER_OFFSETS` and any preview data live in **infrastructure**
(`.../email/templates/copy.ts`). The client editor MUST NOT deep-import that file (Turbopack
barrel-walking can drag server-only code into the client bundle, and the 30+ × 3-locale copy
matrix risks `check:bundle-budgets`). Expose the offset set (and, if needed, a small preview
resolver) through the existing **`@/modules/renewals/client`** client-safe barrel or a domain
constant; the composer builds tokens arithmetically. If a full 3-locale preview is required,
resolve it via a server action / API rather than bundling the matrix.

## 6. Shared Concerns

### 6.1 i18n
All new copy ships as keys in `src/i18n/messages/en.json` (canonical) + `th.json` + `sv.json`.
`pnpm check:i18n` must pass. Reuse existing `stepCard.offsetDay.*` ICU keys for the timing
sentence; no hardcoded strings; plural rules per §5.2.

### 6.2 Accessibility (WCAG 2.1 AA)
- Sticky nav: `<nav>` with a label; active item `aria-current="location"`; not `aria-live`;
  nav-click moves focus to the section heading (§4.1).
- "Jump to section" mobile control is a labelled native control.
- Timeline: `tierBucket`-prefixed ids + text alternative (§5.1).
- Segmented channel control: Base UI `RadioGroup` semantics; visible focus = full-opacity
  `ring-ring`/`border-ring` (§5.2).
- Touch targets ≥ 44px (segment, stepper ±, nav items); existing Switch SSR `aria-label` retained.
- Sticky save bar: labelled announce-once region, safe-area, no focus obscuring (§4.3).
- Reduced-motion: smooth-scroll, segmented-control thumb slide, and save-bar slide-in all respect
  `prefers-reduced-motion`.

### 6.3 Testing
- **No API/DB/wire-shape change** → existing contract + integration suites for both surfaces stay
  green (regression guard).
- **New CONTRACT test (blocking gate, Principle II):** feed the composer's output through the real
  `deriveOffsetFromStepId(step_id)` and `deriveTierFromTemplateId(template_id)` and assert both are
  **non-null** and equal the intended `(offset, tier)`. This binds the composer to the gateway
  parsers so they cannot drift. (A format-only unit test is insufficient — both sides can drift
  independently.)
- **New unit tests:** `offset_days ↔ (before/after, N)` mapping; the `(tier, offset, channel) →
  step_id/template_id` composer incl. natural-key/disambiguation + arithmetic offsetKey +
  membership check; dirty-state detection across all keys; scroll-spy active-section (incl. short
  last section); timing-sentence ICU/plural.
- **E2E:**
  - Invoice: navigate via section nav; edit a field and Save **from the sticky bar** and confirm
    the full-body PATCH is correct; trigger a prefix change and confirm the §87 dialog still fires
    from the sticky Save; confirm the full-body payload is invariant across section scroll (tax
    fields not overwritten).
  - Reminder: edit a step via the friendly controls; oracle = the persisted `step_id`/`template_id`
    are **dispatch-resolvable** (pass the gateway parsers), not "identical to the raw default".
  - axe scans on both pages; add `loading.tsx` skeletons and assert no CLS.

### 6.4 Loading states
Both pages get a `loading.tsx` (currently `invoicing/loading.tsx` exists; verify it matches the new
two-column layout). Skeletons must match the new layouts (invoice: rail + form; reminder: due-date
axis + pins + step cards) to keep CLS = 0, and the invoice `loading.tsx` MUST use the same
`DetailContainer` as its `page.tsx` (check:layout pair rule).

## 7. Files Touched (indicative)

**Invoice Settings**
- `src/components/invoices/invoice-settings-form.tsx` — orchestrator (state, submit, dirty tracking,
  prefix dialog, navigate-away guard).
- `src/components/invoices/invoice-settings/` — 6 per-section sub-components + `section-nav.tsx`,
  `use-scroll-spy.ts`, `sticky-save-bar.tsx`.
- `src/app/(staff)/admin/settings/invoicing/page.tsx` + `loading.tsx` — swap to `DetailContainer`
  (both), two-column layout, section metadata.

**Reminder Schedules**
- `.../schedules/_components/schedule-editor.tsx` — orchestrator.
- `.../_components/` — `reminder-timeline.tsx`, `step-card.tsx`, `email-preview.tsx`,
  `advanced-fields.tsx`, and a pure `step-id-composer.ts` helper.
- `@/modules/renewals/client` barrel — expose `RENEWAL_REMINDER_OFFSETS` (+ optional preview
  resolver) for the client (§5.5).

**Shared**
- `src/i18n/messages/{en,th,sv}.json` — new keys for both surfaces.

## 8. Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Auto-composed identifiers stop email delivery (rev.1 bug) | Correct formats + arithmetic offsetKey + membership-checked picker (§5.3); **contract test through gateway parsers** (§6.3). |
| Recompose changes existing step_ids on save | Preserve stored ids verbatim on load; recompose only on explicit timing/channel edit; document the change-diff/idempotency effect (§5.4). |
| Sticky Save bypasses tax guards | Sticky Save calls `form.requestSubmit()` → single `handleSubmit`; 6-guard regression checklist + E2E (§4.3). |
| Full-body PATCH overwrites tax identity with empty | All state in orchestrator; no conditional-unmount of tax sections; full-body-invariance test (§4.4, §6.3). |
| Container width trips `check:layout` | Use `DetailContainer` (72rem) for page **and** loading; no raw width / exemption (§4.1, §6.4). |
| Copy matrix leaks into client bundle / throws | Client-safe barrel + arithmetic composer + `resolveCopy` guard; server-action preview if 3-locale needed (§5.5). |
| Timeline duplicate ids across 5 mounted panels | `tierBucket`-prefix every id (§5.1). |
| Segmented-control focus fails contrast | Full-opacity `ring-ring`/`border-ring`, ≥44px (§5.2, §6.2). |
| i18n word-order breaks timing sentence | ICU display string via existing keys + plural rules; before/after separately labelled (§5.2, §6.1). |

## 9. Open Questions

None blocking. Implementation-plan details: exact collision-suffix scheme (unlikely to trigger
given the natural key), the precise mobile nav affordance (select vs. chip row), and whether the
email preview needs full 3-locale copy (server-action) or a single representative line
(client-safe).
