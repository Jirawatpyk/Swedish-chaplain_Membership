# Member Form — PR-A: Tax Correctness — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the §86/4 buyer particulars on a Thai tax invoice correct — the buyer's "สำนักงานใหญ่ / สาขาที่ NNNNN" line, which **no member has ever received**, because it is derived from a `legal_entity_type` column that is NULL on every row.

**Architecture:** Replace a *guess* with a *recorded fact*. `is_vat_registered` becomes a real column, set deliberately (by the importer from TSCC's sheet, or by an admin on the form) instead of inferred from the legal form — which is wrong in law (VAT registration is a function of turnover, not of entity type) and wrong in practice (TSCC is itself a VAT-registered association). All four consumers of the old guess are re-pointed at the column, the `registrant ⇒ TIN` pairing that ประกาศ 196 + 199 require is enforced at four layers, and three guards close the paths by which a foreign member's identifier would otherwise leak onto a tax document or survive an erasure.

**Tech Stack:** TypeScript 5.7 strict · Next.js 16 · Drizzle + Neon Postgres · zod · react-hook-form · next-intl · `@react-pdf/renderer` · Vitest + live-Neon integration.

**Spec:** `docs/superpowers/specs/2026-07-13-member-form-redesign-design.md` (v3) §§ 4–8 and § 16. **§ 16 supersedes anything it contradicts in §§ 1–15.**

**Branch:** `059-member-tax-correctness`, off `main` at `896deef2` (PR-B merged).

**Gate:** **Tax + security sign-off, ≥2 reviewers.** This PR changes what is printed on a legal tax document.

---

## Global Constraints

- **Package manager is `pnpm`, never `npm`.**
- **Zero new npm dependencies** (Constitution X).
- **Never run `prettier --write`.** `.prettierrc` says `printWidth: 100`; the committed code is ~80 columns and no gate enforces it — a format run reflows whole files and destroys the diff.
- **TDD is NON-NEGOTIABLE** (Principle II): write the failing test, RUN it, confirm it fails *for the stated reason*, then implement.
- **i18n**: every new key in **all three** of `en.json` / `th.json` / `sv.json` with a real translation. `pnpm check:i18n` verifies **presence only** — it will not catch English left in the Swedish file.
- **`members` is EMPTY.** Production was wiped 2026-07-12. **There is no backfill.** Migrations add columns and stop.
- **Integration tests hit the live `dev` Neon branch** via `.env.local`. Single file: `pnpm vitest run --config vitest.integration.config.ts <path>`
- **`pnpm typecheck` is not in the pre-push hook.** Run `npx tsc -p tsconfig.tsccheck.json --noEmit` as the final gate.
- **E2E** needs a dev server on :3100 that the **user** owns. Never start or kill one.
- Conventional Commits.

### Three traps that will bite you

1. **`member-identity-adapter.ts:93` casts with `as unknown as Array<{…}>`.** The type-checker is blind in *both* directions: adding a column to the row type without adding it to **both** raw SELECTs compiles and silently yields `undefined` at runtime; adding it to the SELECTs without the row type also compiles. **Only the live-Neon integration test catches this.**
2. **`updateMemberSchema` is `.strict()`** (`update-member.ts:60`). Any new wire field is rejected with a 400 `invalid_body` until declared there. **`createMemberSchema` is neither `.strict()` nor `.superRefine()`-ed, and has no branch fields at all** — create currently cannot set head-office/branch.
3. **The i18n resolver fails soft.** `resolveLegalEntityTypeLabel` (`[memberId]/page.tsx:184-195`) does `tTypes.has(key) ? tTypes(key) : trimmed` — a code with no matching key renders as **raw snake_case** on the member page, with no error and no failing test. **You must reuse the 11 keys that already ship** (`en.json:1117-1129`): `company · limited_company · public_company · partnership · sole_proprietor · individual · foundation · association · government · branch · representative_office`.

---

## File Structure

**New:**
- `src/modules/members/domain/value-objects/legal-entity-type.ts` — the catalogue: codes + `VAT_DEFAULT_BY_CODE`. Pure; no labels (those live in i18n).
- `src/components/members/legal-entity-type-label.tsx` — the shared resolver, lifted out of the admin page so the portal can reuse it.
- `drizzle/migrations/0246_members_is_vat_registered.sql`
- `drizzle/migrations/0247_members_branch_requires_vat_registrant.sql`
- `drizzle/migrations/0248_contacts_art14_attestation.sql`
- `scripts/import-members/entity-type.ts` — the Excel `Member Type` → code coercer.

**Modified:** `schema-members.ts` · `schema-contacts.ts` · `member.ts` (domain) · `contact.ts` (domain) · `drizzle-member-repo.ts` · `drizzle-contact-repo.ts` · `member-repo.ts` · `contact-repo.ts` · `create-member.ts` · `update-member.ts` · `contact-crud.ts` · `_serialise.ts` · `member-identity-adapter.ts` · `member-identity-snapshot.ts` · `document-kind.ts` · `invoice-template.tsx` · `issue-review.ts` · `issue-invoice-form.tsx` · `[invoiceId]/page.tsx` · `member-form/schema.ts` · `company-section.tsx` · `tax-branch-section.tsx` · `secondary-contact-section.tsx` · `contact-form-dialog.tsx` · `[memberId]/page.tsx` · `portal/profile/page.tsx` · `logger.ts` · `scrub-pii-column-coverage.test.ts` · `columns.ts` · `validate.ts` · `import-members.ts` · the three locale files.

**Deleted:** `src/lib/legal-entity.ts` (and its test) — once all four consumers are re-pointed, the guess must not survive anywhere. Leaving it is how it gets called again.

---

### Task 1: The entity-type catalogue

The codes are the vocabulary everything else keys off. Get them wrong and the member page silently prints raw snake_case.

**Files:**
- Create: `src/modules/members/domain/value-objects/legal-entity-type.ts`
- Modify: `src/modules/members/index.ts` (barrel export)
- Modify: `src/i18n/messages/{en,th,sv}.json` — **one** new key
- Test: `tests/unit/members/domain/legal-entity-type.test.ts`

**Interfaces:**
- Produces:
```ts
export const LEGAL_ENTITY_TYPES: readonly LegalEntityTypeCode[];
export type LegalEntityTypeCode =
  | 'company' | 'limited_company' | 'public_company' | 'partnership'
  | 'sole_proprietor' | 'individual' | 'foundation' | 'association'
  | 'government' | 'branch' | 'representative_office' | 'state_enterprise';
export function isLegalEntityTypeCode(v: unknown): v is LegalEntityTypeCode;
/** `true` / `false` = a defensible default the admin may override.
 *  `null` = NO safe default exists; the admin must decide. */
export const VAT_DEFAULT_BY_CODE: Readonly<Record<LegalEntityTypeCode, boolean | null>>;
```
  Tasks 2, 3, 5, 7 and 9 consume these.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/members/domain/legal-entity-type.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import enMessages from '@/i18n/messages/en.json';
import thMessages from '@/i18n/messages/th.json';
import svMessages from '@/i18n/messages/sv.json';
import {
  LEGAL_ENTITY_TYPES,
  VAT_DEFAULT_BY_CODE,
  isLegalEntityTypeCode,
} from '@/modules/members/domain/value-objects/legal-entity-type';

describe('legal entity type catalogue', () => {
  it('every code resolves to a label in all three locales', () => {
    // The resolver in [memberId]/page.tsx falls back to the RAW stored string on
    // a miss — no error, no failing test. So a code with no key ships as
    // `limited_company` printed literally on the member page. This is the only
    // test that catches it.
    for (const messages of [enMessages, thMessages, svMessages]) {
      const labels = messages.admin.members.detail.legalEntityTypes as Record<
        string,
        string
      >;
      for (const code of LEGAL_ENTITY_TYPES) {
        expect(labels[code], `missing label for "${code}"`).toBeTruthy();
      }
    }
  });

  it('association, foundation and government have NO VAT default', () => {
    // VAT registration is a function of turnover (>1.8M THB/yr, พ.ร.ฎ. 432),
    // not of legal form. TSCC is ITSELF a VAT-registered association — a `false`
    // default here would under-print the §86/4 line on the members most like the
    // chamber itself. Force the admin to choose.
    expect(VAT_DEFAULT_BY_CODE.association).toBeNull();
    expect(VAT_DEFAULT_BY_CODE.foundation).toBeNull();
  });

  it('a natural person can still be a VAT registrant', () => {
    // §77/1 defines ผู้ประกอบการ to include natural persons. A sole proprietor
    // above the threshold MUST register. So the default is false, but it is only
    // a default — never a rule.
    expect(VAT_DEFAULT_BY_CODE.sole_proprietor).toBe(false);
    expect(VAT_DEFAULT_BY_CODE.individual).toBe(false);
  });

  it('juristic trading forms default to registrant', () => {
    expect(VAT_DEFAULT_BY_CODE.limited_company).toBe(true);
    expect(VAT_DEFAULT_BY_CODE.public_company).toBe(true);
    expect(VAT_DEFAULT_BY_CODE.state_enterprise).toBe(true);
  });

  it('offices barred from earning revenue default to non-registrant', () => {
    expect(VAT_DEFAULT_BY_CODE.representative_office).toBe(false);
    expect(VAT_DEFAULT_BY_CODE.government).toBe(false);
  });

  it('rejects an unknown code', () => {
    expect(isLegalEntityTypeCode('limited_company')).toBe(true);
    expect(isLegalEntityTypeCode('sole_proprietorship')).toBe(false); // near-miss
    expect(isLegalEntityTypeCode('')).toBe(false);
    expect(isLegalEntityTypeCode(null)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/members/domain/legal-entity-type.test.ts
```

Expected: FAIL — the module does not exist.

- [ ] **Step 3: Write the catalogue**

Create `src/modules/members/domain/value-objects/legal-entity-type.ts`:

```ts
/**
 * The closed vocabulary for `members.legal_entity_type`.
 *
 * **These codes are NOT free to rename.** They are the i18n keys that already
 * ship at `admin.members.detail.legalEntityTypes` (`en.json:1117-1129`), and the
 * resolver (`[memberId]/page.tsx:184-195`) falls back to the RAW stored string
 * on a miss — silently. Invent `sole_proprietorship` where the shipped key says
 * `sole_proprietor` and the member page prints the snake_case code, with no
 * error and no failing test.
 *
 * `state_enterprise` is the ONE new key. TSCC has 7 such members.
 */
export const LEGAL_ENTITY_TYPES = [
  'company',
  'limited_company',
  'public_company',
  'partnership',
  'sole_proprietor',
  'individual',
  'foundation',
  'association',
  'government',
  'branch',
  'representative_office',
  'state_enterprise',
] as const;

export type LegalEntityTypeCode = (typeof LEGAL_ENTITY_TYPES)[number];

export function isLegalEntityTypeCode(v: unknown): v is LegalEntityTypeCode {
  return (
    typeof v === 'string' &&
    (LEGAL_ENTITY_TYPES as readonly string[]).includes(v)
  );
}

/**
 * The VAT-registrant DEFAULT for a newly-picked entity type. It seeds the
 * checkbox; it is never a rule, and it is never consulted after the fact —
 * `members.is_vat_registered` is the only source of truth.
 *
 * `null` = there is NO safe default; the admin must decide.
 *
 * Verified against rd.go.th primary text (spec § 16.6):
 *   - VAT registration is a function of TURNOVER (>1.8M THB/yr — พ.ร.ฎ. ฉบับที่
 *     432 under §81/1), not of legal form. §77/1 defines ผู้ประกอบการ to include
 *     natural persons, so a sole proprietor above the threshold MUST register.
 *   - §81(1) contains no exemption by STATUS. Only §81(1)(ธ) exempts certain
 *     religious/charitable ACTIVITIES. **TSCC is itself a chamber of commerce —
 *     an association — and IS VAT-registered.** So "non-profit ⇒ not registered"
 *     is false, and a `false` default here would under-print the §86/4 line on
 *     exactly the members most like the chamber itself.
 *   - `cooperative` is deliberately ABSENT from the catalogue: TSCC has none, and
 *     research found no safe default (savings co-ops' interest falls under §91
 *     specific business tax; agricultural co-ops are exempt under §81(1)(ก) for
 *     UNPROCESSED produce only; a co-op selling VATable goods above the threshold
 *     must register). Add it only when a real member needs it — with a `null`.
 */
export const VAT_DEFAULT_BY_CODE: Readonly<
  Record<LegalEntityTypeCode, boolean | null>
> = {
  // Juristic trading forms — a registrant unless below the 1.8M threshold.
  company: true,
  limited_company: true,
  public_company: true,
  partnership: true,
  branch: true, // Thai branch of a foreign company: earns revenue, holds its own ภ.พ.20
  state_enterprise: true, // a separate juristic person; NOT covered by the §81(1)(ท) exemption

  // Natural persons — below the threshold by default, but see §77/1 above.
  sole_proprietor: false,
  individual: false,

  // Legally barred from earning revenue in Thailand (they still hold a TIN for
  // withholding tax). Inferred from §77/1-§77/2, not a direct RD ruling — so the
  // admin can override.
  representative_office: false,

  // §81(1)(ท) exempts ministries/departments remitting all receipts to the state.
  government: false,

  // NO DEFAULT. See the docblock above — TSCC is one of these.
  association: null,
  foundation: null,
};
```

- [ ] **Step 4: Add the one new i18n key**

`admin.members.detail.legalEntityTypes` sits at line **1117** in **all three** message files (they are line-aligned). Add `state_enterprise` to each, after `representative_office`:

`en.json`: `"state_enterprise": "State enterprise"`
`th.json`: `"state_enterprise": "รัฐวิสาหกิจ"`
`sv.json`: `"state_enterprise": "Statligt bolag"`

- [ ] **Step 5: Export from the members barrel**

Add to `src/modules/members/index.ts`:

```ts
export {
  LEGAL_ENTITY_TYPES,
  VAT_DEFAULT_BY_CODE,
  isLegalEntityTypeCode,
  type LegalEntityTypeCode,
} from './domain/value-objects/legal-entity-type';
```

The invoicing adapter imports members through this barrel (`member-identity-adapter.ts:23`), so this is the sanctioned path across the module boundary.

- [ ] **Step 6: Run the tests**

```bash
pnpm vitest run tests/unit/members/domain/legal-entity-type.test.ts
pnpm check:i18n
```

Expected: both PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/members/domain/value-objects/legal-entity-type.ts \
        src/modules/members/index.ts src/i18n/messages/ \
        tests/unit/members/domain/legal-entity-type.test.ts
git commit -m "feat(members): the legal-entity-type catalogue + VAT defaults

The 12 codes REUSE the 11 i18n keys that already ship — the label resolver
falls back to the raw stored string on a miss, so a renamed code would print
snake_case on the member page with no error and no failing test.
state_enterprise is the one new key (TSCC has 7).

association and foundation have NO VAT default. VAT registration is a
function of turnover (พ.ร.ฎ. 432), not of legal form, and TSCC is itself a
VAT-registered association — a false default would under-print the §86/4 line
on the members most like the chamber itself."
```

---

### Task 2: `is_vat_registered` — column, domain, repo

**Files:**
- Create: `drizzle/migrations/0246_members_is_vat_registered.sql`
- Modify: `drizzle/migrations/meta/_journal.json`
- Modify: `src/modules/members/infrastructure/db/schema-members.ts` (after `branchCode`, line 66)
- Modify: `src/modules/members/domain/member.ts` (the `Member` type)
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` — `rowToMember`, `applyMemberPatch`, `createWithPrimaryContactInTx`'s `.values({…})`, and `scrubPiiInTx`'s `.set({…})`
- Modify: `src/modules/members/application/ports/member-repo.ts` — the `MemberPatch` `Pick<>`
- Modify: `src/app/api/members/_serialise.ts`
- Modify: `tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts`
- Test: `tests/integration/members/create-member.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `members.is_vat_registered` (`boolean NOT NULL DEFAULT false`), Drizzle prop `isVatRegistered`, `Member.isVatRegistered: boolean`. Tasks 3–9 consume it.

- [ ] **Step 1: Classify it in the scrub coverage test (the failing test)**

`tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts` partitions every `members` column into `SCRUBBED ∪ KEPT` from the **live Drizzle table** and fails the build on an unclassified one. Add to `SCRUBBED`, next to `isHeadOffice` / `branchCode` (~line 46):

```ts
    // §86/4 business quasi-identifier, same class as isHeadOffice/branchCode.
    // Reset to its DEFAULT (false) on erasure, not NULL — the column is NOT NULL,
    // and `false` is also what keeps the tightened branch-pairing CHECK satisfied
    // (a non-registrant cannot be a branch).
    'isVatRegistered',
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts
```

Expected: FAIL on the **stale-entry** assertion — `isVatRegistered` is classified but does not exist on the table yet. That is the correct red: it proves the test reads the live schema.

- [ ] **Step 3: Write the migration**

Create `drizzle/migrations/0246_members_is_vat_registered.sql`, following `0232_members_branch_fields.sql`:

```sql
-- 059 / PR-A — the §86/4 VAT-registrant flag, recorded rather than guessed.
--
-- Today the "is this buyer a VAT registrant?" question is answered by
-- `isVatRegistrantEntityType(legal_entity_type)` — i.e. "anything that is not
-- the literal string 'individual'". That is wrong in law and wrong in fact:
--
--   * VAT registration is a function of TURNOVER (>1.8M THB/yr — พ.ร.ฎ. ฉบับที่
--     432 under §81/1), not of legal form. §77/1 defines ผู้ประกอบการ to include
--     natural persons, so a sole proprietor above the threshold MUST register —
--     the guess under-prints for them.
--   * §81(1) exempts no one by STATUS. TSCC is itself a chamber of commerce (an
--     association) and IS VAT-registered — the guess would have to be right about
--     the chamber's own peers, and it is not.
--
-- And because `legal_entity_type` is NULL on every row (the importer never wrote
-- it), the guess currently returns false for EVERYONE — so no member has ever
-- received the mandatory "สำนักงานใหญ่ / สาขาที่ NNNNN" particular (ประกาศอธิบดีฯ
-- ฉบับที่ 199) on a tax invoice.
--
-- NO BACKFILL: `members` is empty (prod wiped 2026-07-12). The importer sets this
-- column from TSCC's sheet at import time — see scripts/import-members/.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS), pattern from 0232. RLS: `members` is
-- per-tenant row-level; the new column inherits the existing policy.
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "is_vat_registered" boolean NOT NULL DEFAULT false;--> statement-breakpoint
```

- [ ] **Step 4: Journal entry**

Append to `entries` in `drizzle/migrations/meta/_journal.json` (tab-indented). The last entry is `idx: 248` / `when: 1798537400000`; the recent entries step `when` by `+100000`:

```json
		{
			"idx": 249,
			"version": "7",
			"when": 1798537500000,
			"tag": "0246_members_is_vat_registered",
			"breakpoints": true
		}
```

- [ ] **Step 5: Thread it through schema → domain → repo**

`schema-members.ts`, after `branchCode` (line 66):

```ts
    // 059 / PR-A — the §86/4 discriminator, RECORDED not derived. Gates whether
    // the buyer's "สำนักงานใหญ่ / สาขาที่ NNNNN" line prints (ประกาศ 199) and
    // whether their TIN is required (ประกาศ 196). Never infer this from
    // `legalEntityType` — see migration 0246.
    isVatRegistered: boolean('is_vat_registered').notNull().default(false),
```

`member.ts` — add `readonly isVatRegistered: boolean;` to the `Member` type, next to `isHeadOffice`.

`drizzle-member-repo.ts` — four sites:
1. `rowToMember`: `isVatRegistered: row.isVatRegistered,`
2. `applyMemberPatch`: `if (patch.isVatRegistered !== undefined) set.isVatRegistered = patch.isVatRegistered;`
3. `createWithPrimaryContactInTx`'s member `.values({…})`: `isVatRegistered: draft.member.isVatRegistered,`
4. `scrubPiiInTx`'s `.set({…})` — next to `isHeadOffice: true` (~line 684). **Reset to the default, do not NULL** (the column is `NOT NULL`, and `false` keeps Task 5's tightened CHECK satisfied):

```ts
        isVatRegistered: false,
```

`member-repo.ts` — add `'isVatRegistered'` to the `MemberPatch` `Pick<Member, …>` union.

`_serialise.ts` — emit `is_vat_registered` alongside `is_head_office`. **Keep the existing posture**: the comment at `_serialise.ts:19-21` records that the *portal* serialiser must not expose `is_head_office` / `branch_code`. `is_vat_registered` is the same class — staff-only.

- [ ] **Step 6: Apply the migration and run the unit suite**

```bash
pnpm db:migrate
pnpm vitest run tests/unit/members/
```

Expected: migration applies to the **`dev`** Neon branch; the scrub-coverage test now passes.

- [ ] **Step 7: Write the failing integration test**

In `tests/integration/members/create-member.test.ts` — reuse the file's existing fixture and row-reading helper:

```ts
  it('defaults is_vat_registered to false and round-trips an explicit true', async () => {
    const off = await createMember({ ...baseInput }, meta);
    expect(off.ok).toBe(true);
    expect((await readMemberRow(off.value.memberId)).isVatRegistered).toBe(false);

    const on = await createMember(
      { ...baseInput, is_vat_registered: true, tax_id: '0105562087242' },
      meta,
    );
    expect(on.ok).toBe(true);
    expect((await readMemberRow(on.value.memberId)).isVatRegistered).toBe(true);
  });
```

The `tax_id` on the second member is not decoration — Task 4 adds the `registrant ⇒ TIN` invariant, and this test must keep passing once it lands.

- [ ] **Step 8: Accept it in the input schemas**

`create-member.ts` — add to `createMemberSchema` (after `tax_id`, line 60):

```ts
  is_vat_registered: z.boolean().optional(),
```

and to the member draft (~line 438): `isVatRegistered: data.is_vat_registered ?? false,`

`update-member.ts` — add the same key to `updateMemberSchema`. **It is `.strict()`** — without this, a PATCH carrying the field 400s.

- [ ] **Step 9: Run the integration test**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/members/create-member.test.ts
```

Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add drizzle/migrations/ src/modules/members/ src/app/api/members/_serialise.ts \
        tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts \
        tests/integration/members/create-member.test.ts
git commit -m "feat(members): is_vat_registered — record the fact, stop guessing it

No backfill: members is empty. The importer sets it (Task 7).

Scrubbed on erasure to its DEFAULT (false), not NULL — the column is NOT NULL,
and false is what keeps the tightened branch-pairing CHECK satisfiable."
```

---

### Task 3: Re-point all FOUR discriminator consumers

**This is the highest-risk task in the PR.** Miss one and the pre-issue **preview dialog tells the admin the branch line will print while the PDF omits it** — exactly the defect class 088 US3 was created to fix.

**Files:**
- Modify: `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts` — **both** raw SELECTs (`:52-72` and `:73-92`), the row type (`:93-124`), and the call (`:199`)
- Modify: `src/app/(staff)/admin/invoices/_lib/issue-review.ts` — the whole hand-rolled block (`:39-92`)
- Modify: `src/app/(staff)/admin/invoices/_components/issue-invoice-form.tsx` — the prop (`:87-88`) and the `'individual'` sentinel (`:169-175`)
- Modify: `src/app/(staff)/admin/invoices/[invoiceId]/page.tsx` — `:212-224` and `:489`
- Modify: `src/components/members/member-form/schema.ts:381` — the branch/registrant gate
- **Delete:** `src/lib/legal-entity.ts` and `tests/unit/lib/legal-entity.test.ts`
- Modify: `src/i18n/messages/{en,th,sv}.json` — one warning key renamed
- Test: `tests/unit/invoicing/issue-review-model.test.ts`
- Test: `tests/integration/invoicing/member-identity-branch.test.ts`

**Interfaces:**
- Consumes: `Member.isVatRegistered` (Task 2).
- Produces: `IssueReviewInput.buyerIsVatRegistrant: boolean` (replacing `legalEntityType: string | null`); `BranchLinePreview`'s `none` reason becomes `'not_registrant'`.

- [ ] **Step 1: Write the failing unit test for `issue-review.ts`**

Rewrite `tests/unit/invoicing/issue-review-model.test.ts` against the new input:

```ts
  it('a VAT registrant previews the head-office line', () => {
    const m = computeIssueReviewModel({ buyerIsVatRegistrant: true });
    expect(m.branchLine).toEqual({ kind: 'head_office' });
    expect(m.warnings).not.toContain('no_branch_line_not_vat_registrant');
  });

  it('a non-registrant previews NO line, and says why', () => {
    const m = computeIssueReviewModel({ buyerIsVatRegistrant: false });
    expect(m.branchLine).toEqual({ kind: 'none', reason: 'not_registrant' });
    expect(m.warnings).toContain('no_branch_line_not_vat_registrant');
  });
```

The old `'unset'` / `'individual'` reasons are gone: with a recorded boolean there is no third state. The warning is renamed because "null entity type" is no longer why the line is absent.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/invoicing/issue-review-model.test.ts
```

Expected: FAIL — `IssueReviewInput` has no `buyerIsVatRegistrant`.

- [ ] **Step 3: Rewrite `issue-review.ts`**

Replace `:23-92` wholesale:

```ts
export type IssueReviewWarningCode =
  | 'no_payment_path'
  | 'no_branch_line_not_vat_registrant';

export type BranchLinePreview =
  | { readonly kind: 'head_office' }
  | { readonly kind: 'none'; readonly reason: 'not_registrant' };

export interface IssueReviewInput {
  /**
   * `members.is_vat_registered` — the RECORDED fact, never derived. This used to
   * take `legalEntityType: string | null` and re-implement the discriminator by
   * hand (`norm === 'individual'`), independently of the adapter that produces
   * the snapshot the PDF actually renders. Two copies of one rule is how a
   * preview comes to contradict the document.
   */
  readonly buyerIsVatRegistrant: boolean;
  readonly hasNoPaymentPath?: boolean;
}

export interface IssueReviewModel {
  readonly branchLine: BranchLinePreview;
  readonly warnings: readonly IssueReviewWarningCode[];
}

export function computeIssueReviewModel(
  input: IssueReviewInput,
): IssueReviewModel {
  const warnings: IssueReviewWarningCode[] = [];

  const branchLine: BranchLinePreview = input.buyerIsVatRegistrant
    ? { kind: 'head_office' }
    : { kind: 'none', reason: 'not_registrant' };

  if (!input.buyerIsVatRegistrant) {
    warnings.push('no_branch_line_not_vat_registrant');
  }
  if (input.hasNoPaymentPath === true) {
    warnings.push('no_payment_path');
  }

  return { branchLine, warnings };
}
```

`buyerIsVatRegistrantJuristic` is **deleted** — the map confirmed it was returned but never read by any consumer.

- [ ] **Step 4: Re-point `issue-invoice-form.tsx`**

The prop (`:87-88`) becomes:

```ts
  /** `members.is_vat_registered` — gates the Head-Office/Branch preview. */
  readonly buyerIsVatRegistrant: boolean;
```

The call (`:169-175`) — and note what the old `'individual'` literal was actually for:

```tsx
  // The literal 'individual' used to be passed here as a SENTINEL meaning
  // "non-membership sale — suppress the branch line without raising the
  // unset-entity-type warning". It was never a real entity type. With a boolean
  // the sentinel is unnecessary: a non-membership sale simply has no
  // VAT-registrant buyer of record.
  const review = taxAtPayment
    ? computeIssueReviewModel({
        buyerIsVatRegistrant: isMembership ? buyerIsVatRegistrant : false,
        ...(hasNoPaymentPath !== undefined ? { hasNoPaymentPath } : {}),
      })
    : null;
```

The render (`:500-513`) loses a branch — there is only one `none` reason now:

```tsx
{review.branchLine.kind === 'head_office'
  ? t('review.branchLine.headOffice')
  : t('review.branchLine.noneNotRegistrant')}
```

Update the i18n keys accordingly in all three locales (`review.branchLine.noneIndividual` + `noneUnset` → **one** key `noneNotRegistrant`).

- [ ] **Step 5: Re-point the page that feeds the form**

`[invoiceId]/page.tsx:212-224`:

```ts
let buyerIsVatRegistrant = false;
if (!snapshotName && invoice.memberId !== null) {
  const memberResult = await getMember(/* … */);
  if (memberResult.ok) {
    memberDisplayName = memberResult.value.member.companyName;
    buyerHasTaxId = memberResult.value.member.taxId !== null;
    buyerIsVatRegistrant = memberResult.value.member.isVatRegistered;
  }
}
```

and `:489` → `buyerIsVatRegistrant={buyerIsVatRegistrant}`.

- [ ] **Step 6: Re-point the adapter — BOTH SELECTs, the row type, AND the call**

**Read the trap in Global Constraints again before you touch this file.** The `as unknown as Array<{…}>` cast at `:93` means neither half is compiler-checked.

Add `m.is_vat_registered,` to the column list of **both** the `FOR UPDATE` arm (`:52-72`) and the plain arm (`:73-92`) — they are byte-identical apart from `FOR UPDATE OF m`, and both must change.

Add to the row type (`:93-124`), next to `is_head_office`:

```ts
  is_vat_registered: boolean;
```

And the call at `:199`:

```ts
        // Was: isVatRegistrantEntityType(m.legal_entity_type) — a guess.
        // Now: the recorded fact. See migration 0246.
        buyer_is_vat_registrant: m.is_vat_registered,
```

- [ ] **Step 7: Re-point the form's branch gate**

`member-form/schema.ts:381` — the guard is here, **not** in `tax-branch-section.tsx` (PR-B moved the widget, not the rule):

```ts
      if (data.is_vat_registered !== true) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['branch_code'],
          message: tf('errors.branchOnNonRegistrant'),
        });
      }
```

and add `is_vat_registered: z.boolean().optional()` to the form schema's field list. Drop the `isVatRegistrantEntityType` import (`schema.ts:11`).

- [ ] **Step 8: Delete the guess**

```bash
git rm src/lib/legal-entity.ts tests/unit/lib/legal-entity.test.ts
```

Then `grep -rn "legal-entity\|isVatRegistrantEntityType" src/ tests/ scripts/` and confirm **zero hits**. If it survives anywhere, it will be called again.

- [ ] **Step 9: Write the failing integration test — the preview/PDF agreement**

Extend `tests/integration/invoicing/member-identity-branch.test.ts`. This file exists **because typecheck cannot catch raw-SQL drift** — its header says so.

```ts
  it('the snapshot carries the RECORDED flag, from both SELECT arms', async () => {
    // A registrant member with a branch.
    const identity = await loadMemberIdentity(tenant, memberId, { forUpdate: false });
    expect(identity.buyer_is_vat_registrant).toBe(true);

    // The FOR UPDATE arm is a SEPARATE SQL string. A column added to one and not
    // the other compiles clean and silently yields `undefined` here.
    const locked = await loadMemberIdentity(tenant, memberId, { forUpdate: true });
    expect(locked.buyer_is_vat_registrant).toBe(true);
  });
```

Use the file's own seeding helpers and entry point — do not invent names.

- [ ] **Step 10: Run everything this touched**

```bash
pnpm vitest run tests/unit/invoicing/ tests/unit/members/presentation/
pnpm vitest run --config vitest.integration.config.ts tests/integration/invoicing/
npx tsc -p tsconfig.tsccheck.json --noEmit
pnpm check:i18n
```

- [ ] **Step 11: Commit**

```bash
git commit -m "feat(invoicing): read is_vat_registered, delete the guess

Four consumers derived 'is this buyer a VAT registrant' independently, and one
of them (issue-review.ts) re-implemented the rule by hand. All four now read
the recorded column, and src/lib/legal-entity.ts is deleted so the guess cannot
be called again.

The adapter's raw SQL has TWO select arms (FOR UPDATE and plain) behind an
`as unknown as` cast — neither half is compiler-checked. The live-Neon test
asserts both."
```

---

### Task 3b: The entity-type dropdown

**Added 2026-07-14, after Task 3's implementer found the plan hole this sits next to.** Task 1 shipped a 12-code catalogue and **nothing renders it**. `legal_entity_type` is still a free-text `<Input>` (`company-section.tsx:104-117`, `register('legal_entity_type')`, schema `z.string().max(100).optional()`), so an admin can type any string, the label resolver fails soft, and raw snake_case lands on the member page. This was the reviewer's feedback item #3 and the original plan simply never scheduled it.

Task 3 adds the VAT **checkbox** (it must, or it regresses branch-save). Task 3b adds the entity-type **dropdown** and the link between them.

**Files:**
- Modify: `src/components/members/member-form/sections/company-section.tsx` — replace the `<Input>` with a Select over `LEGAL_ENTITY_TYPES`
- Modify: `src/components/members/member-form/schema.ts` — `legal_entity_type` becomes a closed enum, not free text
- Modify: `src/components/members/member-form/sections/tax-branch-section.tsx` — seed the VAT checkbox from `VAT_DEFAULT_BY_CODE` when the entity type changes
- Modify: `src/app/(member)/portal/profile/page.tsx:205-210` — it renders `value={m.legalEntityType}` **RAW**, so a member currently sees the machine code. Resolve it through the same i18n labels.
- Modify: `src/i18n/messages/{en,th,sv}.json` — the explanation popup copy
- Test: `tests/unit/members/presentation/member-form-schema.test.ts`, `company-section.test.tsx`

**Interfaces:**
- Consumes: `LEGAL_ENTITY_TYPES`, `LegalEntityTypeCode`, `VAT_DEFAULT_BY_CODE` (Task 1); the `is_vat_registered` form field (Task 3).

**The three things that make this more than a widget swap:**

1. **The schema must close.** `z.string().max(100)` becomes `z.enum(LEGAL_ENTITY_TYPES)` (`.optional()` — the field is not mandatory). Once it is closed, an out-of-catalogue value cannot be stored, which is what makes the fail-soft resolver harmless. But: the 132 imported members will have `legal_entity_type` set by Task 7's importer, and `null` for the 10 TSCC rows that say "N/A" — so `.optional()` must genuinely accept `undefined`/`''`, and the Edit form must not reject a member whose type is unset. Test that case explicitly.

2. **Seeding is a suggestion, not a rule.** When the admin picks an entity type, seed the VAT checkbox from `VAT_DEFAULT_BY_CODE[code]` — but only when the default is `true` or `false`. For `association` and `foundation` the default is **`null`**: leave the checkbox untouched and let the admin decide (that is the whole point of the `null`; TSCC is itself a VAT-registered association). And **never re-seed a value the admin has already changed by hand** — seeding must not silently overwrite a deliberate choice. This is the same class of bug PR-B shipped a Critical for: an effect that fires on mount and rewrites fields the user did not touch.

3. **The popup is required copy, not decoration.** The reviewer asked for an explanation of each type. Write real TH/SV, not English placeholders.

---

### Task 4: The `registrant ⇒ TIN` invariant, at four layers

ประกาศ 196 (buyer TIN) and 199 (สำนักงานใหญ่/สาขา) are a **pair** — both mandatory when the buyer is a registrant. Today `is_vat_registered = true` + `tax_id = NULL` **parses clean**, and the document prints "สำนักงานใหญ่" with **no buyer TIN**: a defective §86/4 invoice.

**Files:**
- Modify: `src/modules/invoicing/domain/value-objects/member-identity-snapshot.ts` — the `superRefine` (`:136-175`)
- Modify: `src/modules/members/application/use-cases/create-member.ts` — add a `superRefine` (there is none)
- Modify: `src/modules/members/application/use-cases/update-member.ts` — extend the `superRefine` (`:60-82`)
- Modify: `src/components/members/member-form/schema.ts` — add to the `superRefine`
- Create: `drizzle/migrations/0247_members_branch_requires_vat_registrant.sql` (Task 5 — the DB layer)
- Test: `tests/unit/invoicing/member-identity-snapshot.test.ts`, `tests/unit/members/presentation/member-form-schema.test.ts`

**Interfaces:**
- Consumes: `Member.isVatRegistered` (Task 2).

**The layer that legally matters is the snapshot VO** — it is the last gate before a document exists. The other three are UX.

- [ ] **Step 1: Write the failing snapshot test**

```ts
  it('rejects a VAT registrant with no TIN', () => {
    // ประกาศ 196 + 199 are a PAIR: a registrant buyer must carry BOTH the 13-digit
    // TIN and the head-office/branch line. Printing one without the other is a
    // defective §86/4 document. This must fail LOUD at issue — it is the last gate
    // before the document exists.
    expect(() =>
      makeMemberIdentitySnapshot({
        legal_name: 'ACME Co., Ltd.',
        tax_id: null,
        address: '123 Sukhumvit',
        primary_contact_name: 'Somchai',
        primary_contact_email: 'a@b.com',
        buyer_is_vat_registrant: true,
      }),
    ).toThrow(InvalidMemberIdentitySnapshotError);
  });

  it('accepts a NON-registrant with no TIN', () => {
    // The common case: a foreign member, or a Thai member below the threshold.
    // No TIN is required of them, and no branch line prints.
    expect(() =>
      makeMemberIdentitySnapshot({
        legal_name: 'Nordic AB',
        tax_id: null,
        address: 'Stockholm',
        primary_contact_name: 'Anders',
        primary_contact_email: 'a@b.se',
        buyer_is_vat_registrant: false,
      }),
    ).not.toThrow();
  });
```

- [ ] **Step 2: Run it, watch it fail, then add the rule**

In `member-identity-snapshot.ts`'s `superRefine` (after the existing branch-pairing rules):

```ts
  // ประกาศอธิบดีฯ 196 (buyer TIN) + 199 (สำนักงานใหญ่/สาขา) are a PAIR — both are
  // mandatory when the buyer is a VAT registrant. A snapshot with the flag set and
  // no TIN would print the branch line with no taxpayer number: a defective §86/4
  // document. This is the LAST gate before an immutable document exists, so it
  // fails loud rather than degrading.
  if (data.buyer_is_vat_registrant === true && data.tax_id === null) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['tax_id'],
      message:
        'a VAT-registrant buyer must carry a tax_id (ประกาศอธิบดีฯ 196 + 199)',
    });
  }
```

- [ ] **Step 3: Mirror it in the three UX layers**

Each one shows the admin the problem *before* they reach the issue gate. None of them replaces the snapshot rule.

`create-member.ts` — `createMemberSchema` has **no `superRefine` at all**; add one:

```ts
  .superRefine((data, ctx) => {
    if (data.is_vat_registered === true && !data.tax_id?.trim()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['tax_id'],
        message: 'a VAT-registrant member must have a tax_id',
      });
    }
  });
```

`update-member.ts` — extend the existing `superRefine` with the same rule. **Careful:** on a PATCH, `is_vat_registered` and `tax_id` may each be absent. Only enforce when the *resulting* state would violate it — which the use case knows, because it reads `current` before patching. If the rule cannot be expressed on the patch alone, enforce it in the use-case body against `{...current, ...patch}` rather than in the schema, and say so in a comment.

`member-form/schema.ts` — same rule in the form's `superRefine`, so the admin sees it inline.

- [ ] **Step 4: Run + commit**

```bash
pnpm vitest run tests/unit/invoicing/ tests/unit/members/
```

---

### Task 5: Tighten the branch-pairing CHECK

`0236_members_branch_pairing_ck_fix.sql` pins only `is_head_office ⇔ branch_code`. Nothing prevents `(is_vat_registered = false, is_head_office = false, branch_code = '00001')` — and the branch line then **silently vanishes** at render, because the template gates on the registrant flag. The rule "a branch implies a registrant" currently lives **only in the client**.

**Files:**
- Create: `drizzle/migrations/0247_members_branch_requires_vat_registrant.sql`
- Modify: `drizzle/migrations/meta/_journal.json` (idx 250, when 1798537600000)
- Modify: `src/modules/members/application/use-cases/update-member.ts` — mirror it server-side
- Test: `tests/integration/members/update-member.test.ts`

- [ ] **Step 1: The migration**

```sql
-- 059 / PR-A — a branch implies a VAT registrant.
--
-- 0236 pinned only `is_head_office ⇔ branch_code`. Nothing stopped
-- `(is_vat_registered = false, is_head_office = false, branch_code = '00001')` —
-- a row that PASSES every existing check and then renders NO branch line at all,
-- because invoice-template.tsx gates the line on the registrant flag. A silent
-- under-print. The rule lived only in the client (`member-form/schema.ts`), so a
-- direct API call could already store it.
--
-- This TIGHTENS. `members` is empty, so no row can be rejected — but audit before
-- applying to any populated database.
--
-- Idempotent (DROP IF EXISTS + re-ADD), pattern from 0236.
ALTER TABLE "members" DROP CONSTRAINT IF EXISTS "members_branch_pairing_ck";--> statement-breakpoint

ALTER TABLE "members" ADD CONSTRAINT "members_branch_pairing_ck" CHECK (
  (is_head_office = true AND branch_code IS NULL)
  OR (is_head_office = false
      AND is_vat_registered = true
      AND branch_code IS NOT NULL
      AND branch_code ~ '^[0-9]{5}$')
);--> statement-breakpoint
```

Note the `IS NOT NULL` on the branch leg is **load-bearing** — a Postgres CHECK admits `NULL`, and 0236 exists *because* 0232 forgot it.

- [ ] **Step 2: Mirror it in `updateMemberSchema`'s `superRefine`, apply, test, commit**

The erasure scrub sets `(is_vat_registered = false, is_head_office = true, branch_code = NULL)` — which satisfies the head-office leg. Confirm the erasure integration test still passes.

---

### Task 6: The three passport guards

The maintainer decided (2026-07-14) to **collect** a foreign member's passport / work-permit number in `tax_id`, as the reviewer asked. Today that is **not safe**: three paths would leak it. All three must close before the field can accept one.

**Files:**
- Modify: `src/modules/invoicing/domain/document-kind.ts`
- Modify: `src/modules/invoicing/infrastructure/pdf/templates/invoice-template.tsx:483-489`
- Modify: `src/modules/members/application/use-cases/update-member.ts` — `buildDiff` (`:114-130`)
- Modify: `src/lib/logger.ts:100-103`
- Test: `tests/unit/invoicing/document-kind.test.ts`, `tests/unit/members/application/update-member-audit.test.ts`

- [ ] **Guard 1 — the document kind must not flip on TIN presence**

`document-kind.ts:64` currently:

```ts
export function inferEventDocumentKind(subject, taxId): EventDocumentKind {
  return subject === 'event' && !buyerHasTin(taxId) ? 'receipt_separate' : 'invoice';
}
```

So a foreign individual who types a passport number **silently upgrades their own §105 receipt into a §86/4 tax invoice**. Re-key it on the registrant flag:

```ts
export function inferEventDocumentKind(
  subject: InvoiceSubject,
  buyerIsVatRegistrant: boolean,
): EventDocumentKind {
  // Was keyed on `buyerHasTin(taxId)` — i.e. "is this field non-blank". A foreign
  // member's passport number is non-blank, so typing one silently flipped their
  // §105 receipt into a §86/4 tax invoice. The document kind must follow the
  // BUYER'S STATUS, not the emptiness of a text field.
  return subject === 'event' && !buyerIsVatRegistrant
    ? 'receipt_separate'
    : 'invoice';
}
```

`inferReceiptKind` has the identical shape and the identical bug — fix both. Then update all 5 call sites (`issue-invoice.ts:498`, `issue-credit-note.ts:452`, `credit-notes/new/page.tsx:72`, `record-payment.ts:599`, `render-receipt-pdf.ts:184`) to pass the snapshot's `buyer_is_vat_registrant` instead of its `tax_id`.

- [ ] **Guard 2 — the PDF must not print a non-registrant's identifier**

`invoice-template.tsx:487` prints **any** non-blank `tax_id`, with no registrant gate:

```tsx
  // A buyer TIN is a §86/4 particular required only of a VAT REGISTRANT
  // (ประกาศ 196). A non-registrant's identifier — a foreign org number, a passport
  // — has no place on the document, and printing it is a false particular. Gate it
  // the same way the branch line is gated.
  const buyerTaxIdEl =
    input.member.buyer_is_vat_registrant === true &&
    buyerHasTin(input.member.tax_id) ? (
      <Text style={styles.label}>Tax ID: {input.member.tax_id}</Text>
    ) : null;
```

**The `templateVersion` gate is REQUIRED. This was investigated and settled 2026-07-14 — do not re-litigate it, and do not ship the change un-gated.**

The evidence: an issued PDF is **not** write-once. `void-invoice.ts:308-350` and `:396-429` re-render and then upload with `allowOverwrite: true` to the *same* `blobKey` (`:606`); `issue-credit-note.ts:920-969` (the J2 credit-annotation overlay) does the same. Both re-render with the **currently deployed template code** against the frozen snapshot, at the document's **pinned** `templateVersion`. That is exactly the property the seven existing `_MIN_VERSION` gates protect — `template-registry.ts:53-69` names it: *"a pinned pre-v5 document … reproduces its original bytes — the SC-003 guarantee"*.

And `member-identity-snapshot.ts:135` declares `buyer_is_vat_registrant: z.boolean().optional().default(false)` — so every snapshot written before the field existed **omits the key and reads back `false`**. An un-gated change would therefore silently **drop the Tax ID line from an already-issued document** the moment it is voided or credit-noted.

So:

```tsx
// invoice-template.tsx — with the other *_MIN_VERSION constants (~line 285)
const TAX_ID_REGISTRANT_GATE_MIN_VERSION = 11;
```

```tsx
  // A buyer TIN is a §86/4 particular required only of a VAT REGISTRANT
  // (ประกาศ 196). A non-registrant's identifier — a foreign org number, a
  // passport — has no place on the document, and printing it is a false
  // particular. Gated exactly the way the branch line is: a document pinned to
  // v≤10 keeps the legacy unconditional print, so voiding or credit-noting it
  // still reproduces its original bytes (SC-003).
  const buyerTaxIdEl = buyerHasTin(input.member.tax_id) ? (
    input.templateVersion >= TAX_ID_REGISTRANT_GATE_MIN_VERSION &&
    input.member.buyer_is_vat_registrant !== true ? null : (
      <Text style={styles.label}>Tax ID: {input.member.tax_id}</Text>
    )
  ) : null;
```

Then in `template-registry.ts`: bump `CURRENT_TEMPLATE_VERSION` **10 → 11** (`:163`), extend the `TEMPLATE_VERSIONS` tuple, and add the v11 changelog entry in the same voice as v5–v10.

- [ ] **Guard 3 — the audit diff must not carry a raw TIN**

`buildDiff` (`update-member.ts:114-130`) writes **raw** old/new values into `audit_log.payload`, and **nothing in `src/` ever `UPDATE`s `audit_log`**. It is retained 5 years. So a passport written there **survives an Art. 17 erasure** — `eraseMember` NULLs `members.tax_id` but cannot reach the audit row.

Emit `taxId` as a **presence signal**, not a value. `fields_changed` already carries the accountability:

```ts
    if (currentVal !== patch[key]) {
      fieldsChanged.push(key as string);
      // `taxId` may hold a passport / work-permit number for a foreign natural
      // person. The audit payload is retained 5 years and NOTHING in src/ ever
      // UPDATEs audit_log — so a raw value written here SURVIVES an Art. 17
      // erasure that has already NULLed the column. Record that it changed, not
      // what it changed to; `fields_changed` carries the accountability.
      diff[key as string] =
        key === 'taxId'
          ? {
              old: currentVal === null ? null : '<set>',
              new: patch[key] === null ? '<cleared>' : '<set>',
            }
          : { old: currentVal, new: patch[key] };
    }
```

- [ ] **Guard 3b — the logger's redaction is one level too shallow**

`logger.ts:100-103` has `tax_id` / `*.tax_id` / `taxId` / `*.taxId` — **depths 0 and 1 only**. But `buildDiff` puts it at `payload.diff.taxId` — **depth 2**. Every neighbour (`legal_name`, `address`, `attendeeEmailLower`, `recipient_email`) carries the `*.*.` variant, and the comment at `:115-116` *claims* `tax_id` follows "the depth-0/1/2 convention" — **it does not**. Add:

```ts
  'tax_id',
  '*.tax_id',
  '*.*.tax_id',
  'taxId',
  '*.taxId',
  '*.*.taxId',
```

and fix the lying comment.

- [ ] **Run + commit** — with a test proving a `member_updated` audit payload contains **no** raw tax id.

---

### Task 7: The importer reads `Member Type`

**This replaces the backfill.** `members` is empty; the importer is where every member gets its entity type and VAT flag, once, correctly.

**Files:**
- Create: `scripts/import-members/entity-type.ts`
- Modify: `scripts/import-members/columns.ts` — `HEADER_ALIASES` + `RawRow`
- Modify: `scripts/import-members/validate.ts` — `ValidatedMember` + the parse
- Modify: `scripts/import-members.ts:278-295` — the insert
- Test: `tests/unit/scripts/import-members-entity-type.test.ts`

**Interfaces:**
- Consumes: `LegalEntityTypeCode`, `VAT_DEFAULT_BY_CODE` (Task 1).
- Produces: `coerceLegalEntityType(raw: string): Result<LegalEntityTypeCode | null, EntityTypeResolveError>`

- [ ] **Step 1: The coercer, with the trap in a test**

```ts
  it('does NOT confuse the Member Type "Individual" with the Plan "Individual"', () => {
    // `Individual` appears in TWO columns of TSCC's sheet with two unrelated
    // meanings: Member Type = บุคคลธรรมดา (a legal form, 15 rows) and Plan = the
    // Individual membership package (17 rows). Reading the wrong column assigns
    // the wrong entity type to 17 members and the wrong plan to 15.
    // This coercer must only ever see the Member Type column.
    expect(coerceLegalEntityType('Individual')).toEqual(ok('individual'));
  });

  it('maps every value present in TSCC sheet', () => {
    expect(coerceLegalEntityType('Private Limited Company (Company Limited)'))
      .toEqual(ok('limited_company'));
    expect(coerceLegalEntityType('State Enterprise')).toEqual(ok('state_enterprise'));
    expect(coerceLegalEntityType('Public Limited Company')).toEqual(ok('public_company'));
    expect(coerceLegalEntityType('Foundation')).toEqual(ok('foundation'));
    expect(coerceLegalEntityType('N/A')).toEqual(ok(null));
    expect(coerceLegalEntityType('')).toEqual(ok(null));
  });

  it('FAILS LOUD on an unmapped value', () => {
    // A silent NULL is exactly how the §86/4 branch line came to be missing from
    // every invoice in the first place. An unknown Member Type must stop the row,
    // not import as "unknown".
    const r = coerceLegalEntityType('Sole Proprietorship Ltd');
    expect(r.ok).toBe(false);
  });
```

Follow the `countryNameToCode` pattern in `coerce.ts:110` — canonical code first, then display-name alias, then **fail loud** (its header comment explicitly rejects a silent default).

- [ ] **Step 2: Wire it through columns → validate → insert**

`columns.ts` — add to `HEADER_ALIASES`. **Beware:** `tier` already claims the alias `'member type'` (line 18). That alias must **move** to the new field, or the two columns fight over the same header. Read TSCC's sheet: the tier column is headed `Plan`, so removing `'member type'` from `tier`'s aliases is safe — but verify against the actual headers before you do it.

`validate.ts` — `ValidatedMember` gains `legalEntityType: LegalEntityTypeCode | null` and `isVatRegistered: boolean`.

**The VAT flag is NOT simply `VAT_DEFAULT_BY_CODE[code]`. It is:**

```ts
// A member cannot be a VAT registrant OF RECORD without a TIN — the flag exists
// solely to drive the §86/4 buyer particulars (the TIN line and the
// สำนักงานใหญ่/สาขา line, ประกาศ 196 + 199), and neither can be printed without
// one. So the entity-type default is an upper bound, gated on actually having a
// number.
const isVatRegistered = VAT_DEFAULT_BY_CODE[code] === true && taxId !== null;
```

**Why this is load-bearing, not defensive:** TSCC has **7 State Enterprise members and not one of them has a Tax ID** (they sit in the 37-row "N/A" group, alongside all 15 Individuals and both Foundations). `VAT_DEFAULT_BY_CODE.state_enterprise` is `true`. A naive `isVatRegistered = VAT_DEFAULT_BY_CODE[code]` therefore produces `is_vat_registered: true` + `tax_id: null` for all seven — which **Task 4's `registrant ⇒ TIN` invariant rejects at create**. The import would fail on those rows, and "fixing" it by relaxing the invariant would be fixing the wrong end: the invariant is the law, the derivation was the bug.

When TSCC later supplies a TIN for one of them, an admin ticks the box on the form. That is the correct workflow — it is a decision, not a derivation.

Emit a warning for the `association` / `foundation` rows (`VAT_DEFAULT_BY_CODE[code] === null`) so the import report tells the admin to confirm them by hand.

**Also fold in the two uncommitted importer bug-fixes** (`tax_id` relax + mononym `'-'`) that are sitting unstaged from the 2026-07-12 import run — if they are not carried into this task they will be lost.

`import-members.ts:278-295` — add both to the `.values({…})`.

- [ ] **Step 3: Run the importer against TSCC's sheet in dry-run and check the report** — 111 `limited_company` / 15 `individual` / 7 `state_enterprise` / 5 `public_company` / 2 `foundation` (warned) / 10 `null`.

---

### Task 8: The Art. 14 attestation

A secondary contact is a **named natural person whose data we obtain from a third party** (the admin) and who is **never told they are in the system**. GDPR Art. 14 requires notice within a month. The spec's own residual register said *"Decide before PR-B ships"* — we shipped without it; the decision (2026-07-14) is an **attestation checkbox**, resting on Art. 14(5)(a).

**It must cover BOTH entry points.** The Edit page's `addContact` flow (`contact-crud.ts:89`) emails the new contact nothing either. Fixing only the create form is not a fix — the gap is about the *collection*, not the form.

**Files:**
- Create: `drizzle/migrations/0248_contacts_art14_attestation.sql` (idx 251, when 1798537700000)
- Modify: `schema-contacts.ts` — a column next to `inviteBouncedAt`
- Modify: `contact.ts` (domain), `contact-repo.ts`, `drizzle-contact-repo.ts`
- Modify: `contact-crud.ts` — `addContactSchema` + the `addInTx` literal
- Modify: `create-member.ts` — the `secondary_contact` zod block (`:88-97`) and **both** contact literals (`:277-292` secondary, `:404-420` primary)
- Modify: `secondary-contact-section.tsx` (create) and `contact-form-dialog.tsx` (edit-page add)
- Modify: the three locale files
- Test: unit + a live-Neon integration test

Column: `art14_attested_at timestamptz` — NULL for the primary contact (they are the member's own representative), NOT NULL for any contact added on someone else's behalf.

**Note:** there is **no `contacts` equivalent of `scrub-pii-column-coverage.test.ts`** — adding a contacts column trips no coverage guard. You must remember the erasure path yourself: `scrubPiiForMemberInTx` (`drizzle-contact-repo.ts:392`) already has no `is_primary` filter, so it covers the secondary — but confirm the new column is handled.

---

### Task 9: The conditional Tax-ID asterisk, then the gate

**Files:** `company-section.tsx` · `member-form/schema.ts` · the three locale files · Test: `member-form-schema.test.ts`, `company-section.test.tsx`

The asterisk must appear **only when the VAT checkbox is ticked** — a permanent `*` would lie to the 37 of 150 TSCC members who have no TIN at all (all 15 individuals, all 7 state enterprises, both foundations).

**Three things must toggle together**, and the form already does this twice (`date_of_birth` on `needsDob`, `branch_code` on `!isHeadOffice`):

1. `<RequiredMark />` renders — the visual signal
2. `aria-required="true"` on the input — **`RequiredMark` is `aria-hidden`**, so the asterisk alone is invisible to assistive tech
3. the zod rule actually enforces it (Task 4 already added this)

An asterisk without the rule is a lie; a rule without the asterisk is a save button that fails for no visible reason.

- [ ] **Final gate**

```bash
pnpm lint && npx tsc -p tsconfig.tsccheck.json --noEmit && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm check:strict-aria && pnpm check:multi-tenant && pnpm check:audit-events && pnpm check:audit-counts
pnpm vitest run tests/unit/ tests/contract/
pnpm vitest run --config vitest.integration.config.ts tests/integration/members/ tests/integration/invoicing/
```

The **§86/4 matrix** on live Neon is the one that matters:

| buyer | expected |
|---|---|
| registrant + head office | "สำนักงานใหญ่" **and** a Tax ID line |
| registrant + branch | "สาขาที่ NNNNN" **and** a Tax ID line |
| non-registrant, no TIN | **neither** line — and the invoice still issues |
| non-registrant **with** a stored identifier (a passport) | **neither** line — the identifier is stored, never printed |
| registrant + no TIN | **rejected at issue** |

- [ ] **Open the PR** — body must state that this changes the tax-document render path and requires **tax + security sign-off, ≥2 reviewers**.

---

## Self-review notes

- **Spec coverage:** §§ 4 (four consumers → Task 3), 5 (catalogue → Task 1), 6 (column → Task 2, no backfill per § 16), 7 (Tax-ID rules → Tasks 4 + 9), 8 (passport guards → Task 6), 16.5 (TIN required iff registrant → Task 4), 16.6 (no defaults for association/foundation → Task 1), § 10's Art. 14 residual (→ Task 8).
- **Deliberately NOT in this PR:** the org-as-subject Art. 15(4) archive question (spec § 10 residual — one contact's export discloses the other's PII). It is pre-existing and needs a product decision, not code.
- **The three places a shallow implementation will look fine and be wrong:** Task 3 (the `as unknown as` cast hides raw-SQL drift in *both* directions), Task 6 Guard 2 (removing the Tax-ID line from a document whose historical snapshot defaults `buyer_is_vat_registrant` to `false` would silently alter already-issued PDFs unless version-gated), and Task 7 (the `'member type'` header alias currently belongs to `tier`).
- **Ordering is load-bearing:** 1 → 2 → 3 → 4 → 5. Task 6 can run parallel to 3–5. Task 7 needs 1 + 2. Task 8 is independent.
