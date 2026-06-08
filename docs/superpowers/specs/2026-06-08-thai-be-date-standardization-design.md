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

### 3.3 DRY consolidation (clarified per architecture review)
Three different existing `formatDate`-style functions; they are NOT all the same and must not be naively merged:
- **admin invoice-detail** `app/(staff)/admin/invoices/[invoiceId]/page.tsx` local `formatDate` (ISO timestamps, no UTC-pin) → route through the shared **`formatLocalisedDate`** (byte-identical; remove the local wrapper).
- **portal** `app/(member)/portal/invoices/_utils/format.ts` local `formatDate` (ISO timestamps, **intentionally NOT UTC-pinned** — see its own comment vs the credit-note) → already consumes `getDateFormatLocale` correctly; **KEEP as a thin local wrapper** (do not force it into `formatLocalisedDate` if options/TZ differ). No visible change.
- **credit-note** `formatIssueDate` (bare `YYYY-MM-DD`, UTC-pinned) → folded into **`formatTaxDocDate`** (§3.4), NOT `formatLocalisedDate` (different input shape + UTC-pin + the `(พ.ศ.)` treatment).

### 3.4 Tax-doc fix (credit-notes) — thai-tax-compliance reviewed
**Both admin AND portal credit-notes have the latent double-BE bug** (the CE base uses a bare `'th'`/`'th-TH'` locale → on a Node 22 ICU build whose default `th` calendar is buddhist, the "CE base" already prints BE, then `(พ.ศ. year+543)` is appended → "29 พ.ค. 2569 (พ.ศ. 2569)"). So the fix is NOT "keep admin / change portal" — it is **centralize one `formatTaxDocDate(isoDate, locale)` used by all credit-note surfaces** (admin list + admin detail + portal detail):
- **CE base forced to Gregorian via `'th-TH-u-ca-gregory'`** (NOT `'en-GB'` — keeps Thai month script: "29 พ.ค. 2026") + the `(พ.ศ. year+543)` suffix for `th`; Gregorian-only for en/sv.
- **Input is a bare `YYYY-MM-DD` string** → parse via `Date.UTC(y, m-1, d)` and render with `timeZone: 'UTC'`. Do NOT pass `isoDate` to `new Date()` / `Intl` without the UTC pin (day-shift across server-UTC vs Asia/Bangkok). This is why `formatTaxDocDate` is SEPARATE from the general `formatLocalisedDate`.
- Migration targets (add to the list): admin `credit-notes/page.tsx:formatIssueDate`, admin `credit-notes/[creditNoteId]/page.tsx:formatIssueDate`, portal `credit-notes/[creditNoteId]/page.tsx:formatIssueDate` → all call `formatTaxDocDate`.
- **invoice PDF template** keeps its own `{isoDate} (พ.ศ. {beYear})` raw-ISO treatment (deterministic @react-pdf rendering, avoids ICU in the PDF runtime) — leave as-is.
- **Policy (document, do NOT change):** invoice-detail **HTML** (admin + portal) renders **BE-only** via the general helper (it's a general operational view); **credit-note HTML + all tax PDFs** render **`CE + (พ.ศ.)`** (stricter tax document with a CE anchor for auditors). The credit-note *list* shown on the invoice-detail page is a reference list (general context) → BE-only is acceptable there. This matches the existing in-code intent ("CE+พ.ศ. treatment lives on the credit-note surfaces, not here").
- **Requires a `thai-tax-compliance-auditor` review** before merge (legal-sensitive; §86/§87/§105; no double-BE; fast-check CE↔BE=+543).

### 3.5 Regression guard — `check:dates` script (decided)
Add a `scripts/check-dates.ts` + `pnpm check:dates` (matching the repo's existing `check:layout`/`check:i18n`/`check:fixme` script pattern — NOT an ESLint `no-restricted-syntax` AST rule, which is harder to maintain + noisy). It bans, in display code under `src/`, new inline `'u-ca-buddhist'` literals and bare-locale `toLocaleDateString`/`toLocaleString`/`new Intl.DateTimeFormat(<bareLocale>)`. Allow-list: `src/lib/format-date-localised.ts` + the `formatTaxDocDate` module. Wire into pre-push + full CI. Keeps the standardization from regressing.

### 3.6 Testing
- **Unit (`getDateFormatLocale`/`formatLocalisedDate`):** `th`→buddhist, `th-TH`→buddhist, **`sv`→`'sv-SE'` (explicit), `en` passthrough**; plus an **sv no-regression assertion** — `Intl.DateTimeFormat('sv-SE', …).format(d) === Intl.DateTimeFormat('sv', …).format(d)` (proves the migration doesn't change sv output); `formatLocalisedDate` BE-year correctness + invalid→`'—'`. **Assert Arabic numerals** (e.g. "2569", not "๒๕๖๙") — no `-nu-thai`.
- **Tax-doc (`formatTaxDocDate`):** Gregorian CE base (year is CE) + exactly one `(พ.ศ. year+543)` suffix for `th` (no double-BE); Gregorian-only for en/sv; UTC-pin (no day-shift at a TZ-midnight boundary); fast-check CE↔BE=+543.
- **payment-timeline (C1):** an explicit unit test asserting the formatted output uses the BE calendar for `th` (pin the locale output — do NOT rely on the "verified on Node 22" comment); also update/remove that stale "false positive" comment in the code.
- **Migration spot-checks:** admin invoices list renders BE for `th`; relative-time `sv` output unchanged.
- Full gate: `pnpm lint && typecheck && check:i18n && check:dates`.

## 4. Out of scope
- `components/ui/calendar.tsx` (month-only header, no year → BE irrelevant) — leave.
- Storage, js-joda fiscal-year/sequential-number logic, `Intl` used for sort keys, `trend-window.ts`, `insight-cycle-key.ts`, env — untouched.
- **Email templates** (`modules/*/infrastructure/email/**`, e.g. `dual-format-date-footer.tsx`, `broadcast-notification-emails.ts`) — Infrastructure layer; locale is the *recipient's*, not the request locale; some carry their own inline `sv→sv-SE`. Left untouched (separate context).
- The relative-time *relative* output ("2 days ago") — untouched (only its SSR absolute fallback is migrated).

### Known gaps (tracked, NOT fixed here)
- **Invoice PDF footer credit-note reference table** (`modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx:~393` `{r.issueDate}`) renders a raw `YYYY-MM-DD` with no `(พ.ศ.)`, while the CN body + CN HTML carry the parenthetical → minor intra-PDF inconsistency. Track for a future PDF-template pass.

## 5. Risks / mitigations
- **Tax-doc legal sensitivity** → centralize + thai-tax-compliance review + invariant tests; keep admin behavior byte-identical.
- **`sv` behavior drift** from extending the helper → unit test pins `sv→sv-SE`; audit the few sv-aware sites.
- **Re-touching just-shipped portal `format.ts`** (D-series) → DRY change is behavior-preserving + covered by the existing portal invoice tests.
- **Large surface (~16 files)** → most are no-visible-change DRY swaps; stage by area (invoices / broadcast / members / renewals / relative-time / tax-docs) for reviewable commits.

## 6. Sequencing (hard order for the plan)
1. **Step 0 (lands first, own commit):** extend `getDateFormatLocale` (`sv→'sv-SE'`) + its unit tests. Every B/C/F site depends on the helper being correct first.
2. **Step 1 (own commit):** add `formatTaxDocDate` util + tests (Gregorian CE base + UTC-pin + single `(พ.ศ.)`), then point all 3 credit-note surfaces at it. Tax-doc review here.
3. **Step 2 (own commit):** add `check:dates` script + wire CI; fix any remaining flagged sites it catches.
4. **Step 3+ (per-area commits):** the general B/C/F migrations (invoices list F1/F2 + payment-timeline C1; broadcast; members; renewals; relative-time; admin/broadcasts/[id]) — no hard inter-dependency; each is behavior-preserving except F1/F2 (admin list gains BE). Update the stale payment-timeline "false positive" comment.

## 7. Design-review sign-off (2026-06-08, via .claude/agents in lieu of human review)
- `thai-tax-compliance-auditor`: CONDITIONAL PASS → folded M-1 (UTC-pin), M-2 (invoice-HTML-BE-only vs CN-CE+พ.ศ. policy documented), admin-CN-also-buggy, PDF-footer known gap.
- `chamber-os-architect`: ADJUST → folded admin-CN-in-scope, `check:dates` (not ESLint), DRY-scope clarification, sequencing, sv-safe + lib/ placement confirmed.
- `i18n-translation-reviewer`: GO → folded `'th-TH-u-ca-gregory'` pin, sv no-regression test, Arabic-numerals assertion; th→buddhist + bare-`'th'` locale + sv→sv-SE confirmed.
