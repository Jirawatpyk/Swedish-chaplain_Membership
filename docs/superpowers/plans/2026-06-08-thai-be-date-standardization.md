# Thai-BE Date-Display Standardization — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every general user-facing date surface renders Buddhist-Era for `th` through ONE canonical helper; tax documents (credit-notes) use a consistent, robust `CE + (พ.ศ.)` treatment — eliminating the 3 inconsistent patterns (raw-ISO, bare-locale ICU-default, inline `th-TH-u-ca-buddhist`).

**Architecture:** Extend the existing `src/lib/format-date-localised.ts` (general helper) + add a separate `src/lib/format-tax-doc-date.ts` (tax-doc formatter with a forced-Gregorian CE base + UTC-pin). Migrate ~16 general surfaces to the helper and 3 credit-note surfaces to the tax formatter. Add a `check:dates` script to prevent regression. Storage stays UTC Gregorian — display-only.

**Tech Stack:** TypeScript (strict), Next.js 16 RSC + client components, next-intl (`getLocale`/`useLocale`), `Intl.DateTimeFormat`, Vitest. Spec: `docs/superpowers/specs/2026-06-08-thai-be-date-standardization-design.md`.

**Hard sequencing (spec §6):** Task 1 (helper) → Task 2 (tax util) → Task 3 (credit-notes) → Task 4 (guard) → Tasks 5–10 (general migrations, no inter-dependency). Each task ends in a commit.

---

## File Structure

| File | Responsibility | Action |
|---|---|---|
| `src/lib/format-date-localised.ts` | General locale→calendar helper (`getDateFormatLocale`, `formatLocalisedDate`) | Modify (add `sv→'sv-SE'`) |
| `tests/unit/lib/format-date-localised.test.ts` | Unit tests for the general helper | Create |
| `src/lib/format-tax-doc-date.ts` | Tax-doc date formatter (`formatTaxDocDate`: forced-Gregorian CE base + UTC-pin + single `(พ.ศ.)`) | Create |
| `tests/unit/lib/format-tax-doc-date.test.ts` | Unit tests for the tax formatter | Create |
| `scripts/check-dates.ts` | Regression guard: ban inline `'u-ca-buddhist'` + bare-locale date APIs in `src/` | Create |
| `package.json` | Add `check:dates` script; wire pre-push | Modify |
| `.husky/pre-push` | Add `check:dates` | Modify |
| `src/app/(staff)/admin/credit-notes/page.tsx` | admin CN list — use `formatTaxDocDate` | Modify |
| `src/app/(staff)/admin/credit-notes/[creditNoteId]/page.tsx` | admin CN detail — use `formatTaxDocDate` | Modify |
| `src/app/(member)/portal/credit-notes/[creditNoteId]/page.tsx` | portal CN — use `formatTaxDocDate` | Modify |
| `src/app/(staff)/admin/invoices/_components/invoice-table.tsx` | admin invoices list — format issue/due via `formatLocalisedDate` (the visible fix) | Modify |
| `src/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx` | bare-locale → `getDateFormatLocale` | Modify |
| `src/app/(staff)/admin/invoices/[invoiceId]/page.tsx` | DRY: local `formatDate` → `formatLocalisedDate` | Modify |
| ~12 inline-`th-TH-u-ca-buddhist` sites (broadcast ×8, members ×2, relative-time ×2, renewals/[cycleId], admin/broadcasts/[id]) | replace inline ternary → `getDateFormatLocale` | Modify |

---

## Task 1: Extend `getDateFormatLocale` (sv→'sv-SE') + unit tests

**Files:**
- Modify: `src/lib/format-date-localised.ts:18-23`
- Test: `tests/unit/lib/format-date-localised.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/lib/format-date-localised.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { getDateFormatLocale, formatLocalisedDate } from '@/lib/format-date-localised';

describe('getDateFormatLocale', () => {
  it('maps th → th-TH-u-ca-buddhist', () => {
    expect(getDateFormatLocale('th')).toBe('th-TH-u-ca-buddhist');
    expect(getDateFormatLocale('th-TH')).toBe('th-TH-u-ca-buddhist');
  });
  it('maps sv → sv-SE', () => {
    expect(getDateFormatLocale('sv')).toBe('sv-SE');
    expect(getDateFormatLocale('sv-SE')).toBe('sv-SE');
  });
  it('passes en through unchanged', () => {
    expect(getDateFormatLocale('en')).toBe('en');
  });
});

describe('formatLocalisedDate', () => {
  const iso = '2026-05-29T00:00:00.000Z';
  it('renders the Buddhist-Era year for th (2569, Arabic numerals)', () => {
    const out = formatLocalisedDate(iso, 'th', { year: 'numeric', month: 'short', day: 'numeric' });
    expect(out).toContain('2569'); // BE = 2026 + 543
    expect(out).not.toContain('๒๕๖๙'); // Arabic digits, not Thai digits (no -nu-thai)
  });
  it('renders Gregorian for en', () => {
    const out = formatLocalisedDate(iso, 'en', { year: 'numeric', month: 'short', day: 'numeric' });
    expect(out).toContain('2026');
  });
  it('sv output is identical to bare-sv (no regression from sv→sv-SE)', () => {
    const opts: Intl.DateTimeFormatOptions = { dateStyle: 'medium' };
    const d = new Date(iso);
    const viaHelper = formatLocalisedDate(iso, 'sv', opts);
    const bareSv = new Intl.DateTimeFormat('sv', opts).format(d);
    expect(viaHelper).toBe(bareSv);
  });
  it('returns — for an invalid date', () => {
    expect(formatLocalisedDate('not-a-date', 'en')).toBe('—');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/lib/format-date-localised.test.ts`
Expected: FAIL — `getDateFormatLocale('sv')` returns `'sv'` (the sv test fails); other tests may pass.

- [ ] **Step 3: Implement the sv mapping**

In `src/lib/format-date-localised.ts`, change `getDateFormatLocale` (and update the JSDoc) to:

```ts
export function getDateFormatLocale(locale: string): string {
  if (locale === 'th' || locale === 'th-TH') {
    return 'th-TH-u-ca-buddhist';
  }
  if (locale === 'sv' || locale === 'sv-SE') {
    return 'sv-SE';
  }
  return locale;
}
```

Update the function's JSDoc to note: "`sv`/`sv-SE` → `'sv-SE'` (canonical Swedish locale); all other locales pass through."

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/lib/format-date-localised.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm exec eslint src/lib/format-date-localised.ts tests/unit/lib/format-date-localised.test.ts
git add src/lib/format-date-localised.ts tests/unit/lib/format-date-localised.test.ts
git commit -m "feat(dates): extend getDateFormatLocale (sv->sv-SE) + unit tests"
```

---

## Task 2: Add `formatTaxDocDate` util + unit tests

**Files:**
- Create: `src/lib/format-tax-doc-date.ts`
- Test: `tests/unit/lib/format-tax-doc-date.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/lib/format-tax-doc-date.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';

describe('formatTaxDocDate', () => {
  const iso = '2026-05-29'; // bare YYYY-MM-DD

  it('th: Gregorian CE base + exactly one (พ.ศ.) suffix, no double-BE', () => {
    const out = formatTaxDocDate(iso, 'th');
    expect(out).toContain('2026');           // CE base is Gregorian
    expect(out).toContain('(พ.ศ. 2569)');     // BE = 2026 + 543
    expect((out.match(/2569/g) ?? []).length).toBe(1); // BE printed exactly ONCE (no double-BE)
    expect(out).toMatch(/พ\.ค\./);           // Thai month script preserved
  });

  it('en: Gregorian only, no (พ.ศ.)', () => {
    const out = formatTaxDocDate(iso, 'en');
    expect(out).toContain('2026');
    expect(out).not.toContain('พ.ศ.');
  });

  it('sv: Gregorian only, no (พ.ศ.)', () => {
    const out = formatTaxDocDate(iso, 'sv');
    expect(out).toContain('2026');
    expect(out).not.toContain('พ.ศ.');
  });

  it('UTC-pinned: the day does not shift (29th stays 29th)', () => {
    expect(formatTaxDocDate('2026-05-29', 'en')).toContain('29');
    expect(formatTaxDocDate('2026-01-01', 'en')).toContain('1'); // Jan 1 stays Jan 1
  });

  it('CE↔BE invariant: BE year = CE year + 543', () => {
    for (const y of [2024, 2025, 2026, 2027]) {
      const out = formatTaxDocDate(`${y}-06-15`, 'th');
      expect(out).toContain(`(พ.ศ. ${y + 543})`);
      expect(out).toContain(String(y));
    }
  });

  it('returns the raw string for a malformed date', () => {
    expect(formatTaxDocDate('nope', 'th')).toBe('nope');
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run tests/unit/lib/format-tax-doc-date.test.ts`
Expected: FAIL — module `@/lib/format-tax-doc-date` does not exist.

- [ ] **Step 3: Implement the formatter**

Create `src/lib/format-tax-doc-date.ts`:

```ts
/**
 * Thai tax-document date formatter (credit-notes; matches the invoice
 * PDF intent). Renders `CE + (พ.ศ. year+543)` for `th`, Gregorian-only
 * for en/sv. Distinct from the GENERAL `formatLocalisedDate` because:
 *   - input is a bare `YYYY-MM-DD` (not an ISO timestamp) → parsed via
 *     `Date.UTC` + rendered with `timeZone: 'UTC'` so the day never
 *     shifts across server-UTC vs Asia/Bangkok;
 *   - the CE base is FORCED to the Gregorian calendar
 *     (`'th-TH-u-ca-gregory'`) so the BE year can never double-print
 *     ("29 พ.ค. 2569 (พ.ศ. 2569)") on an ICU build whose bare-`'th'`
 *     default calendar is buddhist.
 * BE is display-only; storage stays UTC Gregorian (CLAUDE.md).
 */
export function formatTaxDocDate(isoDate: string, locale: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!year || !month || !day) return isoDate;

  const isThai = locale === 'th' || locale === 'th-TH';
  // CE base: force Gregorian. For th keep Thai month script via
  // 'th-TH-u-ca-gregory'; en/sv use their own locale (Gregorian default).
  const ce = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(
    isThai ? 'th-TH-u-ca-gregory' : locale,
    { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' },
  );
  return isThai ? `${ce} (พ.ศ. ${year + 543})` : ce;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run tests/unit/lib/format-tax-doc-date.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Typecheck + commit**

```bash
pnpm exec eslint src/lib/format-tax-doc-date.ts tests/unit/lib/format-tax-doc-date.test.ts
git add src/lib/format-tax-doc-date.ts tests/unit/lib/format-tax-doc-date.test.ts
git commit -m "feat(dates): formatTaxDocDate (Gregorian CE base + UTC-pin + single BE suffix)"
```

---

## Task 3: Point all 3 credit-note surfaces at `formatTaxDocDate`

**Files:**
- Modify: `src/app/(staff)/admin/credit-notes/page.tsx` (local `formatIssueDate` ~62-76)
- Modify: `src/app/(staff)/admin/credit-notes/[creditNoteId]/page.tsx` (local `formatIssueDate` ~74-90)
- Modify: `src/app/(member)/portal/credit-notes/[creditNoteId]/page.tsx` (local `formatIssueDate` ~57-77)

> **NOTE:** This is the legal-sensitive task — request a `thai-tax-compliance-auditor` review at the end (before the next task).

- [ ] **Step 1: Replace each local `formatIssueDate` with a call to the shared util**

In each of the 3 files: delete the local `function formatIssueDate(...)` body and replace all call sites `formatIssueDate(cn.issueDate, locale)` (or equivalent) with `formatTaxDocDate(cn.issueDate, userLocale)`. Add the import:

```ts
import { formatTaxDocDate } from '@/lib/format-tax-doc-date';
```

Read each file first to confirm the exact local-function name, its call sites, and the in-scope locale variable name (`locale` / `userLocale`). For the portal file, also DELETE the now-stale comment block (~63-70) that says "ICU already renders BE — do NOT append (พ.ศ.)" — that assumption is the bug being fixed. For the admin files, the prior `${ce} (พ.ศ. ...)` logic is now inside `formatTaxDocDate` (with the Gregorian fix) — remove the local duplicate.

- [ ] **Step 2: Verify output by reasoning + a render check**

Confirm (read the changed JSX) that every credit-note issue-date now flows through `formatTaxDocDate`. Expected rendered output for `th`: `"29 พ.ค. 2026 (พ.ศ. 2569)"` (single BE). For `en`/`sv`: Gregorian only.

- [ ] **Step 3: Typecheck + i18n + commit**

```bash
pnpm exec eslint "src/app/(staff)/admin/credit-notes/page.tsx" "src/app/(staff)/admin/credit-notes/[creditNoteId]/page.tsx" "src/app/(member)/portal/credit-notes/[creditNoteId]/page.tsx"
# Typecheck via temp tsconfig excluding .next (dev server makes plain typecheck unreliable):
printf '{\n  "extends": "./tsconfig.json",\n  "compilerOptions": { "incremental": false, "noEmit": true },\n  "include": ["src", "tests"],\n  "exclude": [".next", "node_modules"]\n}\n' > tsconfig.dt.json && npx tsc -p tsconfig.dt.json ; rm -f tsconfig.dt.json
git add "src/app/(staff)/admin/credit-notes/page.tsx" "src/app/(staff)/admin/credit-notes/[creditNoteId]/page.tsx" "src/app/(member)/portal/credit-notes/[creditNoteId]/page.tsx"
git commit -m "fix(dates): credit-notes use formatTaxDocDate (consistent CE+BE, no double-BE)"
```

- [ ] **Step 4: thai-tax-compliance review**

Dispatch `thai-tax-compliance-auditor` on this commit: confirm consistent CE+(พ.ศ.) across admin list/detail + portal, Gregorian CE base, no double-BE, UTC-pin (no day-shift), BE-display-only. Address any finding before proceeding.

---

## Task 4: `check:dates` regression guard

**Files:**
- Create: `scripts/check-dates.ts`
- Modify: `package.json` (add `check:dates`)
- Modify: `.husky/pre-push` (add the gate)

- [ ] **Step 1: Implement the scanner**

Create `scripts/check-dates.ts` (mirror the structure of an existing `scripts/check-*.ts` — read one first for the file-walk + exit-code convention):

```ts
/**
 * check:dates — guards the Thai-BE date standardization.
 * Fails if display code under src/ reintroduces a banned date pattern:
 *   - an inline `'...u-ca-buddhist'` calendar literal, or
 *   - a date Intl API (toLocaleDateString/toLocaleString/Intl.DateTimeFormat)
 *     called with a BARE locale instead of getDateFormatLocale(...).
 * Allow-list: the two canonical helpers themselves.
 */
import { readFileSync } from 'node:fs';
import { globSync } from 'glob';

const ALLOW = [
  'src/lib/format-date-localised.ts',
  'src/lib/format-tax-doc-date.ts',
];
const files = globSync('src/**/*.{ts,tsx}', { nodir: true }).filter(
  (f) => !ALLOW.some((a) => f.replace(/\\/g, '/').endsWith(a)),
);

const violations: string[] = [];
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (line.includes('u-ca-buddhist')) {
      violations.push(`${file}:${i + 1} inline 'u-ca-buddhist' — use getDateFormatLocale()`);
    }
    // bare-locale date Intl call: a date API whose first arg is the variable `locale`
    // (not wrapped in getDateFormatLocale / a tax-doc-gregory literal).
    if (/\.(toLocaleDateString|toLocaleString)\(\s*locale\b/.test(line) ||
        /new Intl\.DateTimeFormat\(\s*locale\b/.test(line)) {
      violations.push(`${file}:${i + 1} bare-locale date API — wrap with getDateFormatLocale(locale)`);
    }
  });
}

if (violations.length) {
  console.error('[check:dates] FAIL — banned date patterns:\n' + violations.join('\n'));
  process.exit(1);
}
console.log(`[check:dates] OK — ${files.length} files scanned, no banned date patterns.`);
```

(If `glob` is not already a dependency, use the same directory-walk helper the existing `check:*` scripts use — read `scripts/check-layout.ts` or similar to match the project's file-enumeration approach + its tsx run command.)

- [ ] **Step 2: Wire the script**

In `package.json` scripts add: `"check:dates": "tsx scripts/check-dates.ts"` (match how sibling `check:*` scripts are invoked — some use `tsx`, confirm). In `.husky/pre-push`, add a `pnpm check:dates` line alongside the other `check:*` gates.

- [ ] **Step 3: Run it — expect violations (the not-yet-migrated sites)**

Run: `pnpm check:dates`
Expected: FAIL, listing the ~14 inline + bare-locale sites still to migrate (Tasks 5–10). This proves the guard works. Do NOT commit a green guard yet — it goes green as Tasks 5–10 land. Commit the script now (it will fail in CI until the migrations land, so land Tasks 5–10 in the same PR/push).

- [ ] **Step 4: Commit the guard**

```bash
git add scripts/check-dates.ts package.json .husky/pre-push
git commit -m "chore(dates): add check:dates regression guard (banned date patterns)"
```

---

## Task 5: Admin invoices list — format issue/due dates (the visible fix)

**Files:**
- Modify: `src/app/(staff)/admin/invoices/_components/invoice-table.tsx:504-505`

The table is a client component receiving `r.issueDate`/`r.dueDate` as raw ISO strings (`string | null`). Format them at render via the client `useLocale` + `formatLocalisedDate`, matching the detail page's `{year:'numeric', month:'short', day:'numeric'}` style.

- [ ] **Step 1: Add imports + locale**

At the top of `invoice-table.tsx`, add:

```ts
import { useLocale } from 'next-intl';
import { formatLocalisedDate } from '@/lib/format-date-localised';
```

Inside the component body (near the existing `useTranslations` call), add:

```ts
const locale = useLocale();
```

- [ ] **Step 2: Format the two cells**

Replace lines 504-505:

```tsx
<TableCell className="align-middle whitespace-nowrap">{r.issueDate ?? '—'}</TableCell>
<TableCell className="align-middle whitespace-nowrap">{r.dueDate ?? '—'}</TableCell>
```

with:

```tsx
<TableCell className="align-middle whitespace-nowrap">
  {r.issueDate ? formatLocalisedDate(r.issueDate, locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
</TableCell>
<TableCell className="align-middle whitespace-nowrap">
  {r.dueDate ? formatLocalisedDate(r.dueDate, locale, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'}
</TableCell>
```

- [ ] **Step 3: Verify**

Run: `pnpm exec eslint "src/app/(staff)/admin/invoices/_components/invoice-table.tsx"` (clean).
Reason: the admin list now renders BE for `th` (e.g. "29 พ.ค. 2569"), matching the detail page + portal list. `null` → "—".

- [ ] **Step 4: Commit**

```bash
git add "src/app/(staff)/admin/invoices/_components/invoice-table.tsx"
git commit -m "fix(dates): format admin invoices list issue/due dates (BE for th, was raw ISO)"
```

---

## Task 6: payment-timeline — bare-locale → helper + comment fix

**Files:**
- Modify: `src/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx` (`formatTimestamp` ~88-113)

- [ ] **Step 1: Write a failing test pinning the BE calendar**

Create `tests/unit/components/invoices/payment-timeline-date.test.ts` (if `formatTimestamp` is module-private, export it for test, or test via a tiny extracted helper — read the file to decide; simplest is to export `formatTimestamp`):

```ts
import { describe, it, expect } from 'vitest';
import { formatTimestamp } from '@/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline';

describe('payment-timeline formatTimestamp', () => {
  it('renders the BE year for th (explicit, not ICU-default)', () => {
    const out = formatTimestamp(new Date('2026-05-29T03:00:00.000Z'), 'th');
    expect(out).toContain('2569');
  });
});
```

- [ ] **Step 2: Run — expect fail or pass depending on ICU**

Run: `pnpm vitest run tests/unit/components/invoices/payment-timeline-date.test.ts`
Expected: may PASS on a buddhist-default ICU or FAIL otherwise — either way we make it explicit next.

- [ ] **Step 3: Route through the helper + remove the stale comment**

In `payment-timeline.tsx`: import `getDateFormatLocale` from `@/lib/format-date-localised`; in `formatTimestamp`, change `date.toLocaleString(locale, {…})` → `date.toLocaleString(getDateFormatLocale(locale), {…})`. DELETE the stale comment (~88-99) claiming the bare-locale "false positive on Node 22" — it now reads through the explicit helper. Export `formatTimestamp` if needed for the test.

- [ ] **Step 4: Run the test — pass**

Run: `pnpm vitest run tests/unit/components/invoices/payment-timeline-date.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(staff)/admin/invoices/[invoiceId]/_components/payment-timeline.tsx" tests/unit/components/invoices/payment-timeline-date.test.ts
git commit -m "fix(dates): payment-timeline uses getDateFormatLocale (explicit BE) + drop stale comment"
```

---

## Task 7: DRY — admin invoice-detail `formatDate` → `formatLocalisedDate`

**Files:**
- Modify: `src/app/(staff)/admin/invoices/[invoiceId]/page.tsx` (local `formatDate` ~113-123 + its call sites)

> Portal `invoices/_utils/format.ts` `formatDate` is intentionally NOT changed (it already consumes `getDateFormatLocale`, and intentionally does NOT pin UTC — keep as a thin local wrapper). Only the admin invoice-detail local `formatDate` is consolidated here.

- [ ] **Step 1: Replace the local function with the shared helper**

The local `formatDate(iso, locale)` does `if (!iso) return '—'; return new Date(iso).toLocaleDateString(getDateFormatLocale(locale), { year:'numeric', month:'short', day:'numeric' });`. This is byte-identical to `formatLocalisedDate(iso, locale, { year:'numeric', month:'short', day:'numeric' })` (which returns `'—'` on invalid + handles the calendar). Delete the local `formatDate`; import `formatLocalisedDate` from `@/lib/format-date-localised`; replace each `formatDate(x, userLocale)` call with `formatLocalisedDate(x ?? '', userLocale, { year:'numeric', month:'short', day:'numeric' })`. (Confirm the `null` handling matches: `formatLocalisedDate('', …)` → invalid → `'—'`, same as the old `if (!iso)`.)

- [ ] **Step 2: Verify no visible change**

Run: `pnpm exec eslint "src/app/(staff)/admin/invoices/[invoiceId]/page.tsx"`.
Reason: rendered output unchanged (same calendar + options). Existing admin invoice-detail tests stay green.

- [ ] **Step 3: Commit**

```bash
git add "src/app/(staff)/admin/invoices/[invoiceId]/page.tsx"
git commit -m "refactor(dates): admin invoice-detail uses shared formatLocalisedDate (DRY)"
```

---

## Task 8: relative-time ×2 — inline → helper

**Files:**
- Modify: `src/components/ui/relative-time.tsx:~126-139` (`formatAbsolute`)
- Modify: `src/lib/relative-time.ts:~73`

- [ ] **Step 1: Swap the inline mapping (both files)**

In each, replace the inline ternary that builds the BCP-47 locale (`locale === 'th' ? 'th-TH-u-ca-buddhist' : locale === 'sv' ? 'sv-SE' : locale` in the component; `locale === 'th' ? 'th-TH-u-ca-buddhist' : locale` in the lib) with `getDateFormatLocale(locale)` (import from `@/lib/format-date-localised`). The component already mapped `sv→'sv-SE'` (now via the helper — no change); the lib version previously passed `sv` through bare → now `'sv-SE'` (an intended improvement, no visible difference per the sv no-regression test in Task 1).

- [ ] **Step 2: Run the relative-time tests**

Run: `pnpm vitest run tests/unit -t "relative" 2>&1 | grep -iE "Tests |FAIL"` (or the specific relative-time test files if present).
Expected: PASS (absolute fallback unchanged; relative output untouched).

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/relative-time.tsx src/lib/relative-time.ts
git commit -m "refactor(dates): relative-time absolute fallback uses getDateFormatLocale"
```

---

## Task 9: members ×2 — inline → helper

**Files:**
- Modify: `src/components/members/timeline-event-item.tsx:~62` (local `formatLocalisedTimestamp`)
- Modify: `src/components/members/archived-banner.tsx:~90`

- [ ] **Step 1: Swap the inline mapping (both files)**

In each, replace `const bcp47 = locale === 'th' ? 'th-TH-u-ca-buddhist' : locale;` with `const bcp47 = getDateFormatLocale(locale);` (import from `@/lib/format-date-localised`). Keep each site's existing `Intl.DateTimeFormat`/`toLocaleString` options unchanged. (`timeline-event-item` target is its local `formatLocalisedTimestamp` function.)

- [ ] **Step 2: Verify**

Run: `pnpm exec eslint src/components/members/timeline-event-item.tsx src/components/members/archived-banner.tsx`.
Reason: no visible change (already BE); pure DRY + now sv→sv-SE via helper.

- [ ] **Step 3: Commit**

```bash
git add src/components/members/timeline-event-item.tsx src/components/members/archived-banner.tsx
git commit -m "refactor(dates): members timeline + archived-banner use getDateFormatLocale"
```

---

## Task 10: broadcast ×8 + renewals/[cycleId] + admin/broadcasts/[id] — inline → helper

**Files (replace the inline `th-TH-u-ca-buddhist` ternary with `getDateFormatLocale(locale)` in each; import from `@/lib/format-date-localised`; keep each site's existing options/timeZone):**
- `src/components/broadcast/quota-banner.ts:64`
- `src/components/broadcast/schedule-picker.tsx:54` (keep `dateStyle:'long'`, `timeStyle:'short'`, `timeZone:'Asia/Bangkok'`)
- `src/components/broadcast/admin/template-library.tsx:79`
- `src/components/broadcast/admin/batch-breakdown.tsx:137`
- `src/components/broadcast/admin/approve-dialog.tsx:226`
- `src/components/broadcast/admin/queue-table.tsx:50`
- `src/components/broadcast/admin/halt-state-banner.tsx:38`
- `src/components/broadcast/admin/audit-timeline.tsx:73`
- `src/app/(staff)/admin/renewals/[cycleId]/page.tsx:51`
- `src/app/(staff)/admin/broadcasts/[id]/page.tsx:77`

> Mechanical, identical transform per site. Each currently computes a BCP-47 locale string via `locale === 'th' ? 'th-TH-u-ca-buddhist' : locale` (sometimes named `resolvedLocale`/`bcp47`); replace the RHS with `getDateFormatLocale(locale)`. Where a site both computes the inline locale AND immediately uses it (e.g. `batch-breakdown`, `template-library`), only the locale-resolution line changes. No visible change (already BE).

- [ ] **Step 1: Apply the swap to all 10 files**

Read each line, replace the inline ternary RHS with `getDateFormatLocale(locale)`, add the import if missing. Remove any now-unused local resolution variable only if it becomes a trivial alias.

- [ ] **Step 2: Run `check:dates` — now GREEN**

Run: `pnpm check:dates`
Expected: PASS — all banned patterns gone (this is the moment the Task-4 guard goes green).

- [ ] **Step 3: Lint + typecheck the batch**

Run: `pnpm exec eslint <the 10 files>` (clean). Then the temp-tsconfig typecheck (as in Task 3 Step 3).

- [ ] **Step 4: Commit**

```bash
git add src/components/broadcast/ "src/app/(staff)/admin/renewals/[cycleId]/page.tsx" "src/app/(staff)/admin/broadcasts/[id]/page.tsx"
git commit -m "refactor(dates): migrate broadcast/renewals/broadcasts inline-BE to getDateFormatLocale"
```

---

## Task 11: Full gate + push

- [ ] **Step 1: Run the full local gate**

```bash
pnpm lint && pnpm check:i18n && pnpm check:dates && pnpm vitest run tests/unit/lib tests/unit/components/invoices tests/unit/portal
# + temp-tsconfig typecheck (excl .next), non-incremental
```
Expected: all green; `check:dates` OK; helper + tax-doc + payment-timeline tests pass.

- [ ] **Step 2: Browser spot-check (dev :3100, do not restart)**

Sign in (admin creds in `.env.local`): `/admin/invoices` list shows BE dates for th; `/admin/credit-notes` + a credit-note detail show `"… 2026 (พ.ศ. 2569)"` (single BE). Sign in (member): `/portal/credit-notes/<id>` shows the same CE+(พ.ศ.). 0 console errors.

- [ ] **Step 3: Push + open PR**

```bash
git push -u origin 061-date-standardization
gh pr create --base main --title "Thai-BE date-display standardization" --body-file <generated>
```
PR body: summarize the helper extension, formatTaxDocDate, the migrations, the guard; flag the thai-tax-compliance review on the credit-note commit; note the visible changes (admin list BE; portal credit-note gains (พ.ศ.)).

---

## Self-review (writing-plans checklist)

**Spec coverage:** §3.1 helper → Task 1 ✓ · §3.2 general migrations → Tasks 5,6,8,9,10 ✓ · §3.3 DRY → Task 7 (+ portal kept, noted) ✓ · §3.4 tax-doc → Tasks 2+3 ✓ · §3.5 guard → Task 4 ✓ · §3.6 tests → Tasks 1,2,6 + §11 gate ✓ · §6 sequencing → task order ✓. No gaps.

**Placeholder scan:** every code step shows actual code; commands have expected output; the mechanical Task-10 transform names every file + the exact pattern (not "similar to"). The `check-dates.ts` glob/walk has a fallback instruction to match the repo's existing `check:*` enumeration — the engineer reads one sibling script first.

**Type consistency:** `getDateFormatLocale(locale: string): string` + `formatLocalisedDate(iso, locale, options?)` + `formatTaxDocDate(isoDate: string, locale: string): string` used consistently across all tasks; credit-notes call `formatTaxDocDate`, general surfaces call `getDateFormatLocale`/`formatLocalisedDate`.

**Open verification for the implementer (read before each task):** confirm the exact current line numbers + local-function/variable names per site (they drift); confirm `check:dates` enumeration matches a sibling `scripts/check-*.ts`; confirm whether `formatTimestamp` needs exporting for its test.
