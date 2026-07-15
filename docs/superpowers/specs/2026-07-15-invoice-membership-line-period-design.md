# Invoice Membership Line — Show the Customer's Actual Period — Design

**Date:** 2026-07-15
**Branch:** `064-invoice-membership-line-period` (off `main`).
**Gate:** **tax + security sign-off, ≥2 reviewers** — this changes the §86/4
membership line-item text printed on invoices + receipts.

## Problem

The membership line on a §86/4 invoice/receipt currently prints, for a member
being billed for the FIRST time (which is every imported TSCC member):

```
Membership Regular Corporate (12 months, effective from the month of payment)
ค่าสมาชิก สมาชิกองค์กรทั่วไป (12 เดือน เริ่มตั้งแต่เดือนที่ชำระค่าธรรมเนียม)
```

TSCC wants the line to show the **customer's actual membership period** and their
product naming:

```
SweCham Regular Corporate Membership Fee 2026 (August 2026 - July 2027)
ค่าสมาชิก SweCham สมาชิกองค์กรทั่วไป ปี 2569 (สิงหาคม 2569 - กรกฎาคม 2570)
```

### Why it regressed (answered)

It used to print a coverage window always. **Commit `1acf86dc` (PR #173
"rolling-anchor membership periods", 2026-07-10)** replaced the old
`fiscalYearBoundaryForYear(planYear, …)` window — which printed CALENDAR-year
dates that contradicted TSCC's rolling policy — with a `from_payment` / `window`
split, but wired the correct rolling `window` ONLY into the automated F8 renewal
bridge, not the manual "New invoice" path or first payments. So a manually-issued
first invoice (every imported member) falls to the generic `from_payment` text.

## Root-cause map (verified)

- `create-invoice-draft.ts:314-341` composes the membership line description. When
  `membershipCoverage.kind === 'window'` it prints `(coverage YYYY-MM-DD to
  YYYY-MM-DD)`; the default `from_payment` prints the generic wording.
- `POST /api/invoices` (`route.ts:93-106`) resolves `loadMemberRenewalContext` and
  passes `membershipCoverage: {window}` **only when `classification.kind ===
  'renewal'`**. A first payment → no coverage → generic.
- `loadMemberRenewalContext` (`member-renewal-context.ts`) already loads the
  member's open cycle but returns `periodTo`/`termMonths` **only** for `renewal`.
- Every imported member has an unsettled open cycle → classified `first_payment` →
  generic text.

## Decisions (locked with the maintainer 2026-07-15)

1. **Period source = the member's open renewal cycle** (the importer created one
   per active member, anchored at column G "Membership Start" → periodTo = column
   K "Renewal date"). Resolve it server-side; never a client value (it's a §86/4
   field).
2. **Show the period for a FIRST payment too** (not only renewals). First payment
   bills the **current** period `[openCycle.periodFrom, openCycle.periodTo]`;
   a renewal bills the **next** period `[periodTo, periodTo + term]` (unchanged).
3. **"SweCham" = a new tenant field** `tenant_invoice_settings.brand_name`
   (multi-tenant-correct; there is no short-name field today, only `legal_name_*`).
   Nullable — when null the brand prefix is simply omitted. TSCC's value: `SweCham`.
4. **Year = `planYear`** (already an input to the draft). TH prints the Buddhist
   Era year (`planYear + 543`).
5. **TH uses Thai month names + Buddhist Era** (สิงหาคม 2569). Reuse the existing
   `format-tax-doc-date.ts` BE/Thai-calendar pattern.
6. **New format only affects new drafts** — the description is composed once and
   stored on the line; the PDF renders it verbatim. Existing issued documents keep
   their text (prod has 0 invoices today). No template-version gate needed.

## Target format

```
EN: {brand }{planNameEn} Membership Fee {planYear} ({MonthStart YYYY} - {MonthEnd YYYY})
TH: ค่าสมาชิก {brand }{planNameTh} ปี {planYearBE} ({เดือนเริ่ม พ.ศ.} - {เดือนจบ พ.ศ.})
```

- `{brand }` present only when `brand_name` is set (trailing space included).
- **Window month rule** (always exactly `term` month-labels, robust to non-1st-of-
  month starts): `start = monthYear(fromIso)`, `end = monthYear(addMonthsUtc(toIso, -1))`.
  - `[2026-08-01, 2027-08-01)` → `August 2026 - July 2027`
  - `[2026-06-30, 2027-06-30)` → `June 2026 - May 2027`
- **No-cycle fallback** (a member with no open cycle — e.g. the 10 inactive
  imported members): keep the new label but the generic period text
  `(12 months, effective from the month of payment)` / `(12 เดือน …)`.
- The pro-rate suffix (`(pro-rated 0.8333, from …)`) is unchanged and still
  appended when `proRateFactor !== '1.0000'`.

## Changes

### 1. `tenant_invoice_settings.brand_name`
- Migration: `ADD COLUMN brand_name text` (nullable). Idempotent, RLS inherits.
- `schema-tenant-invoice-settings.ts` + the settings row type + the settings repo
  (`getForIssue` returns `brandName`).
- Admin invoicing settings form + its update use-case + zod (one optional text
  field, ≤100 chars) + i18n label — so the admin can set/change "SweCham".
- Operator sets `brand_name = 'SweCham'` for the swecham tenant (via the form, or a
  one-off after deploy).

### 2. Month-year formatter — `src/lib/format-tax-doc-month-year.ts`
`formatTaxDocMonthYear(isoDate, locale)` → `August 2026` / `สิงหาคม 2569` /
`augusti 2026`, mirroring `format-tax-doc-date.ts` (forced Gregorian base +
`(พ.ศ. …)` — but month+year only, no day). Pure, unit-tested.

### 3. `create-invoice-draft.ts` — restructure the description
- Read `settings.brandName`.
- Replace `windowText` with month-year formatting per the rule above (uses
  `addMonthsUtc` from `@/lib/dates`, already imported by the route).
- Recompose `membershipDescEn` / `membershipDescTh` to the target format
  (brand + plan + "Membership Fee"/"ค่าสมาชิก … ปี" + year + window).
- Keep the `from_payment` generic branch for the no-window fallback.

### 4. `loadMemberRenewalContext` — expose the current period
Return the open cycle's `periodFrom` + `periodTo` whenever an open cycle exists
(not only for `renewal`), so the route can build a first-payment window. Add
`currentPeriodFrom` / `currentPeriodTo` (or reshape `periodTo`) — keep the existing
`renewal` fields for the renewal window.

### 5. `POST /api/invoices` — pass the window for first payments too
- `renewal` → `{ window, fromIso: periodTo, toIso: periodTo + term }` (unchanged).
- `first_payment` with an open cycle → `{ window, fromIso: currentPeriodFrom,
  toIso: currentPeriodTo }`.
- else → no coverage (generic). Failure still degrades to generic (advisory-only).

### 6. Tests
- Update `create-invoice-draft.test.ts` + the two `membership-coverage` contract
  tests to the new description strings.
- New unit tests: the month-year formatter; the month-end rule (1st-of-month and
  month-end starts); brand present/absent; first-payment window; TH BE output.

## Out of scope (next phase)
- **Importing historical invoices/receipts** (columns F–K) as real §86/4 documents
  with §87 sequential numbering — a separate, larger design.

## References
- `create-invoice-draft.ts:277-341` (description composition), `route.ts:86-106`
  (coverage threading), `member-renewal-context.ts`, `format-tax-doc-date.ts`,
  `@/lib/dates` (`addMonthsUtc`). Regression commit `1acf86dc` (PR #173).
