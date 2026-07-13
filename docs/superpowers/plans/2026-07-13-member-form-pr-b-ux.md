# Member Form — PR-B: Form UX — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the admin member form's data-entry experience — a searchable country combobox, a postcode-driven Thai address (down to แขวง/ตำบล, and threaded onto the tax document), registered capital, a relabelled website field, an optional secondary contact, and a form that no longer loses your work — on top of a decomposed `member-form.tsx`.

**Architecture:** One migration adds two columns (`registered_capital_thb`, `sub_district`). The Thai postal reference table is **already committed** (`src/lib/thai-postal/data.json`, 367 KB) and is read **server-side only** behind `/api/geo/postal/[code]` — at 97 KB gzipped it must never enter a client bundle. `member-form.tsx` (1,062 lines) is decomposed into `member-form/` before anything is added to it, and the primary/secondary contacts render from **one** parameterised component.

**Tech Stack:** Next.js 16 App Router · React 19 · react-hook-form + zod · **Base UI** (not Radix — `render={…}`, not `asChild`) + cmdk · next-intl · Drizzle · Vitest + @testing-library/react + Playwright.

**Spec:** `docs/superpowers/specs/2026-07-13-member-form-redesign-design.md` (v2, commit `a6c9edd8`), § 3 rows 1/6/7/8/10, § 9, § 10, § 11.

**Branch:** `058-member-form-ux`, off `main` at `44e96d1b` (PR-0 merged). The dataset commit `52900432` is already on it.

## Global Constraints

- **Package manager is `pnpm`, never `npm`.** Lockfile `pnpm-lock.yaml`.
- **Zero new npm dependencies** (Constitution X). Everything needed already exists.
- **Never run `prettier --write`.** `.prettierrc` says `printWidth: 100`, the committed code is ~80 columns, and no gate enforces it — a format run reflows whole files. Hand-format to match the surrounding code.
- **TDD is NON-NEGOTIABLE** (Principle II): write the failing test, RUN it, confirm it fails *for the stated reason*, then implement.
- **UI primitives are Base UI, not Radix.** `PopoverTrigger` composes via `render={<Button …/>}`, not `asChild`. `CollapsibleContent` maps to Base UI's `Panel`.
- **i18n**: `en.json` is canonical. Every new key must land in **all three** of `en.json`, `th.json`, `sv.json` in the same commit, with a real translation — `pnpm check:i18n` verifies key *presence* only, and this repo has shipped English-in-TH/SV before.
- **Integration tests hit the live `dev` Neon branch** via `.env.local`. Single file: `pnpm vitest run --config vitest.integration.config.ts <path>`.
- **E2E**: `--workers=1` always (the default of 3 hangs the dev machine). Needs a dev server on :3100 that the **user** owns — never start or kill one.
- **`pnpm typecheck` is not in the pre-push hook.** Run it as the final gate. If a dev server is running it can be poisoned by `.next/dev/types`; use `npx tsc -p tsconfig.tsccheck.json --noEmit`.
- Conventional Commits (commit-msg hook).
- **Task 2 touches the tax-document render path.** It must be reviewed by a tax-aware reviewer.

## File Structure

**New:**
- `drizzle/migrations/0245_members_registered_capital_and_sub_district.sql`
- `src/lib/thai-postal/lookup.ts` — pure resolver over the committed dataset
- `src/app/api/geo/postal/[code]/route.ts` — auth-guarded lookup endpoint
- `src/components/ui/combobox.tsx` — the ARIA-complete searchable combobox primitive
- `src/components/members/member-form/` — `member-form.tsx` (composition root, < 200 lines) · `schema.ts` · `use-member-form-errors.ts` · `sections/company-section.tsx` · `sections/address-section.tsx` · `sections/membership-section.tsx` · `sections/tax-branch-section.tsx` · `sections/contact-fields.tsx` (rendered **twice** — primary and secondary)

**Modified:** `schema-members.ts` · `drizzle-member-repo.ts` · `member-repo.ts` (port) · `_repo-error.ts` · `create-member.ts` · `update-member.ts` · `member.ts` (domain) · `api/members/route.ts` · `_serialise.ts` · `member-create-error-map.ts` · `create-member-client.tsx` · `edit-member-payloads.ts` · `edit-member-client.tsx` · `compose-buyer-address.ts` · `member-identity-adapter.ts` · `members-backup-csv.ts` · `gdpr-archive-source-adapter.ts` · `scrub-pii-column-coverage.test.ts` · `check-bundle-budgets.ts` · the three locale files.

**Already committed on this branch:** `scripts/generate-thai-postal-data.ts` · `src/lib/thai-postal/data.json` · `src/lib/thai-postal/SOURCE.md`.

---

### Task 1: Migration — `registered_capital_thb` + `sub_district`

Two columns. `registered_capital_thb` is ทุนจดทะเบียน (the reviewer's ask; **`turnover_thb` stays** — it gates the F2 plan turnover band and drives F8 tier-upgrade suggestions, so relabelling it would silently re-point a membership-tier rule at a different quantity). `sub_district` is แขวง/ตำบล — the Thai address level the existing five columns cannot express, and a mandatory particular of a §86/4 buyer address.

**Files:**
- Create: `drizzle/migrations/0245_members_registered_capital_and_sub_district.sql`
- Modify: `drizzle/migrations/meta/_journal.json`
- Modify: `src/modules/members/infrastructure/db/schema-members.ts:104` (after `postalCode`), `:72` (after `turnoverThb`)
- Modify: `src/modules/members/domain/member.ts` (the `Member` type — `turnoverThb` at `:167`, address block at `:174-178`)
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts` — `rowToMember`, `applyMemberPatch`, `createWithPrimaryContactInTx`'s member `.values({…})` (`:497-527`), `scrubPiiInTx`'s `.set({…})` (`:679`)
- Modify: `tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts` — `SCRUBBED` set (`:31-70`)
- Test: `tests/integration/members/create-member.test.ts`

**Interfaces:**
- Produces: `members.registered_capital_thb` (`bigint`, nullable) and `members.sub_district` (`text`, nullable); Drizzle props `registeredCapitalThb` / `subDistrict`; `Member.registeredCapitalThb: number | null` and `Member.subDistrict: string | null`. Tasks 2, 6, 7 consume these.

- [ ] **Step 1: Write the failing coverage test**

`tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts` derives its column list from the live Drizzle table (`Object.keys(getTableColumns(members))`, `:97`) and fails on any column that is in neither `SCRUBBED` nor `KEPT`. So adding the columns to the schema **is** the failing test — but write the classification first so the intent is recorded, and watch it fail on "stale" instead.

Add to the `SCRUBBED` set, next to `postalCode` (`:53`) and `turnoverThb` (`:41`):

```ts
    // Postal address (PII). แขวง/ตำบล — the Thai sub-district level; part of
    // the §86/4 buyer address frozen onto the tax document at issue.
    'subDistrict',
    // Business quasi-identifier (GDPR Recital 26 at small-chamber scale) —
    // same class as turnoverThb / foundedYear.
    'registeredCapitalThb',
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts
```

Expected: FAIL on the third assertion — *"stale entries: subDistrict, registeredCapitalThb"* — because the columns are classified but do not exist on the table yet. That is the correct red: it proves the test is reading the live schema.

- [ ] **Step 3: Write the migration**

Create `drizzle/migrations/0245_members_registered_capital_and_sub_district.sql`. Follow `0232_members_branch_fields.sql` exactly — it is the precedent for adding columns to `members`.

```sql
-- 058 / PR-B (member-form UX) — two member columns.
--
-- 1. `registered_capital_thb` (ทุนจดทะเบียน) is a NEW field, NOT a rename of
--    `turnover_thb`. Turnover is not a display field: it gates the F2 plan
--    turnover band (out-of-band ⇒ mandatory override reason) and drives F8
--    auto tier-upgrade suggestions. Both columns coexist.
--
-- 2. `sub_district` (แขวง/ตำบล) is the Thai address level the existing five
--    address columns cannot express. It is threaded onto the §86/4 buyer
--    address by `composeBuyerAddress` — a Bangkok address reading
--    "เขตคลองเตย กรุงเทพมหานคร 10110" with no แขวง is not a complete address.
--    Do NOT overload `address_line2`: legacy rows hold building/floor/soi
--    there, and one column with two meanings is unfixable later.
--
-- Idempotent (ADD COLUMN IF NOT EXISTS; DROP CONSTRAINT IF EXISTS + re-ADD),
-- pattern from 0232. Both columns are nullable — existing rows carry neither,
-- and no backfill is possible or wanted. RLS: `members` is per-tenant
-- row-level; new columns inherit the existing policy (no new policy needed).
--
-- The CHECK spells out `IS NULL OR >= 0` rather than a bare `>= 0`: a Postgres
-- CHECK admits NULL, so a bare comparison would be a no-op on the nullable
-- column. (0236 exists because 0232 made exactly that mistake.)

-- 1. ทุนจดทะเบียน — bigint, mirroring turnover_thb (SweCham Premium turnover
--    band exceeds 100M THB, so int32 would overflow).
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "registered_capital_thb" bigint;--> statement-breakpoint

-- 2. แขวง/ตำบล.
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "sub_district" text;--> statement-breakpoint

-- 3. Mirrors members_turnover_non_negative (0009 § 7).
ALTER TABLE "members"
  DROP CONSTRAINT IF EXISTS "members_registered_capital_non_negative";--> statement-breakpoint

ALTER TABLE "members"
  ADD CONSTRAINT "members_registered_capital_non_negative"
  CHECK ("registered_capital_thb" IS NULL OR "registered_capital_thb" >= 0);--> statement-breakpoint
```

- [ ] **Step 4: Add the journal entry**

Append to `entries` in `drizzle/migrations/meta/_journal.json` (tab-indented, matching the existing entries). The last entry is `idx: 247`, `when: 1798537300000` — `idx` is **not** `entries.length` (there are gaps), and the recent entries step `when` by `+100000`:

```json
		{
			"idx": 248,
			"version": "7",
			"when": 1798537400000,
			"tag": "0245_members_registered_capital_and_sub_district",
			"breakpoints": true
		}
```

- [ ] **Step 5: Add the columns to the Drizzle schema**

`src/modules/members/infrastructure/db/schema-members.ts` — after `turnoverThb` (`:72`):

```ts
    // 058 / PR-B — ทุนจดทะเบียน (registered capital). A SEPARATE field from
    // `turnoverThb`, which gates the F2 plan turnover band + F8 tier upgrades.
    registeredCapitalThb: bigint('registered_capital_thb', { mode: 'number' }),
```

and after `postalCode` (`:104`):

```ts
    // 058 / PR-B — แขวง/ตำบล. Sits BETWEEN address_line2 and city in a Thai
    // address, and is threaded onto the §86/4 buyer address by
    // composeBuyerAddress. `city` holds the district (อำเภอ/เขต).
    subDistrict: text('sub_district'),
```

- [ ] **Step 6: Apply the migration to the dev Neon branch and run the coverage test**

```bash
pnpm db:migrate
pnpm vitest run tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts
```

Expected: the migration applies, and the coverage test now FAILS on assertion 2 — *"unclassified members columns"* is gone, but `scrubPiiInTx` has not been updated. Read the failure carefully: if the test passes at this point, it is only asserting the partition (it does **not** mechanically verify that a SCRUBBED column appears in `scrubPiiInTx` — that link is by hand, and the next step is where you make it).

- [ ] **Step 7: Thread both columns through the repo and the domain**

`src/modules/members/domain/member.ts` — add to the `Member` type, mirroring the neighbours:

```ts
  readonly registeredCapitalThb: number | null;
  readonly subDistrict: string | null;
```

`src/modules/members/infrastructure/db/drizzle-member-repo.ts`, four sites:

1. `rowToMember` — map both columns through.
2. `applyMemberPatch` — accept both in the patch.
3. `createWithPrimaryContactInTx`'s member `.values({…})` (`:497-527`) — insert both from the draft.
4. `scrubPiiInTx`'s `.set({…})` — next to `postalCode: null` (`:679`):

```ts
        postalCode: null,
        subDistrict: null,
        registeredCapitalThb: null,
```

`src/modules/members/application/use-cases/create-member.ts` — add to `createMemberSchema` (after `postal_code`, `:63`, and after `turnover_thb`, `:65`):

```ts
  sub_district: z.string().max(100).nullable().optional(),
  registered_capital_thb: z.number().int().nonnegative().nullable().optional(),
```

and to the member draft (`:356-381`):

```ts
        subDistrict: data.sub_district ?? null,
        registeredCapitalThb: data.registered_capital_thb ?? null,
```

`src/modules/members/application/use-cases/update-member.ts` — add the same two keys to `updateMemberSchema` (which is `.strict()`, so they must be declared or a PATCH carrying them 400s).

`src/app/api/members/_serialise.ts` — emit both alongside `turnover_thb` / `postal_code`. Keep the existing posture: the portal serialiser must not gain a field the portal has no business seeing (compare the `is_head_office` / `branch_code` comment at `_serialise.ts:19-21`) — both of these are member-visible business data, so they follow `turnover_thb`.

- [ ] **Step 8: Run the coverage test and the members unit suite**

```bash
pnpm vitest run tests/unit/members/
```

Expected: PASS, including `scrub-pii-column-coverage`.

- [ ] **Step 9: Write the failing integration test**

In `tests/integration/members/create-member.test.ts` — reuse the file's existing input fixture and row-reading helper (added in PR-0; do **not** invent new names):

```ts
  it('persists registered capital and sub-district', async () => {
    const result = await createMember(
      {
        ...baseInput,
        registered_capital_thb: 5_000_000,
        sub_district: 'คลองตันเหนือ',
        city: 'เขตวัฒนา',
        province: 'กรุงเทพมหานคร',
        postal_code: '10110',
      },
      meta,
    );
    expect(result.ok).toBe(true);

    const row = await readMemberRow(result.value.memberId);
    expect(row.registeredCapitalThb).toBe(5_000_000);
    expect(row.subDistrict).toBe('คลองตันเหนือ');
  });
```

And one that pins the CHECK:

```ts
  it('rejects a negative registered capital at the database', async () => {
    const result = await createMember(
      { ...baseInput, registered_capital_thb: -1 },
      meta,
    );
    expect(result.ok).toBe(false);
  });
```

(The zod `nonnegative()` catches this first — that is fine and intended; the test pins the behaviour, not the layer.)

- [ ] **Step 10: Run it**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/members/create-member.test.ts
```

Expected: PASS against the `dev` Neon branch.

- [ ] **Step 11: Commit**

```bash
git add drizzle/migrations/0245_members_registered_capital_and_sub_district.sql \
        drizzle/migrations/meta/_journal.json \
        src/modules/members/ src/app/api/members/_serialise.ts \
        tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts \
        tests/integration/members/create-member.test.ts
git commit -m "feat(members): add registered_capital_thb + sub_district columns

registered_capital_thb (ทุนจดทะเบียน) is a NEW field, not a rename of
turnover_thb — turnover gates the F2 plan band and drives F8 tier upgrades.

sub_district (แขวง/ตำบล) is the Thai address level the existing five address
columns cannot express. Not overloaded onto address_line2, which holds
building/floor/soi on legacy rows."
```

---

### Task 2: `sub_district` reaches the tax document

**⚠️ This task changes what is printed on a §86/4 tax invoice. It must be reviewed by a tax-aware reviewer.**

`composeBuyerAddress` assembles the buyer address and `makeMemberIdentitySnapshot` **freezes it at issue**. If `sub_district` is not threaded here, a member who fills it in has it silently absent from every tax invoice — an RD-completeness defect, not a display gap.

Safety: the address is frozen per-document at issue time, so **already-issued documents do not change** and re-render byte-identical. Production currently holds zero members and zero invoices.

**Files:**
- Modify: `src/modules/invoicing/infrastructure/adapters/compose-buyer-address.ts:23-31` (`BuyerAddressParts`) and `:49-51` (the locality line)
- Modify: `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts` — the raw SQL SELECTs (`:52-92`) **and** the `composeBuyerAddress` call site (`:170-177`)
- Test: the existing `composeBuyerAddress` unit test
- Test: `tests/integration/invoicing/member-identity-branch.test.ts`

**Interfaces:**
- Consumes: `Member.subDistrict` (Task 1).
- Produces: `BuyerAddressParts.subDistrict: string | null`.

- [ ] **Step 1: Write the failing unit test**

In the existing `composeBuyerAddress` unit test file:

```ts
  it('places the sub-district before the district on the locality line', () => {
    expect(
      composeBuyerAddress({
        addressLine1: '123 ถนนสุขุมวิท',
        addressLine2: null,
        subDistrict: 'คลองตันเหนือ',
        city: 'เขตวัฒนา',
        province: 'กรุงเทพมหานคร',
        postalCode: '10110',
        country: 'TH',
      }),
    ).toBe('123 ถนนสุขุมวิท\nคลองตันเหนือ เขตวัฒนา กรุงเทพมหานคร 10110');
  });

  it('drops a blank sub-district without leaving a double space', () => {
    expect(
      composeBuyerAddress({
        addressLine1: '123 Sukhumvit Rd',
        addressLine2: null,
        subDistrict: null,
        city: 'Watthana',
        province: 'Bangkok',
        postalCode: '10110',
        country: 'TH',
      }),
    ).toBe('123 Sukhumvit Rd\nWatthana Bangkok 10110');
  });
```

The second case is the regression guard: every existing member has `sub_district = NULL`, so the *old* output must be byte-identical.

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run <the composeBuyerAddress test path>
```

Expected: FAIL — `subDistrict` is not a member of `BuyerAddressParts` (a TS error in the test), and the locality line omits it.

- [ ] **Step 3: Thread it through**

`compose-buyer-address.ts` — add to `BuyerAddressParts` (`:23-31`), immediately before `city`, with a comment recording the Thai ordering:

```ts
  readonly addressLine2: string | null;
  /**
   * แขวง/ตำบล. Sits BETWEEN address_line2 and the district on a Thai address.
   * NULL on every legacy row, which is why the locality join must stay
   * blank-dropping — the pre-sub-district output has to remain byte-identical.
   */
  readonly subDistrict: string | null;
  readonly city: string | null;
```

and add it to the locality array (`:49-51`) **first**, since `.filter(p => p.length > 0)` already drops blanks:

```ts
  const locality = [
    clean(parts.subDistrict),
    clean(parts.city),
    clean(parts.province),
    clean(parts.postalCode),
  ]
    .filter((p) => p.length > 0)
    .join(' ');
```

`member-identity-adapter.ts` — add `m.sub_district` to **both** raw SQL SELECTs (`:52-92`; a schema-only change will not surface it) and pass it at the call site (`:170-177`):

```ts
        address: composeBuyerAddress({
          addressLine1: m.address_line1,
          addressLine2: m.address_line2,
          subDistrict: m.sub_district,
          city: m.city,
          province: m.province,
          postalCode: m.postal_code,
          country: m.country,
        }),
```

- [ ] **Step 4: Run the unit tests**

```bash
pnpm vitest run tests/unit/invoicing/
```

Expected: PASS, and every pre-existing `composeBuyerAddress` expectation still passes unchanged (they all pass `subDistrict: null` once you add the key — if any expected string changed, the blank-dropping is broken and you must fix it, not the test).

- [ ] **Step 5: Write the failing integration test**

In `tests/integration/invoicing/member-identity-branch.test.ts` — this file exists precisely because the raw-SQL SELECT can drift from the schema without typecheck catching it (see its header):

```ts
  it('carries the sub-district into the frozen buyer address', async () => {
    // seed a member with a full Thai address including sub_district,
    // then load the identity snapshot the way the issue path does
    const identity = await loadMemberIdentity(tenant, memberId);
    expect(identity.address).toContain('คลองตันเหนือ');
    expect(identity.address).toMatch(/คลองตันเหนือ เขตวัฒนา/);
  });
```

Use the file's own seeding helpers and its `loadMemberIdentity` (or equivalently named) entry point — do not invent helper names.

- [ ] **Step 6: Run it**

```bash
pnpm vitest run --config vitest.integration.config.ts tests/integration/invoicing/member-identity-branch.test.ts
```

Expected: PASS. If it fails with an undefined `sub_district`, the raw SQL SELECT was missed — that is exactly the drift this suite guards.

- [ ] **Step 7: Commit**

```bash
git add src/modules/invoicing/ tests/unit/invoicing/ tests/integration/invoicing/
git commit -m "feat(invoicing): thread sub_district onto the §86/4 buyer address

composeBuyerAddress freezes the buyer address onto the immutable identity
snapshot at issue. Without this, a member who fills in แขวง/ตำบล has it
silently absent from every tax invoice — an RD-completeness defect, not a
display gap.

Already-issued documents are unaffected (the address is frozen per document)
and re-render byte-identical: every legacy row has sub_district NULL, and the
locality join drops blanks."
```

---

### Task 3: Postal lookup — pure resolver + server route

The dataset (`src/lib/thai-postal/data.json`, committed in `52900432`) is **367 KB / 97 KB gzipped**. It must never enter a client bundle. An admin form can afford one round-trip on postcode entry.

The data is **not 1:1**: of 955 postal codes, 781 map to one district, 144 to two, 26 to three, 4 to four — and **8 span two provinces** (13240 = Ayutthaya/Lopburi; also 18220, 22160, 36220, 58130). 10110 alone has 9 sub-districts across 2 districts. So the resolver returns *candidates*; it never guesses.

**Files:**
- Create: `src/lib/thai-postal/lookup.ts`
- Create: `src/app/api/geo/postal/[code]/route.ts`
- Test: `tests/unit/lib/thai-postal-lookup.test.ts`
- Test: `tests/unit/lib/thai-postal-data-integrity.test.ts`
- Test: `tests/contract/geo/postal-lookup.test.ts`

**Interfaces:**
- Produces:
```ts
export type PostalCandidate = {
  readonly subDistrict: { readonly th: string; readonly en: string };
  readonly district: { readonly th: string; readonly en: string };
  readonly province: { readonly th: string; readonly en: string };
};
export function lookupPostalCode(code: string): readonly PostalCandidate[];
```
  and `GET /api/geo/postal/[code]` → `200 { candidates: PostalCandidate[] }` · `404 { error: { code: 'postal_code_not_found' } }` · `400` on a malformed code. Task 6 consumes both.

- [ ] **Step 1: Write the failing resolver test**

Create `tests/unit/lib/thai-postal-lookup.test.ts`. These four cases are the whole point — they are the shapes the UI must survive:

```ts
import { describe, expect, it } from 'vitest';
import { lookupPostalCode } from '@/lib/thai-postal/lookup';

describe('lookupPostalCode', () => {
  it('returns every sub-district for a multi-district code (10110)', () => {
    const candidates = lookupPostalCode('10110');

    expect(candidates).toHaveLength(9);
    const districts = new Set(candidates.map((c) => c.district.th));
    expect(districts).toEqual(new Set(['เขตคลองเตย', 'เขตวัฒนา']));
    expect(new Set(candidates.map((c) => c.province.th))).toEqual(
      new Set(['กรุงเทพมหานคร']),
    );
    expect(candidates.some((c) => c.subDistrict.th === 'คลองตันเหนือ')).toBe(true);
    expect(candidates.some((c) => c.subDistrict.en === 'Khlong Tan Nuea')).toBe(true);
  });

  it('returns candidates spanning TWO provinces for 13240', () => {
    const provinces = new Set(
      lookupPostalCode('13240').map((c) => c.province.en),
    );

    expect(provinces).toEqual(
      new Set(['Phra Nakhon Si Ayutthaya', 'Lopburi']),
    );
  });

  it('returns an empty array for an unknown code', () => {
    expect(lookupPostalCode('99999')).toEqual([]);
  });

  it('returns an empty array for a malformed code rather than throwing', () => {
    expect(lookupPostalCode('abc')).toEqual([]);
    expect(lookupPostalCode('101')).toEqual([]);
    expect(lookupPostalCode('')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm vitest run tests/unit/lib/thai-postal-lookup.test.ts
```

Expected: FAIL — `@/lib/thai-postal/lookup` does not exist.

- [ ] **Step 3: Write the resolver**

Create `src/lib/thai-postal/lookup.ts`:

```ts
/**
 * Thai postal-code → sub-district / district / province resolver.
 *
 * SERVER-ONLY. `data.json` is 367 KB (97 KB gzipped) — importing it from a
 * client component would blow the members-route bundle budget. The only
 * consumer is `/api/geo/postal/[code]`. See `SOURCE.md` for provenance.
 *
 * The data is NOT 1:1 and this function does NOT guess. Of 955 postal codes,
 * 174 map to more than one district and 8 span two provinces (13240 =
 * Ayutthaya/Lopburi). Callers get every candidate and let the admin choose.
 */
import data from './data.json';

export type PostalName = {
  readonly th: string;
  readonly en: string;
};

export type PostalCandidate = {
  readonly subDistrict: PostalName;
  readonly district: PostalName;
  readonly province: PostalName;
};

type PostalData = {
  readonly provinces: ReadonlyArray<readonly [string, string]>;
  readonly districts: ReadonlyArray<readonly [string, string, number]>;
  readonly byZip: Readonly<
    Record<string, ReadonlyArray<readonly [string, string, number]>>
  >;
};

const POSTAL: PostalData = data as PostalData;

const POSTAL_CODE_RE = /^\d{5}$/;

export function lookupPostalCode(code: string): readonly PostalCandidate[] {
  if (!POSTAL_CODE_RE.test(code)) return [];

  const subDistricts = POSTAL.byZip[code];
  if (!subDistricts) return [];

  const candidates: PostalCandidate[] = [];
  for (const [subTh, subEn, districtIndex] of subDistricts) {
    const district = POSTAL.districts[districtIndex];
    if (!district) continue;
    const province = POSTAL.provinces[district[2]];
    if (!province) continue;

    candidates.push({
      subDistrict: { th: subTh, en: subEn },
      district: { th: district[0], en: district[1] },
      province: { th: province[0], en: province[1] },
    });
  }
  return candidates;
}
```

`noUncheckedIndexedAccess` is on, which is why every index is guarded rather than `!`-asserted.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm vitest run tests/unit/lib/thai-postal-lookup.test.ts
```

Expected: PASS, all four.

- [ ] **Step 5: Pin the dataset with a checksum test**

Create `tests/unit/lib/thai-postal-data-integrity.test.ts`. A hand-edit of a 367 KB generated JSON is invisible in review; this makes it loud.

```ts
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * `data.json` is GENERATED (scripts/generate-thai-postal-data.ts) and committed.
 * If you regenerate it, update this hash and `src/lib/thai-postal/SOURCE.md`
 * in the same commit. A failure here means someone hand-edited the dataset.
 */
const EXPECTED_SHA256 =
  'e89c9820179373b1035e67d9965bfd9bfab781b8fa1205901a81c182c4f8609a';

describe('thai-postal data.json', () => {
  it('matches the checksum recorded in SOURCE.md', () => {
    const bytes = readFileSync(
      resolve(process.cwd(), 'src/lib/thai-postal/data.json'),
    );
    const actual = createHash('sha256').update(bytes).digest('hex');

    expect(actual).toBe(EXPECTED_SHA256);
  });
});
```

Run it: `pnpm vitest run tests/unit/lib/thai-postal-data-integrity.test.ts` → PASS. (If it fails, the file's line endings were rewritten — check `.gitattributes` and re-hash the committed bytes rather than editing the JSON.)

- [ ] **Step 6: Write the failing contract test for the route**

Create `tests/contract/geo/postal-lookup.test.ts`. Mock the auth guard the way the other contract tests in `tests/contract/` do (copy the `vi.mock` block from a neighbouring file — e.g. `tests/contract/members/create-member.test.ts:13-31`):

```ts
  it('200 with candidates for a known code', async () => {
    requireStaffContextMock.mockResolvedValue(staffContext);

    const res = await GET(makeRequest(), { params: Promise.resolve({ code: '10110' }) });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.candidates).toHaveLength(9);
  });

  it('404 for an unknown code', async () => {
    requireStaffContextMock.mockResolvedValue(staffContext);

    const res = await GET(makeRequest(), { params: Promise.resolve({ code: '99999' }) });

    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe('postal_code_not_found');
  });

  it('401 when unauthenticated', async () => {
    requireStaffContextMock.mockRejectedValue(new Error('unauthorised'));

    const res = await GET(makeRequest(), { params: Promise.resolve({ code: '10110' }) });

    expect(res.status).toBe(401);
  });
```

The 401 case matters: this is reference data, not tenant data, but an unauthenticated endpoint is still an unnecessary surface. Guard it with the same staff-context helper the other admin routes use — **do not** invent a new auth path; find what `src/app/api/members/route.ts` calls and use that.

- [ ] **Step 7: Run it and watch it fail, then write the route**

```bash
pnpm vitest run tests/contract/geo/postal-lookup.test.ts
```

Expected: FAIL — the route does not exist.

Create `src/app/api/geo/postal/[code]/route.ts`. It is tenant-agnostic reference data — **do not** wrap it in `runInTenant`. Shape:

```ts
/**
 * Thai postal-code lookup for the member-form address section (058 / PR-B).
 *
 * Reference data, not tenant data — no `runInTenant`, no RLS. Staff-guarded
 * anyway: there is no reason to expose an endpoint to the unauthenticated web.
 *
 * The dataset is 97 KB gzipped and lives server-side only; this route is what
 * keeps it out of the client bundle.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ code: string }> },
): Promise<NextResponse> {
  // …staff guard (mirror the helper used by src/app/api/members/route.ts)…

  const { code } = await params;
  const candidates = lookupPostalCode(code);

  if (candidates.length === 0) {
    return NextResponse.json(
      { error: { code: 'postal_code_not_found' } },
      { status: 404 },
    );
  }

  return NextResponse.json(
    { candidates },
    // Immutable reference data — cache hard. It changes when we regenerate the
    // dataset and redeploy, never at runtime.
    { headers: { 'Cache-Control': 'public, max-age=86400, immutable' } },
  );
}
```

Run the contract test again → PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/thai-postal/lookup.ts src/app/api/geo/ tests/unit/lib/ tests/contract/geo/
git commit -m "feat(members): Thai postal lookup — server-side resolver + route

The dataset is 97 KB gzipped and must never enter a client bundle, so the
lookup is a route, not an import. It returns CANDIDATES and never guesses:
174 of 955 postal codes map to several districts and 8 span two provinces."
```

---

### Task 4: Decompose `member-form.tsx` before adding to it

`member-form.tsx` is 1,062 lines and this PR would take it past 1,700. Decompose **first**, as a pure move with no behaviour change — every existing test must stay green without being edited. The single biggest win is `contact-fields.tsx`: the secondary contact (Task 8) is a literal re-render of the primary's fields, parameterised by name-prefix.

**Files:**
- Create: `src/components/members/member-form/member-form.tsx` (composition root), `schema.ts`, `use-member-form-errors.ts`, `sections/company-section.tsx`, `sections/address-section.tsx`, `sections/membership-section.tsx`, `sections/tax-branch-section.tsx`, `sections/contact-fields.tsx`
- Delete: `src/components/members/member-form.tsx`
- Modify: importers — `create-member-client.tsx`, `edit-member-client.tsx`, and the five test files under `tests/unit/members/presentation/`

**Interfaces:**
- Produces: `MemberForm` (same props as today), `buildMemberFormSchema`, `MemberFormValues`, `ResolvedServerFieldError`, `PlanOption` — all re-exported from `src/components/members/member-form/index.ts` so importers change by path only. Plus:
```ts
// sections/contact-fields.tsx
export function ContactFields(props: {
  readonly prefix: 'primary_contact' | 'secondary_contact';
  readonly idPrefix: string;          // 'contact' | 'secondary_contact'
  readonly showDateOfBirth: boolean;
  readonly required: boolean;
}): JSX.Element;
```
  Task 8 renders it a second time.

- [ ] **Step 1: Confirm the safety net before touching anything**

```bash
pnpm vitest run tests/unit/members/presentation/
```

Expected: 230/230 PASS. Write the number down — it must be identical after the move, with **no test file edited** except for the import path.

- [ ] **Step 2: Move, do not rewrite**

Split the file along the seams it already has:

- `schema.ts` — `buildMemberFormSchema` (currently `:67-245`), `MemberFormValues`, `ResolvedServerFieldError`, `PlanOption`. It is already exported for its own unit test, so this is a pure move.
- `use-member-form-errors.ts` — the `summaryEntries` → `summaryItems` mapping (currently `:417-460`).
- `sections/company-section.tsx` · `address-section.tsx` · `membership-section.tsx` · `tax-branch-section.tsx` — one `<fieldset>` each.
- `sections/contact-fields.tsx` — the primary-contact fieldset, parameterised by `prefix` / `idPrefix` / `showDateOfBirth` / `required`. **Keep the DOM ids exactly as they are today for the primary** (`first_name`, `last_name`, `contact_email`, `contact_phone`, `role_title`, `preferred_language`, `date_of_birth`) — the error summary's jump links and every existing test depend on them.
- `member-form.tsx` — `useForm`, the server-field-error effect, the error summary, the section list, the footer. Target < 200 lines.
- `index.ts` — re-export the public surface.

The sections need RHF context. Wrap the form in `<FormProvider>` and have each section call `useFormContext<MemberFormValues>()` — this is what makes `ContactFields` renderable twice without prop-drilling `register` / `errors`.

Two freebies to fold into the move (both are copy-paste duplicates of primitives that already exist):
- The local `RequiredMark` (currently `:292-298`) duplicates `src/components/ui/required-mark.tsx`. Delete the local one, import the primitive. Note its contract: the asterisk is `aria-hidden`, so the input must **also** carry `aria-required="true"` — which it already does.
- The raw `<input type="checkbox">` on the head-office toggle (currently `:770-777`) predates `src/components/ui/checkbox.tsx` (Base UI, with focus ring + `aria-invalid` + indeterminate). Use the primitive. This PR adds more checkboxes.

- [ ] **Step 3: Update the importers**

`create-member-client.tsx` and `edit-member-client.tsx` import from `@/components/members/member-form` — the path still resolves via `index.ts`, so ideally **nothing changes**. The five test files under `tests/unit/members/presentation/` import `{ MemberForm }` from `@/components/members/member-form` and `buildMemberFormSchema` from the same — same story. If any import needs editing, that is a signal the barrel is incomplete; fix the barrel, not the importer.

- [ ] **Step 4: Prove the move changed nothing**

```bash
pnpm vitest run tests/unit/members/presentation/
npx tsc -p tsconfig.tsccheck.json --noEmit
npx eslint src/components/members/member-form/
```

Expected: **230/230, the same number as Step 1**, with no test file modified beyond an import path. Any behavioural test failure means this stopped being a pure move — revert and re-do it in smaller slices.

- [ ] **Step 5: Commit**

```bash
git add src/components/members/
git commit -m "refactor(members): decompose member-form into sections

Pure move, no behaviour change — the same 230 presentation tests pass
unedited. member-form.tsx was 1,062 lines and PR-B would take it past 1,700.

The load-bearing extraction is sections/contact-fields.tsx, parameterised by
name-prefix: the secondary contact is a literal re-render of the primary's
fields. Also drops two copy-paste duplicates of ui/required-mark and
ui/checkbox."
```

---

### Task 5: Country combobox

Today the country field is a free-text `<Input maxLength={2} className="uppercase">` — the admin types `TH` by hand and an invalid code is caught only by a `superRefine`. The reviewer asked for a dropdown. A three-value dropdown (Thailand / Sweden / Others) would make SG/US members unrepresentable, and `members.country` is `char(2)` ISO-3166 that feeds the tax PDF. So: a searchable combobox over the full ISO list, with Thailand and Sweden pinned.

**Files:**
- Create: `src/components/ui/combobox.tsx`
- Create: `src/components/members/country-combobox.tsx`
- Modify: `src/components/members/country-display.tsx` — export the locale loader
- Modify: `src/components/members/member-form/sections/company-section.tsx`
- Test: `tests/unit/components/ui/combobox-a11y.test.tsx`, `tests/unit/members/presentation/country-combobox.test.tsx`

**Interfaces:**
- Consumes: `ContactFields` / section split (Task 4).
- Produces: `Combobox` (ARIA-complete) and `CountryCombobox`.

- [ ] **Step 1: Write the failing ARIA test**

The repo has two combobox-shaped components and **neither is form-grade**. `member-picker.tsx:254-261` is the ARIA reference; `searchable-combobox.tsx:64-75` is missing five of its six hooks and takes an `ariaLabel` prop — which would detach the accessible name from the visible `<Label>` and break the `FieldError` + `FormErrorSummary` wiring the whole member form depends on.

Create `tests/unit/components/ui/combobox-a11y.test.tsx` asserting the full contract on the trigger: `role="combobox"` · `aria-expanded` · `aria-haspopup="listbox"` · `aria-controls` pointing at the rendered listbox's id · `aria-labelledby` pointing at the visible `<Label>` · `aria-describedby` and `aria-invalid` passed through · Escape closes and returns focus to the trigger.

- [ ] **Step 2: Run it, watch it fail, then build the primitive**

Create `src/components/ui/combobox.tsx` by promoting `searchable-combobox.tsx` and adding the five missing ARIA hooks from `member-picker.tsx:254-261`. Keep cmdk's built-in filter (`keywords={[option.label]}` on each `CommandItem`, `value` = the code). Keep the `PopoverContent` sizing idiom `className="w-[var(--anchor-width)] max-w-[calc(100vw-2rem)] p-0" align="start"` — `searchable-combobox.tsx:82-84` records that a `min-w-[20rem]` overflowed a 320 px viewport, so do not reintroduce a min-width.

Props (note: **`aria-labelledby`, not `ariaLabel`** — the accessible name must come from the visible label):

```ts
export type ComboboxOption = {
  readonly value: string;
  readonly label: string;
  readonly detail?: string;
  /** Optional group heading; options sharing a group render under it. */
  readonly group?: string;
};

export function Combobox(props: {
  readonly options: readonly ComboboxOption[];
  readonly value: string;
  readonly onChange: (next: string) => void;
  readonly placeholder: string;
  readonly searchPlaceholder: string;
  readonly emptyMessage: string;
  readonly id: string;
  readonly 'aria-labelledby'?: string;
  readonly 'aria-describedby'?: string;
  readonly 'aria-invalid'?: boolean;
  readonly 'aria-required'?: boolean;
  readonly disabled?: boolean;
}): JSX.Element;
```

- [ ] **Step 3: Build the country combobox**

`country-display.tsx:81-95` already lazy-registers TH/SV ISO-3166 locale data behind an `ensureLocaleLoaded` function — but it is **not exported**. Export it (and the `registered` check), then in `country-combobox.tsx`:

```ts
const names = i18nIsoCountries.getNames(baseLocale); // Record<alpha2, string>
```

Two groups via cmdk's `CommandGroup` headings: a **Suggested** group holding `TH` and `SE`, then **All countries** sorted with `localeCompare(a.label, b.label, baseLocale)`. `getNames` returns `{}` until `registerLocale` has run for that locale, so gate on the same `ready` state `country-display.tsx:104` uses; while loading, fall back to `getAlpha2Codes()` so the option set is stable and the field is never empty.

Wire it into `company-section.tsx` replacing the free-text input. The value stays the uppercase alpha-2 code — nothing downstream changes.

- [ ] **Step 4: Run the tests + commit**

```bash
pnpm vitest run tests/unit/components/ui/ tests/unit/members/presentation/
pnpm test:e2e --grep "@a11y" --workers=1   # only if the user's dev server is up; otherwise note it as not run
```

```bash
git commit -m "feat(members): searchable country combobox with Thailand + Sweden pinned

Replaces a free-text 2-letter input. A three-value dropdown (the reviewer's
literal ask) would make SG/US members unrepresentable — members.country is
char(2) ISO-3166 and feeds the tax PDF.

Promotes searchable-combobox into ui/ with the five ARIA hooks it was missing
(member-picker.tsx:254-261 is the reference). Uses aria-labelledby, not an
ariaLabel prop, so the accessible name stays on the visible <Label> and the
FieldError + FormErrorSummary wiring keeps working."
```

---

### Task 6: Address section — the postcode filters, it never overwrites

**Files:**
- Modify: `src/components/members/member-form/sections/address-section.tsx`, `schema.ts`
- Modify: the three locale files
- Test: `tests/unit/members/presentation/address-section.test.tsx`

**Interfaces:**
- Consumes: `GET /api/geo/postal/[code]` (Task 3), `sub_district` (Task 1), `Combobox` (Task 5).

- [ ] **Step 1: Write the failing tests**

The four cases that matter, all driven through a mocked `fetch` of the lookup route:

1. **Unambiguous code** → province and district are set, an "auto-filled" hint with an **Undo** appears, and a `LiveRegion` announces it.
2. **Ambiguous district (10110)** → **nothing is set**; the district combobox's options are narrowed to the two candidates and the live region says so.
3. **Multi-province code (13240)** → nothing is set; the province combobox is narrowed to two.
4. **Unknown code** → nothing is set, no block, a hint invites manual entry.

Plus: after a district is chosen, the sub-district options are narrowed to that district's.

- [ ] **Step 2: Implement — one widget per field, always**

The rule: **province, district and sub-district are always the same editable combobox. The postcode narrows their option lists; it never silently rewrites a value the admin cannot see.**

Do **not** swap a field between `<Input>`, read-only, and `<Select>` depending on the lookup. That destroys focus on remount, breaks pasting an address block (the postcode handler would overwrite what was just pasted — the single most common admin action), and kills Chrome's address autofill, which the form supports today via `autoComplete="address-level1"` / `address-level2` / `postal-code`. It also trips **WCAG SC 3.2.2 (On Input)** for free.

Announce value changes through `src/components/ui/live-region.tsx` (**SC 4.1.3 Status Messages**). Its docblock is explicit: **mount the region empty and update its content later** — a conditionally-mounted live region is not announced by most screen readers. Add an SC 3.3.2 instruction on the postcode field up front: *"Entering a postcode fills province, district and sub-district."*

Field order and labels for `country = TH`:

| field | column | label (TH) | source |
|---|---|---|---|
| `postal_code` | `postal_code` | รหัสไปรษณีย์ | typed — drives everything |
| `province` | `province` | จังหวัด | auto for 947 of 955 codes |
| `city` | `city` | อำเภอ / เขต | combobox, narrowed by postcode |
| `sub_district` | `sub_district` | แขวง / ตำบล | combobox, narrowed by district |
| `address_line1` | `address_line1` | บ้านเลขที่ / ถนน | typed (**required**) |
| `address_line2` | `address_line2` | อาคาร / ชั้น / ซอย | typed (optional — **unchanged meaning**; legacy rows hold this) |

For `country ≠ TH` the section falls back to plain manual fields (Address line 1/2, City, State/Province, Postal code) and the postcode does nothing. **There is no "Not based in Thailand" checkbox** — the Country field already carries that fact, and a second source of truth can contradict it.

Autofilled names follow the **stored** language, not the UI language: when `country = TH`, store the **Thai** names. `compose-buyer-address.ts` freezes `city + province` onto the §86/4 document, and RC §86/4 วรรคสอง requires the particulars in Thai — so the language printed on a tax document must not depend on which admin happened to key the member in. Show the English name as secondary text inside the picker only.

- [ ] **Step 3: The completeness gate — create blocks, edit warns**

In `schema.ts`'s `superRefine`:

- **Create, TH**: `address_line1` + `sub_district` + `city` + `province` + `postal_code` all present.
- **Create, non-TH**: `address_line1` + `city`. Postal code optional (Hong Kong and the UAE have none).
- **Edit**: never blocks. An incomplete address renders a banner — *"Address incomplete — required before a tax invoice can be issued"* — with a jump link to the section.

Edit must not block, or the imported members become uneditable: an admin could not fix an email without first sourcing an address. This is the same trap PR-0 avoided for `registration_date`.

- [ ] **Step 4: Run the tests + commit**

```bash
git commit -m "feat(members): postcode-driven Thai address, down to แขวง/ตำบล

The postcode FILTERS; it never overwrites. 174 of 955 codes map to several
districts and 8 span two provinces, so an autofill that guesses is wrong by
construction — ambiguous codes narrow the option list instead, and the live
region says so.

Province/district/sub-district stay one editable combobox each: swapping a
field's widget mid-keystroke destroys focus, fights paste, kills Chrome's
address autofill, and trips WCAG 3.2.2.

Thai names are stored for TH members regardless of UI locale — the address is
frozen onto the §86/4 document and RC §86/4 วรรคสอง requires Thai particulars."
```

---

### Task 7: Company section — registered capital, website, collapsible optionals

**Files:** `sections/company-section.tsx`, `schema.ts`, `create-member-client.tsx`, `edit-member-payloads.ts`, the three locale files. Test: `tests/unit/members/presentation/company-section.test.tsx`.

- [ ] **Step 1: Registered capital**

Add the `registered_capital_thb` number input next to `turnover_thb`. **Keep turnover** and give it a hint recording *why* it still exists: *"Used to place the member in a plan's turnover band."* Without that hint the next person deletes it and silently breaks the F2 override gate and F8 tier upgrades.

- [ ] **Step 2: Website accepts a bare domain**

Today `website` is `z.string().url()` — `facebook.com/swecham` is rejected, and an admin must type `https://`. Relabel to **"Website / Online presence"**, placeholder a Facebook-style URL, and normalise a bare domain by prefixing `https://` before validation. Test both: `example.com` → `https://example.com`; `https://facebook.com/x` → unchanged; `not a url` → still rejected.

- [ ] **Step 3: Collapse the genuinely optional fields**

`description`, `notes`, `founded_year`, `registered_capital_thb`, `turnover_thb` are not needed to create a member. Put them behind a `<Collapsible>` "Additional details" (`src/components/ui/collapsible.tsx` — Base UI, so the panel is `CollapsibleContent` → `Panel`, and the trigger composes with `render={…}`, not `asChild`).

**Do not collapse anything required.** A collapsed panel hides validation errors, and `FormErrorSummary`'s jump links would land inside a closed section. Do not wizard the form either — `docs/ux-patterns.md § 3` names single-long-form as exactly the case where a wizard is the wrong answer.

- [ ] **Step 4: Run tests + commit**

---

### Task 8: Secondary contact

**Files:**
- Modify: `src/modules/members/application/ports/member-repo.ts:197-213` (port) and `:90-93` (`RepoError`)
- Modify: `src/modules/members/infrastructure/db/_repo-error.ts:21-27`
- Modify: `src/modules/members/infrastructure/db/drizzle-member-repo.ts:494-564`
- Modify: `src/modules/members/application/use-cases/create-member.ts`
- Modify: `src/app/api/members/route.ts:307-311`
- Modify: `src/components/members/member-create-error-map.ts:48-50`
- Modify: `member-form/schema.ts`, `member-form/member-form.tsx`, `create-member-client.tsx`
- Test: `tests/unit/members/presentation/secondary-contact.test.tsx`, `tests/contract/members/create-member.test.ts`, `tests/integration/members/create-member.test.ts`

**Interfaces:**
- Consumes: `ContactFields` (Task 4).
- Produces: `MemberFormValues.secondary_contact?: {…}`; `RepoError.reason` narrowed to a literal union.

- [ ] **Step 1: UI — additive, not a negative opt-out**

The reviewer asked for a "No secondary contact" checkbox. **Do not build that.** An unchecked-by-default box reading "No secondary contact" makes a second natural person's name/email/phone **required by default** — friction on the majority path, and it inverts GDPR Art. 25(2) (data protection *by default*). It is also a negative checkbox, which users reliably mis-parse.

Instead: a `+ Add a secondary contact` outline button (mirror the Add-contact trigger at `[memberId]/page.tsx:1181-1195`). Clicking it reveals `<ContactFields prefix="secondary_contact" idPrefix="secondary_contact" showDateOfBirth={false} required />` with a Remove affordance. Removing clears the sub-object.

Create form only. The Edit page already has full contact CRUD (add / edit / promote-to-primary) — a second surface would be two sources of truth for the same rows.

- [ ] **Step 2: The 409 must name the right field**

`member-create-error-map.ts:48-50` hard-maps **any** 409 `conflict` to `primary_contact.email`, and its own docblock (`:35-47`) flags the assumption and pre-authorises this change: *"the server's conflict is constraint-agnostic (mapDbError → repo.conflict), so IF a member-level unique constraint is ever added, revisit this hard-mapping or thread a constraint discriminator from the API."*

A secondary contact makes that assumption false: `contacts_tenant_email_uniq` is per-tenant on `lower(email)`, so a collision on the **secondary** email would highlight and focus the **primary** email field.

Three coordinated changes:

1. **`drizzle-member-repo.ts:494-564`** — the whole method body sits in **one** `try/catch` (`:495` / `:561`) whose handler calls `mapDbError(e, 'duplicate')`. `mapDbError` never inspects `err.constraint`, so the only way to discriminate is to **split the try/catch per insert**: member, primary contact, secondary contact — each with its own reason. Factor the contact `.values({…})` block (`:531-551`, where `isPrimary: true` is hardcoded at `:543`) into a local helper taking `isPrimary`.
2. **`RepoError.reason`** (`member-repo.ts:90-93`) is a free-form `string`. Narrow it to `'member_duplicate' | 'primary_email_in_use' | 'secondary_email_in_use'`. This ripples into `_repo-error.ts:21` (the `conflictReason: string` param) and the three other `mapDbError` call sites in `drizzle-contact-repo.ts` (`:125`, `:435`, `:488`) — fix them, do not widen the union to accommodate them.
3. **Route `:307-311`** currently returns `{ error: { code: 'conflict', message: result.error.reason } }` — the reason is leaked into a user-visible message and nowhere else. Add `details: { reason }` (the `soft_duplicate` arm at `:295-306` is the in-repo precedent for putting a discriminator in `details`). Keep `code: 'conflict'` so existing clients do not break. Then `mapMemberCreateServerError` switches on it.

Cheap guard for the commonest case, before any of that DB machinery: a client + server rule that `secondary_contact.email !== primary_contact.email`.

- [ ] **Step 3: One transaction, or none**

The second contact is inserted in the **same transaction** as the member and the primary contact (`createWithPrimaryContactInTx` already receives the `tx` from `runInTenant` — no new tenant-context plumbing). It carries `isPrimary: false` (`contacts_one_primary_per_member` is a partial unique index and would reject a second primary) and needs its own `deps.idFactory.contactId()`.

Emit a second `contact_created` audit event in the same tx (`create-member.ts:434-445` is the template, with `is_primary: false`). **No new audit event type** — the 4-place enum change is not needed.

Integration test (live Neon): a member created with a secondary contact whose email collides **rolls back as a unit** — no orphan member row, no orphan primary contact.

- [ ] **Step 4: Run all three layers + commit**

```bash
pnpm vitest run tests/unit/members/ tests/contract/members/
pnpm vitest run --config vitest.integration.config.ts tests/integration/members/create-member.test.ts
```

```bash
git commit -m "feat(members): optional secondary contact on member create

Additive (+ Add a secondary contact), not the negative opt-out the reviewer
asked for: an unchecked 'No secondary contact' box makes a second natural
person's PII required by default, which inverts GDPR Art. 25(2).

Inserted in the same transaction as the member and primary contact, and the
409 now names the field that actually collided — createWithPrimaryContactInTx
wrapped every insert in ONE try/catch with a literal 'duplicate' reason, so a
secondary-email collision used to highlight the PRIMARY email field."
```

---

### Task 9: Unsaved-changes guard + bundle budgets

- [ ] **Step 1: The guard**

`docs/ux-patterns.md § 4.2` names "member edit" explicitly, and two forms already implement it — `issue-invoice-form.tsx:191-213` and `compose-form.tsx:163-183`. `member-form.tsx` has none, and this PR roughly doubles the form. Losing ~40 filled fields to a stray back-click is a real and expensive failure.

Copy the established shape exactly: a `useEffect` computing `dirty = !submitting && <divergence>`, an **early return when not dirty** (so the listener is attached only while dirty), a handler doing `e.preventDefault(); e.returnValue = '';`, a cleanup that removes the listener, and every input to `dirty` in the dep array. Use react-hook-form's `formState.isDirty` as the divergence source and the existing `submitting` prop as the flag. Both existing implementations note that App Router exposes no clean SPA route-change interception — this covers tab close, hard nav, and refresh.

- [ ] **Step 2: Bundle budgets**

`scripts/check-bundle-budgets.ts`'s `BUDGETS` array (`:44-64`) covers only the F7 and F8 routes — **the members routes have no budget**, so nothing would catch a regression that pulls the 97 KB postal dataset into the client. Add, under a new banner comment:

```ts
  // --- Members (058 / PR-B) --------------------------------------------
  // The Thai postal dataset (97 KB gzipped) is server-only, behind
  // /api/geo/postal/[code]. If it ever lands in the client bundle, these
  // budgets are what catches it.
  { route: '/admin/members/new', maxKb: 150 },
  { route: '/admin/members/[memberId]/edit', maxKb: 150 },
```

Then **verify the budget actually measures something**: `findPageChunks` (`:107-119`) *skips* a route with no matching chunks, logging `no chunks (route may be server-only)` — so a typo in the route string passes silently. Run `pnpm build && pnpm check:bundle-budgets` and confirm the two members routes are **measured**, not skipped.

- [ ] **Step 3: Commit**

---

### Task 10: Full gate run and PR

- [ ] **Step 1: The pipeline**

```bash
pnpm lint && npx tsc -p tsconfig.tsccheck.json --noEmit && pnpm check:i18n && pnpm check:layout && pnpm check:fixme && pnpm check:strict-aria && pnpm check:multi-tenant
pnpm vitest run tests/unit/ tests/contract/
pnpm vitest run --config vitest.integration.config.ts tests/integration/members/ tests/integration/invoicing/
pnpm build && pnpm check:bundle-budgets
```

- [ ] **Step 2: E2E**

`pnpm test:e2e --grep "@a11y" --workers=1` needs the dev server on :3100 that the **user** owns. Ask before running; never start or kill one. If it cannot be run, say so plainly in the PR body rather than implying it passed.

- [ ] **Step 3: Push and open the PR**

The PR body must state that **Task 2 changed the tax-document render path** and name the tax reviewer requirement.

---

## Self-review notes

- **Spec coverage**: § 3 rows 1 (country), 6 (website), 7 (capital), 8 (address), 10 (secondary contact); § 9 (address, sub-district, dataset); § 10 (contacts); § 11 (layout, decomposition, guard, combobox, primitives). Not in this PR by design: the entity-type catalogue, `is_vat_registered`, the Tax-ID invariant and the passport guards — those are PR-A, which is blocked on three accountant questions (§ 15).
- **Deliberate divergences from the spec's own text**, both discovered while researching: the dataset is **97 KB gzipped, not 40–80 KB**, so it is a server route rather than a client lazy-import; and it carries **sub-districts**, which the reviewer's spreadsheet did not, so the address can be complete rather than merely better.
- **Risk**: Task 2 (tax path) and Task 8 (splitting the repo's single try/catch, which ripples into `RepoError.reason` and three `drizzle-contact-repo.ts` call sites) are the two places where a shallow implementation will look fine and be wrong. Both have live-Neon integration tests as the net.
- **Ordering is load-bearing**: Task 4 (decompose) must precede 5–8, or they land in a 1,700-line file. Task 1 must precede 2, 6, 7.
