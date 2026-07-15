# Invoice Membership Line — Actual Period — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans. Steps use `- [ ]` tracking.

**Goal:** Print the customer's real membership period + TSCC product naming on the
§86/4 membership line (`SweCham Regular Corporate Membership Fee 2026 (August 2026
- July 2027)`), driven by the member's renewal cycle — including first payments.

**Spec:** `docs/superpowers/specs/2026-07-15-invoice-membership-line-period-design.md`.
**Branch:** `064-invoice-membership-line-period`. **Gate:** tax + security, ≥2 reviewers.

## Global Constraints
- `pnpm`, never `npm`. No new deps. Never `prettier --write`. Never `git add -A`.
- Final gate before each commit: `npx tsc -p tsconfig.tsccheck.json --noEmit`.
- TDD: failing test → run red → implement → green. i18n: all new keys in en/th/sv.
- Apply migration to the `dev` branch + run integration before committing schema.
- BE is display-only; storage stays UTC Gregorian.

---

### Task 1: Month-year tax-doc formatter (pure)

**Files:** create `src/lib/format-tax-doc-month-year.ts`; test
`tests/unit/lib/format-tax-doc-month-year.test.ts`.

**Produces:** `formatTaxDocMonthYear(isoDate: string, locale: string): string` —
`August 2026` (en), `augusti 2026` (sv), `สิงหาคม 2569` (th, Buddhist Era),
`—` on an invalid date. Mirrors `format-tax-doc-date.ts` (forced Gregorian base,
`(พ.ศ. year+543)`), month+year only (no day).

- [ ] **Step 1: failing test**
```ts
import { describe, expect, it } from 'vitest';
import { formatTaxDocMonthYear } from '@/lib/format-tax-doc-month-year';
describe('formatTaxDocMonthYear', () => {
  it('EN month + Gregorian year', () => {
    expect(formatTaxDocMonthYear('2026-08-01', 'en')).toMatch(/August 2026/);
  });
  it('TH Thai month + Buddhist Era', () => {
    const s = formatTaxDocMonthYear('2026-08-01', 'th');
    expect(s).toContain('สิงหาคม');
    expect(s).toContain('2569');
  });
  it('invalid → em dash', () => {
    expect(formatTaxDocMonthYear('2026-13-40', 'en')).toBe('—');
  });
});
```
- [ ] **Step 2:** run red.
- [ ] **Step 3: implement** (copy `format-tax-doc-date.ts`, drop `day`, use
  `{ year: 'numeric', month: 'long', timeZone: 'UTC' }`; keep the `year+543`
  suffix for th; `getDateFormatLocale` for others).
- [ ] **Step 4:** run green + `npx tsc -p tsconfig.tsccheck.json --noEmit`.
- [ ] **Step 5: commit** `feat(lib): tax-doc month-year formatter (BE for Thai)`.

---

### Task 2: `tenant_invoice_settings.brand_name` — column + read

**Files:** new migration `drizzle/migrations/NNNN_tenant_brand_name.sql` (+ journal);
`schema-tenant-invoice-settings.ts`; the settings row type + `TenantSettingsRepo`
`getForIssue` (add `brandName: string | null`); test the read in an existing
invoicing integration test.

- [ ] **Step 1:** migration `ALTER TABLE "tenant_invoice_settings" ADD COLUMN IF NOT
  EXISTS "brand_name" text;` (+ journal entry, next idx). Pattern from a recent
  additive migration.
- [ ] **Step 2:** add `brandName: text('brand_name')` to the schema; thread onto the
  settings row/DTO `getForIssue` returns (so `create-invoice-draft` can read it).
- [ ] **Step 3:** `pnpm db:migrate` (dev branch) + run the invoicing integration
  suite that exercises `getForIssue` to confirm the column reads (null default).
- [ ] **Step 4: commit** `feat(invoicing): tenant brand_name column + settings read`.

---

### Task 3: Restructure the membership line description

**Files:** `create-invoice-draft.ts` (`:277-341` region); update
`tests/unit/invoicing/create-invoice-draft.test.ts` +
`tests/contract/**/create-invoice-draft-membership-coverage*.test.ts` +
`tests/contract/**/create-draft-membership-coverage-threading*.test.ts` to the new
strings.

**Consumes:** `formatTaxDocMonthYear` (T1), `settings.brandName` (T2),
`addMonthsUtc` (`@/lib/dates`).

- [ ] **Step 1: failing tests** — assert the new EN + TH strings for (a) a `window`
  coverage with brand set → `SweCham Regular Corporate Membership Fee 2026 (August
  2026 - July 2027)` / `ค่าสมาชิก SweCham สมาชิกองค์กรทั่วไป ปี 2569 (สิงหาคม 2569 -
  กรกฎาคม 2570)`; (b) brand null → prefix omitted; (c) `from_payment` → new label +
  generic period text; (d) the month-end rule (`[2026-06-30,2027-06-30)` → `June
  2026 - May 2027`).
- [ ] **Step 2:** run red.
- [ ] **Step 3: implement** — read `settings.brandName`; build the window text via
  `start = formatTaxDocMonthYear(fromIso, locale)`, `end =
  formatTaxDocMonthYear(addMonthsUtc(toIso, -1), locale)`; recompose:
```ts
const brandEn = settings.brandName ? `${settings.brandName} ` : '';
const brandTh = settings.brandName ? `${settings.brandName} ` : '';
const yearBE = input.planYear + 543;
const windowEn = coverage.kind === 'window'
  ? `(${formatTaxDocMonthYear(coverage.fromIso, 'en')} - ${formatTaxDocMonthYear(addMonthsUtc(coverage.toIso, -1), 'en')})`
  : '(12 months, effective from the month of payment)';
const windowTh = coverage.kind === 'window'
  ? `(${formatTaxDocMonthYear(coverage.fromIso, 'th')} - ${formatTaxDocMonthYear(addMonthsUtc(coverage.toIso, -1), 'th')})`
  : '(12 เดือน เริ่มตั้งแต่เดือนที่ชำระค่าธรรมเนียม)';
const membershipDescEn =
  `${brandEn}${planLabelEn}Membership Fee ${input.planYear} ${windowEn}` +
  (proRateFactor === '1.0000' ? '' : ` (pro-rated ${proRateFactor}, from ${proRateAnchor})`);
const membershipDescTh =
  `ค่าสมาชิก ${brandTh}${planLabelTh}ปี ${yearBE} ${windowTh}` +
  (proRateFactor === '1.0000' ? '' : ` (pro-rate ${proRateFactor}, ตั้งแต่ ${proRateAnchor})`);
```
  (`planLabelEn`/`planLabelTh` keep their trailing space; verify spacing in tests.)
- [ ] **Step 4:** run green (unit + contract) + `tsc`.
- [ ] **Step 5: commit** `feat(invoicing): membership line = brand + plan + fee year + real period`.

---

### Task 4: `loadMemberRenewalContext` — expose the current period

**Files:** `member-renewal-context.ts`; its consumers' types.

- [ ] Add `currentPeriodFrom: string | null` + `currentPeriodTo: string | null` to
  `MemberRenewalContext`, set from `openCycle.periodFrom/periodTo` **whenever an
  open cycle exists** (independent of classification). Keep existing `periodTo`/
  `termMonths` (renewal-only) unchanged.
- [ ] **commit** `feat(invoicing): expose the open cycle's current period for the invoice form`.

---

### Task 5: `POST /api/invoices` — window for first payments too

**Files:** `src/app/api/invoices/route.ts` (`:93-106`).

- [ ] Extend the coverage resolution:
```ts
if (rc.classification.kind === 'renewal' && rc.periodTo && rc.termMonths) {
  membershipCoverage = { kind: 'window', fromIso: rc.periodTo, toIso: addMonthsUtc(rc.periodTo, rc.termMonths) };
} else if (rc.classification.kind === 'first_payment' && rc.currentPeriodFrom && rc.currentPeriodTo) {
  membershipCoverage = { kind: 'window', fromIso: rc.currentPeriodFrom, toIso: rc.currentPeriodTo };
}
```
  (unknown/no-cycle → no coverage → generic; failure still degrades to generic.)
- [ ] Update/extend the membership-coverage contract test for the first-payment case.
- [ ] **commit** `feat(invoicing): print the real period on a first-payment membership invoice`.

---

### Task 6: Admin settings — brand_name field (so the operator can set "SweCham")

**Files:** the `/admin/settings/invoicing` form + its update use-case + zod schema +
i18n (en/th/sv) label. One optional text input (≤100 chars).

- [ ] Add `brand_name` to the settings update schema (`z.string().max(100).optional()`),
  the use-case patch, the form field + label i18n; render current value.
- [ ] Test the update use-case round-trips brand_name.
- [ ] **commit** `feat(invoicing): admin can set the tenant brand name`.

---

## Final gate
```
pnpm lint && npx tsc -p tsconfig.tsccheck.json --noEmit && pnpm check:i18n
pnpm vitest run tests/unit/invoicing/ tests/unit/lib/format-tax-doc-month-year.test.ts tests/contract/invoicing/ tests/contract/invoices/
pnpm vitest run --config vitest.integration.config.ts tests/integration/invoicing/
```
Then: PR against `main` stating it changes the §86/4 line-item text (tax + security,
≥2 reviewers). Operator sets `brand_name='SweCham'` for swecham after deploy.

## Self-review
- Spec coverage: formatter (T1), brand field (T2+T6), description (T3), period source
  first-payment (T4+T5). Month-end rule tested in T1+T3. Fallback kept (T3).
- Out of scope: historical invoice/receipt import (next phase).
- Type consistency: `brandName: string | null`; `currentPeriodFrom/To: string|null`;
  window `fromIso/toIso` ISO `YYYY-MM-DD`.
