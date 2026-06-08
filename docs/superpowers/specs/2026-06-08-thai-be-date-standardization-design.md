# Thai Buddhist-Era Date-Display Standardization — Design

**Date:** 2026-06-08
**Status:** Approved (brainstorming) → ready for writing-plans
**Scope:** App-wide date *display* standardization (storage stays UTC Gregorian — untouched).
**Origin:** Deferred P2 item (`project_thai_be_date_inconsistent`) + user follow-up "admin/invoices date standardization", scope-expanded to the full remaining sweep.

---

## 1. Problem

Thai (`th`/`th-TH`) date **display** is rendered inconsistently across Chamber-OS. The codebase has a canonical helper — `src/lib/format-date-localised.ts` (`getDateFormatLocale` + `formatLocalisedDate`, mapping `th`→`'th-TH-u-ca-buddhist'`) — but many surfaces bypass it:

- **Raw ISO** rendered with no formatting at all (admin invoices list).
- **Bare-locale** `toLocaleString(locale)` / `Intl.DateTimeFormat(locale)` relying on the host ICU default for `th` (brittle — the default calendar for bare `'th'` is ICU-version-dependent; the off-by-543-years class).
- **Inline `'th-TH-u-ca-buddhist'`** ternaries duplicating the helper's logic per-site (functionally correct, but DRY/maintenance risk + drift).

Two tax-document surfaces additionally disagree on what bare-`'th'` ICU does, producing a latent inconsistency:
- **admin credit-notes** render `CE + (พ.ศ. year+543)` (assumes bare-`'th'` → Gregorian).
- **portal credit-note** renders bare `toLocaleDateString('th')` and *relies* on ICU default → BE, with no `(พ.ศ.)` suffix (assumes bare-`'th'` → BE).
One of these assumptions is wrong on any given ICU build → double-BE or CE-where-BE-expected.

**Policy (CLAUDE.md):** BE is display-only and correct/expected for `th-TH`. Storage is always UTC Gregorian.

## 2. Goal / Success criteria

- Every **general** user-facing date surface renders BE for `th` through the **one canonical helper** — never inline `'u-ca-buddhist'`, never bare-locale ICU reliance.
- **Tax documents** use the deliberate `CE + (พ.ศ.)` treatment **consistently** (admin + portal credit-notes + invoice PDF), with the CE base forced to Gregorian so BE can't double-print.
- A **regression guard** prevents re-introducing the bypassed patterns.
- **Zero visible change** on already-correct (inline-BE) surfaces; the only intended visible changes are: the admin invoices list gains BE dates (was raw ISO), and the portal credit-note gains the `(พ.ศ.)` parenthetical (tax consistency).
- Storage, fiscal-year/js-joda logic, and relative-time *relative* output are untouched.

## 3. Design

### 3.1 Canonical helper (`src/lib/format-date-localised.ts`) — extend
- `getDateFormatLocale(locale)`: `th`/`th-TH` → `'th-TH-u-ca-buddhist'`; **add `sv`/`sv-SE` → `'sv-SE'`**; else passthrough. (The `sv` mapping makes it the single uniform helper — preserves the richer mapping some sites, e.g. relative-time, already do, so every general surface can adopt the helper without changing `sv` behavior.)
- `formatLocalisedDate(iso, locale, options?)`: unchanged (returns `'—'` on invalid date).
- This is the single source of truth for **general** date display.

### 3.2 General-surface migration (→ helper)
Replace each site's inline ternary / bare-locale / raw render with `getDateFormatLocale(locale)` (or `formatLocalisedDate` where a one-shot format fits). **Preserve each surface's existing visual style** (`dateStyle`/explicit `year/month/day`, `timeStyle`, `timeZone` pins) — only the *locale mechanism* changes.

Migration targets (verified 2026-06-08):

| # | File:line | Pattern | Action |
|---|---|---|---|
| F1 | `app/(staff)/admin/invoices/_components/invoice-table.tsx:504` (issueDate) | raw ISO | `formatLocalisedDate` (BE; match detail's `{year:'numeric',month:'short',day:'numeric'}`) — **visible fix** |
| F2 | `…invoice-table.tsx:505` (dueDate) | raw ISO | same |
| C1 | `app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx:102` | bare-locale `toLocaleString` | `getDateFormatLocale(locale)` |
| B1 | `components/broadcast/quota-banner.ts:64` | inline ternary | `getDateFormatLocale` |
| B2 | `components/broadcast/schedule-picker.tsx:54` | inline (picker, Asia/Bangkok pin) | `getDateFormatLocale` (keep tz/style) |
| B3 | `components/broadcast/admin/template-library.tsx:79` | inline | `getDateFormatLocale` |
| B4 | `components/broadcast/admin/batch-breakdown.tsx:137` | inline | `getDateFormatLocale` |
| B5 | `components/broadcast/admin/approve-dialog.tsx:226` | inline | `getDateFormatLocale` |
| B6 | `components/broadcast/admin/queue-table.tsx:50` | inline | `getDateFormatLocale` |
| B7 | `components/broadcast/admin/halt-state-banner.tsx:38` | inline | `getDateFormatLocale` |
| B8 | `components/broadcast/admin/audit-timeline.tsx:73` | inline | `getDateFormatLocale` |
| B9 | `components/members/timeline-event-item.tsx:62` | inline | `getDateFormatLocale` |
| B10 | `components/members/archived-banner.tsx:90` | inline | `getDateFormatLocale` |
| B11 | `components/ui/relative-time.tsx:130` (SSR absolute fallback) | inline (also `sv→sv-SE`) | `getDateFormatLocale` (now handles sv) |
| B12 | `lib/relative-time.ts:73` | inline | `getDateFormatLocale` |
| B13 | `app/(staff)/admin/renewals/[cycleId]/page.tsx:51` | inline | `getDateFormatLocale` |
| B14 | `app/(staff)/admin/broadcasts/[id]/page.tsx:77` | inline | `getDateFormatLocale` |

(B1–B14 are functionally correct BE today → **no visible change**, pure DRY + robustness.)

### 3.3 DRY consolidation
- `app/(staff)/admin/invoices/[invoiceId]/page.tsx` local `formatDate` and `app/(member)/portal/invoices/_utils/format.ts` local `formatDate` both already call `getDateFormatLocale` correctly. Route them through the shared `formatLocalisedDate` where byte-identical; otherwise keep the thin local wrapper but ensure it consumes the helper (no inline duplication). Do not change rendered output.

### 3.4 Tax-doc fix (credit-notes) — thai-tax-compliance reviewed
- **portal credit-note** (`app/(member)/portal/credit-notes/[creditNoteId]/page.tsx:71`): change ICU-default-BE → **`CE + (พ.ศ. year+543)`** matching admin credit-notes (consistent, robust).
- **admin credit-notes** (`app/(staff)/admin/credit-notes/page.tsx`, `[creditNoteId]/page.tsx`) + **invoice PDF template**: keep `CE + (พ.ศ.)`.
- **Resolve the bare-`'th'` ambiguity:** the CE base of the parenthetical MUST force the **Gregorian** calendar (e.g. `'th-TH-u-ca-gregory'` or `'en-GB'` for the date part) so "29 พ.ค. 2026 (พ.ศ. 2569)" can never double-print BE on an ICU build whose bare-`'th'` default is buddhist. Centralize the tax-doc date formatter (e.g. `formatTaxDocDate(iso, locale)`) so admin + portal credit-notes share one implementation.
- **This sub-area requires a `thai-tax-compliance-auditor` review** before merge (legal-sensitive; §105/§86 wording, no double-BE, fast-check the CE/BE invariant).

### 3.5 Regression guard
- Add an ESLint `no-restricted-syntax` rule (or a `pnpm check:dates` script) banning new inline `'u-ca-buddhist'` string literals and bare-locale `toLocaleDateString`/`toLocaleString`/`new Intl.DateTimeFormat(<bareLocale>)` in display code under `src/` (allow-list `format-date-localised.ts` + the centralized tax-doc formatter). Keeps the standardization from regressing (a prior `dateFormatLocale` duplicate had to be caught by manual review).

### 3.6 Testing
- **Unit (`getDateFormatLocale`/`formatLocalisedDate`):** `th`→buddhist, `th-TH`→buddhist, **`sv`→`sv-SE`**, `en` passthrough; `formatLocalisedDate` BE-year correctness + invalid→`'—'`.
- **Tax-doc:** assert the centralized `formatTaxDocDate` renders a **Gregorian** CE base + exactly one `(พ.ศ. year+543)` suffix for `th` (no double-BE), Gregorian-only for en/sv; fast-check the CE↔BE = +543 invariant.
- **Migration spot-checks:** admin invoices list renders BE for `th`; relative-time `sv` output unchanged; a render test or i18n-key check where practical.
- Full gate: `pnpm lint && typecheck && check:i18n && the new check:dates`.

## 4. Out of scope
- `components/ui/calendar.tsx` (month-only header, no year → BE irrelevant) — leave.
- Storage, js-joda fiscal-year/sequential-number logic, `Intl` used for sort keys, `trend-window.ts`, `insight-cycle-key.ts`, env — untouched.
- Email templates — none found doing client-style date formatting; revisit only if a date surface is discovered.
- The relative-time *relative* output ("2 days ago") — untouched (only its SSR absolute fallback is migrated).

## 5. Risks / mitigations
- **Tax-doc legal sensitivity** → centralize + thai-tax-compliance review + invariant tests; keep admin behavior byte-identical.
- **`sv` behavior drift** from extending the helper → unit test pins `sv→sv-SE`; audit the few sv-aware sites.
- **Re-touching just-shipped portal `format.ts`** (D-series) → DRY change is behavior-preserving + covered by the existing portal invoice tests.
- **Large surface (~16 files)** → most are no-visible-change DRY swaps; stage by area (invoices / broadcast / members / renewals / relative-time / tax-docs) for reviewable commits.
