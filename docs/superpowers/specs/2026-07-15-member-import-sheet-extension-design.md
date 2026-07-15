# Member Import — Real-Sheet Extension (PR-C) — Design

**Date:** 2026-07-15
**Branch:** `060-member-tax-id-required` (cut from `main` after PR-A `973b4cc7` #194).
**Supersedes for the importer:** the "Task 7" section of
`docs/superpowers/plans/2026-07-14-member-form-pr-a-tax-correctness.md` was written
against a hypothetical minimal sheet. This design maps the importer onto the
**real** TSCC workbook and folds in the extra columns TSCC actually supplied.

**Gate:** tax + security sign-off, ≥2 reviewers (touches the tax-document data
path via `legal_entity_type` + `is_vat_registered` + `tax_id`).

---

## Goal

Extend the existing Stage-3 member importer so it can consume the real TSCC sheet
`docs/import/Membership Database_Since 2025(...)_v2_Excel.xlsx`, sheet
**`Member Data New`** (150 rows), and load **member + contact + entity-type/VAT +
one renewal cycle** per member. Plus close PR-A's two deferred tasks: Task 7
(entity-type/VAT in the importer) and Task 9 (the conditional Tax-ID asterisk).

**This is a member-data import only** — it does **not** create F4
invoice/receipt documents. Columns F/H/I/J (invoice no., invoice status, receipt
no., payment date) are **not** imported. (Decision 2026-07-15.)

## Scope decisions (locked 2026-07-15)

1. **Member data only.** No F4 invoice/receipt document creation. `members` is
   empty in prod (wiped 2026-07-12), so this is the one place every member gets
   its entity type + VAT flag, once.
2. **Renewal anchor = column G ("Latest INV Date (Membership Start)").**
   `registration_date` = G; the initial renewal cycle uses `periodFrom = G`,
   `periodTo = G + 12mo`, with `anchorToCurrentPeriod = now`. Verified: column K
   ("Renewal date") = G + 12 months on **all 150 rows**, so `periodTo` equals K
   exactly. K is therefore *derived*, never read.
3. **N/A rows: skip + report in round 1; resolve in round 2.** country=N/A (19
   rows) and plan=N/A/blank (21 rows) are **not guessed** (both feed
   tax/billing) — they are reported and skipped. The operator fixes the sheet and
   re-runs (the importer's email-based dedupe makes re-run idempotent).
4. **sub_district = empty.** The sheet has no sub-district column; members/admins
   fill it later.
5. **Include the extra directory fields** TSCC supplied: website, founded year,
   registered capital, description, address lines.
6. **status ← column T ("Member Status").** Active→`active`, Inactive→`inactive`.
   An `inactive` member gets **no** renewal cycle (kept out of the F8 pipeline).

## Verified facts (de-risk, measured against the real sheet)

- **Tax ID:** 113 rows are 12-digit (Excel ate the leading zero); after
  left-padding one `0` to 13 digits, **all 113 pass the Thai RD checksum
  (113/113)**. The other 37 rows are non-numeric ("N/A"/blank) → stored `null`.
- **Country:** `getAlpha2Code` resolves uppercase `THAILAND`→`TH`, `SWEDEN`→`SE`.
  `N/A` is unresolved (→ skip+report).
- **Anchor:** K = G + 12 months on 150/150 rows; G is present on 150/150.
- **Entity type (column E):** distribution matches the plan exactly — 111 `Private
  Limited Company (Company Limited)` · 15 `Individual` · 10 `N/A` · 7 `State
  Enterprise` · 5 `Public Limited Company` · 2 `Foundation`.

## Column → field mapping (`Member Data New`)

| Sheet col | Header | → importer field | members column |
|---|---|---|---|
| C | Company | companyName | company_name |
| E | Member Type | **legalEntityType** (Task 7 coercer) | legal_entity_type |
| — | (derived) | **isVatRegistered** | is_vat_registered |
| D | Tax ID | taxId (pad-13; N/A→null) | tax_id |
| S | Plan | tier | plan_id |
| L | Country (ISO post) | country | country |
| O | Annual Turnover (THB) | turnover | turnover_thb |
| P | Capital registeration | registeredCapital | registered_capital_thb |
| M | Webiste *(sheet typo)* | website | website |
| N | Founded year | foundedYear | founded_year |
| Q | Description | description | description |
| G | Latest INV Date (Membership Start) | registrationDate + cycle anchor | registration_date |
| X | Postal code | postalCode | postal_code |
| Y | Province / State | province | province |
| Z | City / Distrct *(sheet typo)* | city | city |
| AA | Address Line 1 | addressLine1 | address_line1 |
| AB | Address Line 2 | addressLine2 | address_line2 |
| T | Member Status | status | status |
| A | Name | contact full-name fallback | (contacts) |
| AC | First name (Primary contact) | contactFirstName | (contacts) |
| AD | Last name (Primary contact) | contactLastName | (contacts) |
| AE | Email (Primary contact) | contactEmail | (contacts) |

**Not imported:** F (Latest Invoice No.), H (Invoice Status), I (Receipt No.),
J (Receipt/Payment Date), K (Renewal date — derived), B (Code), and the empty
phone/role/language/secondary-contact columns.

**Contact name:** AC/AD are empty on all 150 rows, so the contact name is taken
from A "Name" via the importer's existing `fullNameIndex` split fallback. If a
future sheet fills AC/AD, those win (existing precedence).

## New header aliases (why "map into the existing importer" needs work)

The real headers carry parenthetical suffixes that don't match the current exact
aliases. Add to `HEADER_ALIASES` (normalized forms):

- country: `country iso post`
- contactEmail: `email primary contact` *(required field — without this the
  import refuses the whole file)*
- contactFirstName: `first name primary contact`
- contactLastName: `last name primary contact`
- province: `province state`
- city: `city distrct` *(match the sheet's misspelling)* + `city district`
- turnover: `annual turnover thb`
- registrationDate: `latest inv date membership start` + `membership start`
  *(column G; it precedes the empty column U "Registration date", so first-match
  order resolves to G — self-checking, since a wrong pick at the empty U would
  make every row fail `date.empty` and the operator would see it immediately)*

**Move** `member type` OFF `tier`'s alias list ONTO the new `legalEntityType`
field. `tier` then resolves to column S "Plan" (its remaining alias `plan`).
Without the move, `tier` mis-grabs column E (member type) — trap #3 in the plan.

## New importer fields

`RawRow` + `ValidatedMember` gain: `legalEntityType`, `isVatRegistered`,
`status`, `website`, `foundedYear`, `registeredCapitalThb`, `description`,
`addressLine1`, `addressLine2`. The commit insert writes all of them.

## Edge rules

1. **Tax ID normalize + pad.** Treat `N/A` / `-` / `na` / blank as empty (→ null,
   warning). Otherwise strip non-digits; if country=TH and exactly 12 digits,
   left-pad one `0` to 13; then run `asTaxId` (checksum). A supplied-but-invalid
   value still errors (loud), as today.
2. **Country.** THAILAND/SWEDEN resolve; `N/A`/blank → unresolved → per-row error
   → member skipped + reported (round 2 fixes it). No TH default (fail-loud, per
   the 2026-06-02 operator decision).
3. **Plan.** `N/A`/blank/unknown tier → per-row error → skipped + reported. Cannot
   guess a tier (drives §86/4 price). Student/Gold/Platinum resolve iff a matching
   plan is seeded for the plan-year — the dry-run report reveals which resolve.
4. **is_vat_registered derivation** (Task 7, load-bearing):
   `isVatRegistered = VAT_DEFAULT_BY_CODE[code] === true && taxId !== null`.
   The 7 State Enterprises have no TIN, so they import as `is_vat_registered:false`
   (an admin ticks the box when a TIN arrives) — otherwise Task 4's
   `registrant ⇒ TIN` invariant (live on prod) rejects them at create. Emit a
   warning for `association`/`foundation` (`VAT_DEFAULT_BY_CODE === null`) so the
   report flags them for manual confirmation.
5. **status ← T.** Active→`active`, Inactive→`inactive`, unknown/blank→`active`
   (with warning). **inactive members get no renewal cycle** (skip
   `createCycleInTx`).
6. **sub_district** left null.

## Entity-type coercer (Task 7)

New `scripts/import-members/entity-type.ts`, contract
`coerceLegalEntityType(raw): Result<LegalEntityTypeCode | null, EntityTypeResolveError>`,
consuming `LegalEntityTypeCode` + `VAT_DEFAULT_BY_CODE` from `@/modules/members`
(shipped in PR-A). Maps the 6 real values:

| Excel value | code |
|---|---|
| `Private Limited Company (Company Limited)` | `limited_company` |
| `Individual` | `individual` |
| `State Enterprise` | `state_enterprise` |
| `Public Limited Company` | `public_company` |
| `Foundation` | `foundation` |
| `N/A` / blank | `null` |

Fail-loud on any unmapped value (mirror `countryNameToCode`), so a new legal form
stops the row rather than importing as NULL. Trap #2: `Individual` also appears in
column S (the Plan) — the coercer must only ever see column E.

## File changes

- **New:** `scripts/import-members/entity-type.ts`
- `scripts/import-members/columns.ts` — aliases + alias move + new `RawRow` fields
  + `mapDataRows` wiring
- `scripts/import-members/coerce.ts` — tax-id normalize/pad-13 helper; status
  coercer; (founded-year / capital number parse or reuse `parseTurnover`)
- `scripts/import-members/validate.ts` — `ValidatedMember` new fields; VAT
  derivation; entity-type parse + warnings; tax-id pad in the tax block
- `scripts/import-members.ts` — insert new columns; `status` from T;
  `createCycleInTx` only when `status === 'active'`
- **Task 9:** `src/components/members/member-form/sections/company-section.tsx` —
  conditional `RequiredMark` + `aria-required` on the Tax-ID field, watching
  `is_vat_registered` (the zod rule already exists at `schema.ts:425`)
- **Tests:** `tests/unit/scripts/import-members-entity-type.test.ts`,
  `tests/unit/scripts/*` importer-extension coverage,
  `tests/unit/members/presentation/company-section.test.tsx`

## Test plan (TDD)

- **entity-type coercer:** the 6 real values + `Individual`-not-the-plan trap +
  fail-loud on unmapped.
- **tax-id pad:** 12-digit TH → padded + checksum passes; `N/A` → null; a genuine
  bad value → error.
- **columns/aliases:** the real headers resolve; `member type` no longer collides
  with `tier`; email/country/name resolve.
- **VAT derivation:** state_enterprise (no TIN) → `false`; limited_company + TIN →
  `true`; foundation → `false` + warning.
- **status + cycle:** inactive → status inactive + no cycle; active → cycle.
- **Task 9:** VAT ticked → asterisk + `aria-required="true"`; unticked → neither
  (Base UI Checkbox: drive `input#is_vat_registered`, not the `<span role>`).

## Dry-run acceptance

`TENANT_SLUG=swecham pnpm tsx scripts/import-members.ts --file <sheet> --plan-year 2026`
(no `--commit`) → the report shows:

- entity-type histogram 111/15/7/5/2 + 10 null,
- ~110–125 valid members, the rest reported as country=N/A / plan=N/A / unresolved
  tier (round-2 backlog),
- foundation/association rows warned for manual VAT confirmation.

Then `--commit` against the **dev** Neon branch first; prod commit is a separate,
gated operator step (deploy checklist:
`SELECT count(*) FROM members WHERE is_head_office=false` = 0 — true today).

## Out of scope / round 2

- Fixing + re-importing the ~19–21 country/plan-N/A rows (operator edits the sheet;
  re-run is idempotent).
- F4 historical invoice/receipt document import (explicitly not done).
- The Art. 14 attestation (Task 8) and the three passport guards (Task 6) — those
  are separate PR-A residuals, not part of this import extension.

## References

- Plan: `docs/superpowers/plans/2026-07-14-member-form-pr-a-tax-correctness.md`
  (Task 7 coercer contract, Task 9 asterisk).
- Hand-off: `docs/superpowers/handoffs/2026-07-15-pr-c-task7-importer-task9-asterisk.md`.
- Memory: `project_member_import_blocker` (prior import run; the `tax_id` relax +
  mononym `-` fixes are already committed), `project_invoice_date_anchor_rejected`,
  `project_renewal_paid_invoice_disconnect`.
