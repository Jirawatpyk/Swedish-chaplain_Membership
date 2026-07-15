# Member Import — Real-Sheet Extension (PR-C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the Stage-3 member importer to consume TSCC's real 150-row
`Member Data New` sheet — mapping entity-type/VAT (Task 7), the extra directory
fields, and a correctly-anchored renewal cycle — plus ship Task 9 (the conditional
Tax-ID asterisk).

**Architecture:** Reuse the existing pure importer pipeline
(`columns → validate → commit`). Add a fail-loud entity-type coercer, new header
aliases, tax-id leading-zero repair, and extra member fields; the renewal cycle
anchors on column G (Membership Start) so `periodTo` = column K (Renewal date).
Member data only — no F4 invoice/receipt documents.

**Tech Stack:** TypeScript 5.7 strict · Node 22 · `xlsx@0.18.5` · Drizzle + Neon ·
Vitest · Result<T,E> · the F3 value objects (email/phone/tax-id/country) and the
PR-A `@/modules/members` barrel (`LEGAL_ENTITY_TYPES`, `VAT_DEFAULT_BY_CODE`).

**Spec:** `docs/superpowers/specs/2026-07-15-member-import-sheet-extension-design.md`.

**Branch:** `060-member-tax-id-required`.

**Gate:** tax + security sign-off, ≥2 reviewers (touches the tax-document data path).

## Global Constraints

- **Package manager is `pnpm`, never `npm`. Zero new npm dependencies.**
- **Never run `prettier --write`** — the repo is ~80-col hand-formatted; a format
  run reflows whole files and destroys the diff.
- **TDD** (Principle II): write the failing test, RUN it, confirm it fails for the
  stated reason, then implement.
- **`pnpm typecheck` is NOT in the pre-push hook.** Run
  `npx tsc -p tsconfig.tsccheck.json --noEmit` as the final gate before each commit.
- **Read `pnpm lint` past "0 errors"** — a clean run is `0 problems`; warnings matter.
- **Never `git add -A`** (untracked PII lives under `docs/import/`, `docs/uat/`,
  `public/brand/*.png`). Add explicit paths only. The workbook
  `docs/import/*.xlsx` is gitignored PII — never commit it.
- The **workbook is gitignored PII**; the written report is PII-free (counts +
  row indices only). The user runs the dev server on :3100 — never start/kill it.
- Verified facts (measured 2026-07-15 against the real sheet): 113/113 12-digit TH
  tax IDs pass the RD checksum after left-padding `0`; `THAILAND`→TH / `SWEDEN`→SE
  resolve; K = G + 12 months on 150/150 rows.

---

### Task 1: The entity-type coercer (Task 7 core)

**Files:**
- Create: `scripts/import-members/entity-type.ts`
- Test: `tests/unit/scripts/import-members-entity-type.test.ts`

**Interfaces:**
- Consumes: `isLegalEntityTypeCode`, `LegalEntityTypeCode` from `@/modules/members`.
- Produces:
  `coerceLegalEntityType(raw: string): Result<LegalEntityTypeCode | null, EntityTypeResolveError>`
  where `EntityTypeResolveError = { readonly code: 'entityType.unmapped'; readonly raw: string }`.
  Tasks 4 + 6 consume it.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/scripts/import-members-entity-type.test.ts`:

```ts
/**
 * Stage-3 importer — entity-type coercer (Task 7). Maps TSCC's `Member Type`
 * column → LegalEntityTypeCode; fail-loud on an unmapped value.
 */
import { describe, expect, it } from 'vitest';

const { coerceLegalEntityType } = await import('@/../scripts/import-members/entity-type');

describe('coerceLegalEntityType', () => {
  it('does NOT confuse the Member Type "Individual" with the Plan "Individual"', () => {
    // `Individual` appears in TWO columns of TSCC's sheet with unrelated meanings:
    // Member Type = บุคคลธรรมดา (legal form) and Plan = the Individual package.
    // This coercer must only ever see the Member Type column.
    const r = coerceLegalEntityType('Individual');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBe('individual');
  });

  it('maps every value present in the TSCC sheet', () => {
    const cases: ReadonlyArray<[string, string | null]> = [
      ['Private Limited Company (Company Limited)', 'limited_company'],
      ['State Enterprise', 'state_enterprise'],
      ['Public Limited Company', 'public_company'],
      ['Foundation', 'foundation'],
      ['N/A', null],
      ['', null],
    ];
    for (const [raw, expected] of cases) {
      const r = coerceLegalEntityType(raw);
      expect(r.ok, `"${raw}" should resolve`).toBe(true);
      if (r.ok) expect(r.value).toBe(expected);
    }
  });

  it('FAILS LOUD on an unmapped value', () => {
    // A silent NULL is exactly how the §86/4 branch line came to be missing from
    // every invoice. An unknown Member Type stops the row.
    const r = coerceLegalEntityType('Sole Proprietorship Ltd');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('entityType.unmapped');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/unit/scripts/import-members-entity-type.test.ts`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the coercer**

Create `scripts/import-members/entity-type.ts`:

```ts
/**
 * Stage-3 importer — TSCC `Member Type` column → LegalEntityTypeCode.
 *
 * Fail-loud on any unmapped value (mirrors `countryNameToCode` in coerce.ts): a
 * silent NULL is how the §86/4 branch line came to be missing from every invoice.
 * blank / "N/A" → ok(null) (the 10 TSCC rows whose legal form is unrecorded).
 *
 * IMPORTANT: this must only ever see the `Member Type` column. `Individual` ALSO
 * appears in the `Plan` column with an unrelated meaning — feeding the Plan
 * column here mis-assigns the entity type. Pure + framework-free (spec § 8).
 */
import { err, ok, type Result } from '@/lib/result';
import {
  isLegalEntityTypeCode,
  type LegalEntityTypeCode,
} from '@/modules/members';

export type EntityTypeResolveError = {
  readonly code: 'entityType.unmapped';
  readonly raw: string;
};

/** Excel display name (normalized) → canonical code. Only the values that appear
 *  in the real sheet plus a few obvious variants. */
const DISPLAY_NAME_TO_CODE: Readonly<Record<string, LegalEntityTypeCode>> = {
  'private limited company (company limited)': 'limited_company',
  'private limited company': 'limited_company',
  'company limited': 'limited_company',
  'limited company': 'limited_company',
  'public limited company': 'public_company',
  'public company limited': 'public_company',
  'state enterprise': 'state_enterprise',
  individual: 'individual',
  foundation: 'foundation',
  association: 'association',
};

/** Blank-equivalent cells → ok(null) (legal_entity_type stays NULL). */
const BLANK_ALIASES: ReadonlySet<string> = new Set(['', 'n/a', 'na', '-', 'none']);

function normalize(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

export function coerceLegalEntityType(
  raw: string,
): Result<LegalEntityTypeCode | null, EntityTypeResolveError> {
  const norm = normalize(raw);
  if (BLANK_ALIASES.has(norm)) return ok(null);
  // 1. Already a canonical code? ("limited_company")
  if (isLegalEntityTypeCode(norm)) return ok(norm);
  // 2. A known display name?
  const byName = DISPLAY_NAME_TO_CODE[norm];
  if (byName) return ok(byName);
  return err({ code: 'entityType.unmapped', raw });
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm vitest run tests/unit/scripts/import-members-entity-type.test.ts`
Expected: PASS.
Run: `npx tsc -p tsconfig.tsccheck.json --noEmit`
Expected: exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/import-members/entity-type.ts tests/unit/scripts/import-members-entity-type.test.ts
git commit -m "feat(import): entity-type coercer for TSCC Member Type column

Maps the 6 real Member Type values → LegalEntityTypeCode (blank/N/A → null),
fail-loud on anything unmapped. Only ever reads the Member Type column — never
the Plan column, which also carries an unrelated 'Individual' value."
```

---

### Task 2: Tax-ID leading-zero repair + status coercer

**Files:**
- Modify: `scripts/import-members/coerce.ts` (append two exported helpers)
- Test: `tests/unit/scripts/import-members-coerce.test.ts` (extend)

**Interfaces:**
- Produces:
  `normalizeTaxIdCell(raw: string, country: string): string` and
  `coerceMemberStatus(raw: string): 'active' | 'inactive' | null`.
  Task 4 consumes both.

- [ ] **Step 1: Write the failing tests**

Append to `tests/unit/scripts/import-members-coerce.test.ts`. First extend the
import destructure at the top of the file:

```ts
const {
  isGregorianYear, countryNameToCode, parseGregorianDate, coercePreferredLanguage,
  normalizeTaxIdCell, coerceMemberStatus,
} = await import('@/../scripts/import-members/coerce');
```

Then add these `describe` blocks:

```ts
describe('normalizeTaxIdCell — restore the Excel-stripped leading zero (TH)', () => {
  it('left-pads a 12-digit TH tax id to 13 (Excel ate the leading 0)', () => {
    expect(normalizeTaxIdCell('105562087242', 'TH')).toBe('0105562087242');
  });
  it('passes a already-13-digit TH tax id through', () => {
    expect(normalizeTaxIdCell('0105562087242', 'TH')).toBe('0105562087242');
  });
  it('strips separators before padding a TH value', () => {
    expect(normalizeTaxIdCell('1-0556-20872-42', 'TH')).toBe('0105562087242');
  });
  it('treats N/A / dash / blank as empty (absent, not invalid)', () => {
    for (const raw of ['N/A', 'n/a', '-', '', '   ']) {
      expect(normalizeTaxIdCell(raw, 'TH')).toBe('');
    }
  });
  it('leaves a foreign (non-TH) tax id untouched', () => {
    expect(normalizeTaxIdCell('SE556677889901', 'SE')).toBe('SE556677889901');
  });
  it('does NOT pad a TH value that is neither 12 nor 13 digits (asTaxId errors loud)', () => {
    expect(normalizeTaxIdCell('123', 'TH')).toBe('123');
  });
});

describe('coerceMemberStatus (TSCC Member Status column)', () => {
  it('maps Active/Inactive case-insensitively', () => {
    expect(coerceMemberStatus('Active')).toBe('active');
    expect(coerceMemberStatus(' inactive ')).toBe('inactive');
  });
  it('returns null for unknown/blank (caller defaults to active + warns)', () => {
    expect(coerceMemberStatus('')).toBeNull();
    expect(coerceMemberStatus('archived')).toBeNull();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/unit/scripts/import-members-coerce.test.ts`
Expected: FAIL — `normalizeTaxIdCell` / `coerceMemberStatus` are not exported.

- [ ] **Step 3: Add the helpers**

Append to `scripts/import-members/coerce.ts`:

```ts
/** Cells that mean "no tax id" in TSCC's sheet. */
const BLANK_TAX_ALIASES: ReadonlySet<string> = new Set(['', 'n/a', 'na', '-', 'none']);

/**
 * Normalize a `Tax ID` cell. For a Thai member, restore the leading zero Excel
 * stripped: 113 of the sheet's tax IDs arrive as 12 digits because Excel stored
 * "0105562087242" as the number 105562087242. Left-pad TH 12-digit values to 13
 * (verified: all 113 pass the RD checksum after padding). "N/A" / "-" / blank →
 * '' (caller treats an empty tax_id as absent, not invalid). A non-TH value
 * passes through untouched — foreign formats vary, and asTaxId only length-checks
 * them. A TH value that is neither 12 nor 13 digits is returned as-is so asTaxId
 * rejects it LOUD rather than being silently mangled.
 *
 * `country` is the resolved ISO alpha-2 (passed as a plain string — this is an
 * internal importer helper).
 */
export function normalizeTaxIdCell(raw: string, country: string): string {
  const trimmed = raw.trim();
  if (BLANK_TAX_ALIASES.has(trimmed.toLowerCase())) return '';
  if (country === 'TH') {
    const digits = trimmed.replace(/\D/g, '');
    if (digits.length === 12) return `0${digits}`;
    if (digits.length === 13) return digits;
  }
  return trimmed;
}

export type MemberStatusValue = 'active' | 'inactive';

/**
 * Coerce the TSCC `Member Status` cell → members.status. Active→'active',
 * Inactive→'inactive'. Unknown/blank → null (the caller defaults to 'active' and
 * warns — never silently mis-states a member's standing). `archived` is NOT a
 * value this import produces (archival is a deliberate admin action).
 */
export function coerceMemberStatus(raw: string): MemberStatusValue | null {
  const v = raw.trim().toLowerCase();
  if (v === 'active') return 'active';
  if (v === 'inactive') return 'inactive';
  return null;
}
```

- [ ] **Step 4: Run the test + typecheck**

Run: `pnpm vitest run tests/unit/scripts/import-members-coerce.test.ts`
Expected: PASS.
Run: `npx tsc -p tsconfig.tsccheck.json --noEmit` — exit 0.

- [ ] **Step 5: Commit**

```bash
git add scripts/import-members/coerce.ts tests/unit/scripts/import-members-coerce.test.ts
git commit -m "feat(import): tax-id leading-zero repair + member-status coercer

TH tax IDs arrive 12-digit (Excel ate the leading 0); left-pad to 13 (113/113
pass the RD checksum). N/A/dash/blank → empty. coerceMemberStatus maps the
Member Status column; unknown → null so the caller defaults + warns."
```

---

### Task 3: RawRow + column mapping (aliases, the alias move, new fields)

**Files:**
- Modify: `scripts/import-members/validate.ts` — the `RawRow` interface (add 8 fields)
- Modify: `scripts/import-members/columns.ts` — `HEADER_ALIASES` (move `member type`
  off `tier`, add the new fields + real-sheet aliases) + `mapDataRows` wiring
- Test: `tests/unit/scripts/import-members-columns.test.ts` (extend)

**Interfaces:**
- Produces: `RawRow` gains `legalEntityType`, `status`, `website`, `foundedYear`,
  `registeredCapital`, `description`, `addressLine1`, `addressLine2` (all
  `readonly string`). Task 4 consumes them.

- [ ] **Step 1: Add the new fields to `RawRow`**

In `scripts/import-members/validate.ts`, add to the `RawRow` interface (after
`companyName`, keep grouped sensibly):

```ts
  readonly legalEntityType: string;
  readonly status: string;
  readonly website: string;
  readonly foundedYear: string;
  readonly registeredCapital: string;
  readonly description: string;
  readonly addressLine1: string;
  readonly addressLine2: string;
```

`Field = keyof Omit<RawRow, 'rowIndex'>` in columns.ts, so `HEADER_ALIASES` now
fails to typecheck until every new field has an alias entry — that is the next
step and is the intended forcing function.

- [ ] **Step 2: Write the failing columns test**

Extend `tests/unit/scripts/import-members-columns.test.ts` — add the real-sheet
header fixture + assertions:

```ts
// The real "Member Data New" headers (cols A..AE; trailing empty cols omitted).
const TSCC_HEADERS = [
  'Name', 'Code', 'Company', 'Tax ID', 'Member Type',
  'Latest Invoice No.', 'Latest INV Date\n(Membership Start)', 'Invoice Status',
  'Receipt No.', 'Receipt Date\n(Payment Date)', 'Renewal date',
  'Country (ISO post)', 'Webiste', 'Founded year', 'Annual Turnover (THB)',
  'Capital registeration', 'Description', 'Note (Admin only)', 'Plan',
  'Member Status', 'Registration date', 'Plan Year (Current)', 'Member In 2025',
  'Postal code', 'Province / State', 'City / Distrct', 'Address Line 1',
  'Address Line 2', 'First name (Primary contact)', 'Last name (Primary contact)',
  'Email (Primary contact)',
];

describe('buildColumnMap — real TSCC "Member Data New" sheet', () => {
  it('resolves the real headers with no missing required column', () => {
    const m = buildColumnMap(TSCC_HEADERS);
    expect(m.missingRequired).toEqual([]);
    expect(m.index.companyName).toBe(2);       // C Company
    expect(m.index.legalEntityType).toBe(4);   // E Member Type
    expect(m.index.tier).toBe(18);             // S Plan (NOT E)
    expect(m.index.country).toBe(11);          // L Country (ISO post)
    expect(m.index.turnover).toBe(14);         // O Annual Turnover (THB)
    expect(m.index.registeredCapital).toBe(15);// P Capital registeration
    expect(m.index.website).toBe(12);          // M Webiste (typo header)
    expect(m.index.foundedYear).toBe(13);      // N Founded year
    expect(m.index.description).toBe(16);      // Q Description
    expect(m.index.status).toBe(19);           // T Member Status
    expect(m.index.registrationDate).toBe(6);  // G — NOT the empty U (col 20)
    expect(m.index.postalCode).toBe(23);       // X
    expect(m.index.province).toBe(24);         // Y Province / State
    expect(m.index.city).toBe(25);             // Z City / Distrct (typo header)
    expect(m.index.addressLine1).toBe(26);     // AA
    expect(m.index.addressLine2).toBe(27);     // AB
    expect(m.index.contactEmail).toBe(30);     // AE Email (Primary contact)
    expect(m.fullNameIndex).toBe(0);           // A Name (contact-name fallback)
  });

  it('does not let "Member Type" collide with tier (trap #3)', () => {
    const m = buildColumnMap(['Company', 'Member Type', 'Plan', 'Country', 'Registration Date', 'Email']);
    expect(m.index.legalEntityType).toBe(1);
    expect(m.index.tier).toBe(2); // Plan — NOT Member Type
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run tests/unit/scripts/import-members-columns.test.ts`
Expected: FAIL — new fields unmapped / `member type` still resolves to tier.

- [ ] **Step 4: Update `HEADER_ALIASES` + `mapDataRows`**

In `scripts/import-members/columns.ts`, replace `HEADER_ALIASES` with (note
`member type` is REMOVED from `tier` and lives on `legalEntityType`):

```ts
const HEADER_ALIASES: Readonly<Record<Field, readonly string[]>> = {
  companyName: ['company name', 'company', 'organisation', 'organization', 'member', 'member name'],
  legalEntityType: ['member type', 'entity type', 'legal entity type', 'entity', 'legal form'],
  country: ['country', 'nation', 'country iso post'],
  taxId: ['tax id', 'tax number', 'tin', 'vat', 'taxpayer id', 'tax id no', 'tax id number', 'vat number'],
  tier: ['membership tier', 'tier', 'plan', 'membership', 'package', 'membership type'],
  turnover: ['turnover', 'annual turnover', 'revenue', 'annual revenue', 'annual turnover thb'],
  registeredCapital: ['capital registeration', 'capital registration', 'registered capital', 'registered capital thb'],
  website: ['website', 'webiste', 'web site', 'url'],
  foundedYear: ['founded year', 'founded', 'year founded', 'established'],
  description: ['description', 'about', 'business description'],
  registrationDate: ['registration date', 'registered', 'join date', 'member since', 'date joined', 'registered date', 'latest inv date membership start', 'membership start'],
  memberLocale: ['member locale', 'company language', 'locale'],
  status: ['member status', 'status'],
  city: ['city', 'town', 'city distrct', 'city district'],
  province: ['province', 'state', 'region', 'province state'],
  postalCode: ['postal code', 'postcode', 'zip', 'zip code', 'post code'],
  addressLine1: ['address line 1', 'address 1', 'address', 'street address'],
  addressLine2: ['address line 2', 'address 2'],
  contactFirstName: ['first name', 'firstname', 'given name', 'contact first name', 'first name primary contact'],
  contactLastName: ['last name', 'lastname', 'surname', 'family name', 'contact last name', 'last name primary contact'],
  contactEmail: ['email', 'e mail', 'email address', 'contact email', 'email primary contact'],
  contactPhone: ['phone', 'mobile', 'tel', 'telephone', 'phone number', 'contact phone', 'mobile no', 'mobile number', 'tel no'],
  contactRole: ['role', 'title', 'position', 'job title', 'designation'],
  contactLanguage: ['language', 'preferred language', 'contact language'],
  isPrimary: ['primary', 'primary contact', 'is primary', 'main contact'],
};
```

Then add the new fields to the `out.push({…})` object in `mapDataRows` (after the
matching existing lines):

```ts
      legalEntityType: at(row, map.index.legalEntityType),
      status: at(row, map.index.status),
      website: at(row, map.index.website),
      foundedYear: at(row, map.index.foundedYear),
      registeredCapital: at(row, map.index.registeredCapital),
      description: at(row, map.index.description),
      addressLine1: at(row, map.index.addressLine1),
      addressLine2: at(row, map.index.addressLine2),
```

**Note on `registrationDate` (col G vs the empty col U):** the sheet has both
`Latest INV Date (Membership Start)` (col 6) and an empty `Registration date`
(col 20). `buildColumnMap` returns the FIRST header matching an alias, and col 6
matches the new `latest inv date membership start` alias before col 20 is reached,
so G wins. If the pick were ever wrong, every row would fail `date.empty` at
validate — a loud, immediate signal.

- [ ] **Step 5: Run the columns test + the existing suite for this file**

Run: `pnpm vitest run tests/unit/scripts/import-members-columns.test.ts`
Expected: PASS (both new + all existing cases).

- [ ] **Step 6: Commit**

```bash
git add scripts/import-members/columns.ts scripts/import-members/validate.ts \
        tests/unit/scripts/import-members-columns.test.ts
git commit -m "feat(import): map the real TSCC sheet headers + 8 new RawRow fields

Move 'member type' off tier onto the new legalEntityType field (else tier
mis-grabs the entity-type column). Add aliases for the real headers
(Country (ISO post), Email (Primary contact), Latest INV Date (Membership
Start), etc.) + fields for entity type, status, website, founded year,
registered capital, description, address lines."
```

---

### Task 4: `validate.ts` — typed output, entity-type/VAT, tax-id repair, status, extras

**Files:**
- Modify: `scripts/import-members/validate.ts` — `ValidatedMember` + the parse loop
- Test: `tests/unit/scripts/import-members-validate.test.ts` (extend + fix `row()` factory)

**Interfaces:**
- Consumes: `coerceLegalEntityType` (Task 1), `normalizeTaxIdCell` +
  `coerceMemberStatus` (Task 2), `VAT_DEFAULT_BY_CODE` + `LegalEntityTypeCode`
  (barrel).
- Produces: `ValidatedMember` gains `legalEntityType: LegalEntityTypeCode | null`,
  `isVatRegistered: boolean`, `status: 'active' | 'inactive'`, `website`,
  `foundedYear`, `registeredCapitalThb`, `description`, `addressLine1`,
  `addressLine2` (last six `… | null`). Task 5 consumes them.

- [ ] **Step 1: Fix the existing `row()` factory (unblocks the suite)**

In `tests/unit/scripts/import-members-validate.test.ts`, the `row()` factory
(≈line 18) returns a `RawRow`; add defaults for the 8 new fields so it still
compiles:

```ts
    legalEntityType: over.legalEntityType ?? '',
    status: over.status ?? '',
    website: over.website ?? '',
    foundedYear: over.foundedYear ?? '',
    registeredCapital: over.registeredCapital ?? '',
    description: over.description ?? '',
    addressLine1: over.addressLine1 ?? '',
    addressLine2: over.addressLine2 ?? '',
```

- [ ] **Step 2: Write the failing tests**

Add to `tests/unit/scripts/import-members-validate.test.ts`. `RESOLVER` already
maps `Premium`→`premium` (company scope); reuse it:

```ts
describe('validateRows — entity type + VAT + status + tax-id repair (PR-C)', () => {
  it('derives is_vat_registered = default && has TIN (TH limited company)', () => {
    const r = validateRows(
      [row({ rowIndex: 2, country: 'TH', taxId: '105562087242', legalEntityType: 'Private Limited Company (Company Limited)' })],
      RESOLVER,
    );
    expect(r.stats.errorCount).toBe(0);
    const m = r.members[0]!;
    expect(m.legalEntityType).toBe('limited_company');
    expect(m.taxId).toBe('0105562087242'); // leading zero restored
    expect(m.isVatRegistered).toBe(true);
  });

  it('a State Enterprise with NO tax id is is_vat_registered=false (invariant-safe)', () => {
    // 7 TSCC state enterprises have no TIN. VAT_DEFAULT_BY_CODE.state_enterprise
    // is true, but without a TIN the registrant⇒TIN invariant would reject them —
    // so the flag is gated on actually having a number.
    const r = validateRows(
      [row({ rowIndex: 2, country: 'TH', taxId: 'N/A', legalEntityType: 'State Enterprise' })],
      RESOLVER,
    );
    expect(r.stats.errorCount).toBe(0);
    const m = r.members[0]!;
    expect(m.legalEntityType).toBe('state_enterprise');
    expect(m.taxId).toBeNull();
    expect(m.isVatRegistered).toBe(false);
  });

  it('foundation warns for manual VAT confirmation (no safe default)', () => {
    const r = validateRows(
      [row({ rowIndex: 2, country: 'TH', taxId: '', legalEntityType: 'Foundation' })],
      RESOLVER,
    );
    expect(r.members).toHaveLength(1);
    expect(r.members[0]!.isVatRegistered).toBe(false);
    expect(r.issues.some((i) => i.field === 'legalEntityType' && i.code === 'vat_default_unknown_confirm')).toBe(true);
  });

  it('an unmapped Member Type is a per-row error (member excluded)', () => {
    const r = validateRows([row({ rowIndex: 2, legalEntityType: 'Sole Proprietorship Ltd' })], RESOLVER);
    expect(errCodes(r)).toContain('unmapped');
    expect(r.members).toHaveLength(0);
  });

  it('maps Member Status and carries the directory fields', () => {
    const r = validateRows(
      [row({ rowIndex: 2, status: 'Inactive', website: 'https://acme.test', foundedYear: '1995',
             registeredCapital: '5,000,000', description: 'Widgets', addressLine1: '1 Rd', addressLine2: 'Unit 2' })],
      RESOLVER,
    );
    const m = r.members[0]!;
    expect(m.status).toBe('inactive');
    expect(m.website).toBe('https://acme.test');
    expect(m.foundedYear).toBe(1995);
    expect(m.registeredCapitalThb).toBe(5_000_000);
    expect(m.description).toBe('Widgets');
    expect(m.addressLine1).toBe('1 Rd');
    expect(m.addressLine2).toBe('Unit 2');
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run tests/unit/scripts/import-members-validate.test.ts`
Expected: FAIL — `ValidatedMember` has no `legalEntityType`/`isVatRegistered`/etc.

- [ ] **Step 4: Extend `ValidatedMember` + the parse**

In `scripts/import-members/validate.ts`:

Add imports:

```ts
import { coerceLegalEntityType } from './entity-type';
import { normalizeTaxIdCell, coerceMemberStatus } from './coerce';
import { VAT_DEFAULT_BY_CODE, type LegalEntityTypeCode } from '@/modules/members';
```

Add to the `ValidatedMember` interface:

```ts
  readonly legalEntityType: LegalEntityTypeCode | null;
  readonly isVatRegistered: boolean;
  readonly status: 'active' | 'inactive';
  readonly website: string | null;
  readonly foundedYear: number | null;
  readonly registeredCapitalThb: number | null;
  readonly description: string | null;
  readonly addressLine1: string | null;
  readonly addressLine2: string | null;
```

Add a year parser next to `parseTurnover`:

```ts
function parseFoundedYear(raw: string): number | null {
  const t = raw.trim();
  if (t.length === 0) return null;
  const n = Number(t);
  // members.founded_year is a nullable plain integer year. Guard a sane range so
  // a stray turnover / BE / date cell degrades to null (+ warning) instead of
  // storing nonsense.
  return Number.isInteger(n) && n >= 1800 && n <= 2100 ? n : null;
}
```

Inside the `for (const groupRows of groups.values())` loop, after the tier/country
resolution and BEFORE the tax block, resolve the entity type:

```ts
    // Entity type (Task 7). blank/N/A → null; unmapped → per-row error (excludes
    // the member — a wrong legal form must never be guessed).
    const entityTypeRes = coerceLegalEntityType(head.legalEntityType);
    const legalEntityType: LegalEntityTypeCode | null = entityTypeRes.ok
      ? entityTypeRes.value
      : null;
    if (!entityTypeRes.ok) err(head.rowIndex, 'legalEntityType', 'unmapped');
```

Replace the tax block's `const rawTax = head.taxId.trim();` line with the repair:

```ts
      const rawTax = normalizeTaxIdCell(head.taxId, country.value); // pad-13 + N/A→''
```

After `taxId` is resolved, derive the VAT flag + the manual-confirm warning:

```ts
    // 059/PR-A — is_vat_registered = the entity-type DEFAULT, gated on actually
    // having a TIN (the registrant⇒TIN invariant, live on prod, rejects
    // true+null at create). association/foundation have NO safe default → warn.
    const isVatRegistered =
      legalEntityType !== null &&
      VAT_DEFAULT_BY_CODE[legalEntityType] === true &&
      taxId !== null;
    if (legalEntityType !== null && VAT_DEFAULT_BY_CODE[legalEntityType] === null) {
      warn(head.rowIndex, 'legalEntityType', 'vat_default_unknown_confirm');
    }
```

Resolve status + the extra fields (near the other member-level fields):

```ts
    const statusValue = coerceMemberStatus(head.status);
    if (head.status.trim().length > 0 && statusValue === null) {
      warn(head.rowIndex, 'status', 'unknown_status_defaulting_active');
    }
    const status = statusValue ?? 'active';

    const registeredCapitalThb = parseTurnover(head.registeredCapital);
    if (head.registeredCapital.trim().length > 0 && registeredCapitalThb === null) {
      warn(head.rowIndex, 'registeredCapital', 'not_a_number');
    }
    const foundedYear = parseFoundedYear(head.foundedYear);
    if (head.foundedYear.trim().length > 0 && foundedYear === null) {
      warn(head.rowIndex, 'foundedYear', 'not_a_year');
    }
```

Add the new fields to the `members.push({…})` literal:

```ts
        legalEntityType,
        isVatRegistered,
        status,
        website: blankToNull(head.website),
        foundedYear,
        registeredCapitalThb,
        description: blankToNull(head.description),
        addressLine1: blankToNull(head.addressLine1),
        addressLine2: blankToNull(head.addressLine2),
```

- [ ] **Step 5: Run the test + typecheck**

Run: `pnpm vitest run tests/unit/scripts/import-members-validate.test.ts`
Expected: PASS.
Run: `npx tsc -p tsconfig.tsccheck.json --noEmit` — exit 0.

- [ ] **Step 6: Commit**

```bash
git add scripts/import-members/validate.ts tests/unit/scripts/import-members-validate.test.ts
git commit -m "feat(import): entity-type/VAT derivation + tax-id repair + status + extras

is_vat_registered = VAT_DEFAULT_BY_CODE[code]===true && taxId!==null (state
enterprises with no TIN import as false — invariant-safe). Tax id repaired
(leading-zero pad). Member Status → members.status. website/founded year/
registered capital/description/address lines carried through. Foundation/
association warned for manual VAT confirmation."
```

---

### Task 5: The CLI — `--sheet` flag, insert the new columns, status, cycle-for-active-only

**Files:**
- Modify: `scripts/import-members.ts` — `Args` + `parseArgs` + `readWorkbook` +
  `main` (--sheet); the `members` `.values({…})` insert (`:278-295`); cycle guard
- Modify: `tests/integration/scripts/import-members.test.ts` — the `vm()`
  `ValidatedMember` factory (≈line 50) gains the new fields
- Modify: `tests/integration/scripts/import-members-cycles.test.ts` — its
  `ValidatedMember` factory (if separate) gains the new fields
- Test: `tests/unit/scripts/import-members-workbook.test.ts` (extend — `--sheet`)

**Interfaces:**
- Consumes: `ValidatedMember` (Task 4).

- [ ] **Step 1: Add `--sheet` (failing workbook test first)**

Extend `tests/unit/scripts/import-members-workbook.test.ts`:

```ts
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as XLSX from 'xlsx';

it('reads a NAMED sheet when a sheet name is given (not just the first)', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ignore'], ['x']]), 'First');
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([['Company', 'Email'], ['Acme', 'a@b.test']]),
    'Member Data New',
  );
  const file = join(tmpdir(), `import-wb-${process.pid}.xlsx`);
  XLSX.writeFile(wb, file);
  const { headers } = readWorkbook(file, 'Member Data New');
  expect(headers).toEqual(['Company', 'Email']);
});

it('throws a clear error naming available sheets when the sheet is missing', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['a'], ['1']]), 'Only');
  const file = join(tmpdir(), `import-wb-missing-${process.pid}.xlsx`);
  XLSX.writeFile(wb, file);
  expect(() => readWorkbook(file, 'Nope')).toThrow(/not found/);
});
```

(If the test file does not already import `readWorkbook`, add
`const { readWorkbook } = await import('@/../scripts/import-members');` at the top,
matching the existing convention.)

Run: `pnpm vitest run tests/unit/scripts/import-members-workbook.test.ts`
Expected: FAIL — `readWorkbook` takes no sheet-name argument.

- [ ] **Step 2: Implement `--sheet`**

In `scripts/import-members.ts`:

`Args` interface — add:

```ts
  readonly sheet: string | undefined;
```

`parseArgs` return — add:

```ts
    sheet: get('--sheet'),
```

`readWorkbook` — accept an optional sheet name:

```ts
export function readWorkbook(
  file: string,
  sheetName?: string,
): { headers: string[]; dataRows: unknown[][] } {
  const wb = XLSX.readFile(file, { cellDates: true });
  const name = sheetName ?? wb.SheetNames[0];
  if (!name) throw new Error(`workbook has no sheets: ${file}`);
  const ws = wb.Sheets[name];
  if (!ws) {
    throw new Error(
      `sheet "${name}" not found in ${file}. Available: ${wb.SheetNames.join(', ')}`,
    );
  }
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, {
    header: 1,
    blankrows: true,
    defval: '',
  });
  const headers = (aoa[0] ?? []).map((h) => String(h ?? ''));
  return { headers, dataRows: aoa.slice(1) };
}
```

`main` — pass it through:

```ts
  const { headers, dataRows } = readWorkbook(args.file, args.sheet);
```

Also update the usage string in `parseArgs` to mention `[--sheet <name>]`.

Run: `pnpm vitest run tests/unit/scripts/import-members-workbook.test.ts`
Expected: PASS.

- [ ] **Step 3: Update the integration `vm()` factory (unblock typecheck)**

In `tests/integration/scripts/import-members.test.ts`, the `vm()` factory
(≈line 50) builds a `ValidatedMember`; add the new fields:

```ts
    legalEntityType: over.legalEntityType ?? null,
    isVatRegistered: over.isVatRegistered ?? false,
    status: over.status ?? 'active',
    website: over.website ?? null,
    foundedYear: over.foundedYear ?? null,
    registeredCapitalThb: over.registeredCapitalThb ?? null,
    description: over.description ?? null,
    addressLine1: over.addressLine1 ?? null,
    addressLine2: over.addressLine2 ?? null,
```

Do the same in `tests/integration/scripts/import-members-cycles.test.ts` if it has
its own `ValidatedMember` builder. (Run `npx tsc -p tsconfig.tsccheck.json --noEmit`
after — it names every construction site that still misses a field.)

- [ ] **Step 4: Write the new columns + status into the insert**

In `scripts/import-members.ts`, the member `.values({…})` (`:278-295`) — add the
new columns alongside the existing ones:

```ts
      await tx.insert(members).values({
        tenantId: ctx.slug,
        memberId,
        memberNumber,
        companyName: m.companyName,
        legalEntityType: m.legalEntityType,
        isVatRegistered: m.isVatRegistered,
        country: m.country,
        taxId: m.taxId,
        planId: m.planId,
        planYear,
        registrationDate: m.registrationDate.toISOString().slice(0, 10),
        registrationFeePaid: true,
        status: m.status,
        turnoverThb: m.turnoverThb,
        registeredCapitalThb: m.registeredCapitalThb,
        foundedYear: m.foundedYear,
        website: m.website,
        description: m.description,
        city: m.city,
        province: m.province,
        postalCode: m.postalCode,
        addressLine1: m.addressLine1,
        addressLine2: m.addressLine2,
        preferredLocale: m.preferredLocale,
      });
```

- [ ] **Step 5: Create the initial cycle ONLY for active members**

Still in `commitMembers`, wrap the `createCycleInTx` block so an `inactive`
member gets no renewal cycle (kept out of the F8 pipeline):

```ts
      // PR-C — only an ACTIVE member joins the renewal pipeline. An imported
      // inactive member is a directory record only; creating a cycle would
      // resurface it in at-risk / reminder flows.
      if (m.status === 'active') {
        try {
          await createCycleInTx(cycleDeps, tx, {
            tenantId: ctx.slug,
            memberId,
            periodFrom: m.registrationDate.toISOString(),
            planId: m.planId,
            actorUserId,
            actorRole: 'system',
            correlationId: `import-members-${randomUUID()}`,
            anchorToCurrentPeriod: { nowIso: commitNowIso },
          });
          cyclesCreated += 1;
        } catch (e) {
          renewalsMetrics.importCycleCreateFailed.add(1, { tenant_id: ctx.slug });
          console.error(
            `[import-members] cycle creation failed for row ${headRow} ` +
              `(member ${memberId}) — rolling back the whole batch: ` +
              (e instanceof Error ? e.message : String(e)),
          );
          throw e;
        }
      }
```

- [ ] **Step 6: Typecheck + run the importer integration suite (live dev Neon)**

Run: `npx tsc -p tsconfig.tsccheck.json --noEmit` — exit 0.
Run: `pnpm vitest run --config vitest.integration.config.ts tests/integration/scripts/import-members.test.ts tests/integration/scripts/import-members-cycles.test.ts`
Expected: PASS (new columns persist; active member gets a cycle). If it times out
at ~30s, re-run the single file — that is dev-Neon contention, not a failure.

- [ ] **Step 7: Commit**

```bash
git add scripts/import-members.ts tests/unit/scripts/import-members-workbook.test.ts \
        tests/integration/scripts/import-members.test.ts tests/integration/scripts/import-members-cycles.test.ts
git commit -m "feat(import): --sheet flag + persist entity-type/VAT/status/extras + active-only cycle

readWorkbook takes an optional sheet name (the real workbook keeps member data on
the 'Member Data New' sheet, not sheet[0]). The insert now writes legal_entity_type,
is_vat_registered, status, registered_capital, founded_year, website, description,
and address lines. Only an active member gets an initial renewal cycle."
```

---

### Task 6: Report — the entity-type histogram

**Files:**
- Modify: `scripts/import-members/validate.ts` — `ValidationReport` + build the histogram
- Modify: `scripts/import-members/report.ts` — `ReportDocument` + `renderReportText`
- Test: `tests/unit/scripts/import-members-report.test.ts` + the validate test

**Interfaces:**
- Produces: `ValidationReport.entityTypeHistogram: Readonly<Record<string, number>>`
  (counts EVERY member group's coerced entity type — the coercer's verification
  signal, independent of member validity).

- [ ] **Step 1: Write the failing validate test**

Add to `tests/unit/scripts/import-members-validate.test.ts`:

```ts
it('builds an entity-type histogram across all member groups', () => {
  const r = validateRows(
    [
      row({ rowIndex: 2, companyName: 'A Co', contactEmail: 'a@x.test', country: 'TH', taxId: '105562087242', legalEntityType: 'Private Limited Company (Company Limited)' }),
      row({ rowIndex: 3, companyName: 'B Co', contactEmail: 'b@x.test', legalEntityType: 'State Enterprise' }),
      row({ rowIndex: 4, companyName: 'C Co', contactEmail: 'c@x.test', legalEntityType: 'N/A' }),
    ],
    RESOLVER,
  );
  expect(r.entityTypeHistogram['limited_company']).toBe(1);
  expect(r.entityTypeHistogram['state_enterprise']).toBe(1);
  expect(r.entityTypeHistogram['null']).toBe(1);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm vitest run tests/unit/scripts/import-members-validate.test.ts`
Expected: FAIL — `entityTypeHistogram` is not on the report.

- [ ] **Step 3: Build the histogram**

In `validate.ts`: add the accumulator near `tierHistogram`:

```ts
  const entityTypeHistogram: Record<string, number> = {};
```

Right after the entity-type coercion (Task 4, Step 4), record it for every group:

```ts
    {
      const key = entityTypeRes.ok ? (legalEntityType ?? 'null') : 'unmapped';
      entityTypeHistogram[key] = (entityTypeHistogram[key] ?? 0) + 1;
    }
```

Add `entityTypeHistogram` to the `ValidationReport` interface and to the returned
object at the end of `validateRows`.

- [ ] **Step 4: Surface it in the report**

In `report.ts`: add `readonly entityTypeHistogram: Readonly<Record<string, number>>;`
to `ReportDocument`, set it in `buildReportDocument`
(`entityTypeHistogram: args.report.entityTypeHistogram,`), and render it in
`renderReportText` after the tier histogram:

```ts
  lines.push('');
  lines.push('Entity-type histogram (all member groups):');
  for (const [code, n] of Object.entries(doc.entityTypeHistogram).sort()) {
    lines.push(`  ${code}: ${n}`);
  }
```

- [ ] **Step 5: Keep the report test green (PII-free + new field)**

Run: `pnpm vitest run tests/unit/scripts/import-members-report.test.ts tests/unit/scripts/import-members-validate.test.ts`
Expected: PASS. If the report test asserts an exact `ReportDocument` shape, add
`entityTypeHistogram` to its fixture/expectation. The PII-free assertion still
holds (the histogram is codes + counts only).

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc -p tsconfig.tsccheck.json --noEmit` — exit 0.

```bash
git add scripts/import-members/validate.ts scripts/import-members/report.ts \
        tests/unit/scripts/import-members-report.test.ts tests/unit/scripts/import-members-validate.test.ts
git commit -m "feat(import): entity-type histogram in the import report

Counts every member group's coerced entity type (code + count, PII-free) so a
dry-run confirms the coercer against the sheet (expect 111/15/7/5/2 + 10 null)."
```

---

### Task 7: Dry-run against the real sheet (verification, no code)

**Files:** none. This task validates the whole pipeline end-to-end.

- [ ] **Step 1: Run the dry-run (no `--commit`, zero writes)**

```bash
TENANT_SLUG=swecham pnpm tsx scripts/import-members.ts \
  --file "docs/import/Membership Database_Since 2025(Membership 2025-2026)_v2_Excel.xlsx" \
  --sheet "Member Data New" --plan-year 2026
```

If `@/lib/env` refuses to boot against `.env.local`, follow the memory note
`member-import-blocker`: inject a ≥32-char `EXPORT_DOWNLOAD_TOKEN_SECRET` dummy and
a `TSX_TSCONFIG_PATH` that aliases `server-only`. This runs against the **dev**
Neon branch (safe, not prod).

- [ ] **Step 2: Check the report**

Expected in the written report / console:
- **Entity-type histogram:** `limited_company: 111`, `individual: 15`,
  `state_enterprise: 7`, `public_company: 5`, `foundation: 2`, `null: 10`.
- **Valid members ≈ 110–125.** The remainder are reported as errors:
  `country: unresolved` (~19), `tier: unmapped` (~21 — plan N/A/blank, plus any of
  Student(2)/Gold(4)/Platinum(1) not seeded for 2026). These are the **round-2
  backlog** — the operator fixes the sheet + re-runs.
- **Warnings:** `foundation`/`association` rows flagged
  `vat_default_unknown_confirm`; TH companies without a TIN flagged
  `missing_for_company`; ~150 `none_marked_defaulting_first` (one contact/member).
- **No unexpected `taxId.*` errors** — the 113 padded TH IDs must all validate.

- [ ] **Step 3: Record the outcome**

Note the exact valid/error/warning counts in the PR description. Do NOT `--commit`
from this task — a prod import is a separate, gated operator step (deploy checklist:
`SELECT count(*) FROM members WHERE is_head_office=false` = 0, true today).

---

### Task 8: Task 9 — the conditional Tax-ID asterisk (independent)

**Files:**
- Modify: `src/components/members/member-form/sections/company-section.tsx`
- Test: `tests/unit/members/presentation/company-section.test.tsx`

The zod rule already exists (`member-form/schema.ts:425` — a VAT registrant must
have a `tax_id`). This task adds the matching visual + a11y signal: an asterisk
without the rule is a lie; the rule without the asterisk is a save button that
fails for no visible reason.

- [ ] **Step 1: Read the file first**

Read `src/components/members/member-form/sections/company-section.tsx`. Confirm:
`control` is destructured from `useFormContext`; `RequiredMark` is imported
(≈`:21`); the Tax-ID block is ≈`:306-328`; the sibling `company_name`
(≈`:117-128`) and `legal_entity_type` (≈`:279-294`) already pair a `RequiredMark`
with `aria-required` — copy that shape. Adjust the line refs below to what you find.

- [ ] **Step 2: Write the failing test**

Extend `tests/unit/members/presentation/company-section.test.tsx` (render the REAL
`MemberForm` with real `en.json`, per that file's convention). Base UI Checkbox
trap: to toggle VAT you must click `container.querySelector('input#is_vat_registered')`
— the visible `<span role="checkbox">` does NOT drive `onCheckedChange`. Copy the
working pattern from `tax-branch-section.test.tsx`.

```tsx
it('shows a required marker + aria-required on Tax ID ONLY when VAT is registered', async () => {
  // VAT ticked → asterisk + aria-required="true"
  const { container } = renderMemberForm({ initialValues: { is_vat_registered: true } });
  const taxLabel = container.querySelector('label[for="tax_id"]')!;
  expect(taxLabel.textContent).toContain('*');
  expect(container.querySelector('#tax_id')!.getAttribute('aria-required')).toBe('true');
});

it('shows NO required marker on Tax ID when NOT a VAT registrant', () => {
  const { container } = renderMemberForm({ initialValues: { is_vat_registered: false } });
  const taxLabel = container.querySelector('label[for="tax_id"]')!;
  expect(taxLabel.textContent).not.toContain('*');
  expect(container.querySelector('#tax_id')!.getAttribute('aria-required')).toBe('false');
});
```

(Use the test file's existing `renderMemberForm`/render helper name — do not invent
one. If it seeds `initialValues` differently, follow that.)

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm vitest run tests/unit/members/presentation/company-section.test.tsx`
Expected: FAIL — no asterisk / `aria-required` is absent (or null).

- [ ] **Step 4: Implement**

Near the top of the component body (with the other hooks), watch the VAT flag —
`is_vat_registered` lives in the sibling `TaxBranchSection` but both share one
`FormProvider`, so `CompanySection` can read it:

```tsx
  const isVatRegistered =
    useWatch({ control, name: 'is_vat_registered' }) === true;
```

Ensure `useWatch` is imported from `react-hook-form`. In the Tax-ID `<Label
htmlFor="tax_id">`, render the marker conditionally:

```tsx
  <Label htmlFor="tax_id">
    {t('fields.taxId.label')}
    {isVatRegistered && <RequiredMark />}
  </Label>
```

On the Tax-ID `<Input id="tax_id" …>`, add the load-bearing a11y line
(`RequiredMark` is `aria-hidden`, so the asterisk alone is invisible to AT):

```tsx
    aria-required={isVatRegistered}
```

- [ ] **Step 5: Run the test + gates**

Run: `pnpm vitest run tests/unit/members/presentation/company-section.test.tsx`
Expected: PASS.
Run: `npx tsc -p tsconfig.tsccheck.json --noEmit` — exit 0.
Run: `pnpm lint` — `0 problems`.
Run: `pnpm check:i18n` — pass.

- [ ] **Step 6: Commit**

```bash
git add src/components/members/member-form/sections/company-section.tsx \
        tests/unit/members/presentation/company-section.test.tsx
git commit -m "feat(members): conditional Tax-ID required marker (Task 9)

The Tax-ID field shows a RequiredMark + aria-required only when the VAT-registered
box is ticked — matching the zod rule at schema.ts:425. A permanent asterisk
would lie to the 37/150 TSCC members with no TIN (individuals, state enterprises,
foundations)."
```

---

## Final gate (before opening the PR)

```bash
pnpm lint && npx tsc -p tsconfig.tsccheck.json --noEmit && pnpm check:i18n \
  && pnpm check:layout && pnpm check:fixme
pnpm vitest run tests/unit/scripts/ tests/unit/members/presentation/company-section.test.tsx
pnpm vitest run --config vitest.integration.config.ts tests/integration/scripts/
```

Then the dry-run (Task 7) once more, and paste its counts into the PR body.

**Open the PR** against `main`: state that it changes the tax-document data path
(`legal_entity_type` + `is_vat_registered` + `tax_id`) and requires **tax +
security sign-off, ≥2 reviewers**. Reviewers: `thai-tax-compliance-auditor` (the
VAT-flag derivation), `senior-tester` / `chamber-os-qa-engineer` (the fixture
traps — any 13-digit test TIN MUST pass the real check digit).

## Self-review notes

- **Spec coverage:** column mapping → Tasks 3+5; entity-type/VAT (Task 7) → Tasks
  1+4; tax-id pad-13 → Tasks 2+4; anchor=G / cycle → Task 5 (no code change to the
  anchor — G flows through `registration_date` into the existing
  `anchorToCurrentPeriod` path); N/A skip+report → existing fail-loud (verified in
  Task 7); status + inactive-no-cycle → Tasks 4+5; extra directory fields → Tasks
  3+4+5; Task 9 asterisk → Task 8; dry-run acceptance → Tasks 6+7.
- **Out of scope (confirmed):** F4 invoice/receipt document import; the round-2
  N/A rows; Tasks 6 (passport guards) and 8 (Art. 14 attestation) from the PR-A
  plan — separate residuals.
- **Type consistency:** `legalEntityType: LegalEntityTypeCode | null`,
  `isVatRegistered: boolean`, `status: 'active' | 'inactive'`,
  `registeredCapitalThb`/`foundedYear`: `number | null` — used identically in
  RawRow (string), ValidatedMember (typed), the `vm()`/`row()` factories, and the
  insert. `normalizeTaxIdCell(raw, country: string)` — plain string param so tests
  pass `'TH'`/`'SE'` directly.
- **Ordering (load-bearing):** 1 → 2 → 3 → 4 → 5 → 6 → 7. Task 3 breaks the
  validate `row()` factory (Task 4 Step 1 fixes it) and Task 5 breaks the `vm()`
  factory (Task 5 Step 3 fixes it) — both are the intended typecheck forcing
  functions. Task 8 (asterisk) is independent and may run any time.
