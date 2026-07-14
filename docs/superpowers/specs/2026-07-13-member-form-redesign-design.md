# Member Form Redesign — Design (v3)

**Date**: 2026-07-13, amended 2026-07-14
**Status**: v3 — **§ 16 supersedes anything it contradicts in §§ 1–15.** v2 was rewritten after a 6-agent review (architecture · Thai tax · UX · migration · PDPA/GDPR · QA), every one of which returned blocking findings against v1. v3 then folds in three things that only arrived later: TSCC's accountant answering the tax-language question, legal research verifying every citation against rd.go.th primary text, and TSCC's actual 150-member spreadsheet. **Every blocking question is now closed — PR-A is unblocked.**
**Origin**: Reviewer feedback on the admin member create/edit form (SweCham / TSCC)
**Ship shape**: **three PRs** — see § 2.

---

## 1. What this actually is

The reviewer asked for nine form changes. The review revealed that one of them — replacing the free-text "legal entity type" with a real dropdown — is not cosmetic:

**`members.legal_entity_type` is NULL on essentially every row today** (the CSV importer never writes it; the form field is an empty free-text input). The §86/4 buyer head-office/branch discriminator is derived from that column and fails closed, so **no member has ever received the "สำนักงานใหญ่ / สาขาที่ …" particular on a tax invoice.** Per ประกาศอธิบดีฯ (VAT) ฉบับที่ 199, that particular is mandatory on a full tax invoice whenever the buyer is a VAT registrant.

Exposure today ≈ zero (production was wiped 2026-07-12; members = 0). Exposure the moment TSCC onboards its ~119 members and starts issuing: **every tax invoice to a VAT-registrant member is systematically missing a mandatory particular.**

So this is not form polish. The tax-correctness half is a **go-live prerequisite** and ships on its own PR, ahead of the UX half.

## 2. Ship plan — three PRs

| PR | Contents | Gate |
|---|---|---|
| **PR-0 — pre-existing bug fixes** | `notes` dead on create · `registration_date` dead on edit (→ read-only + tooltip) · 8 fields with no inline error wiring | normal review |
| **PR-A — tax correctness (go-live blocker)** | entity-type catalogue reconciled with the shipped i18n vocabulary · `is_vat_registered` column + migration + backfill · re-point **all four** discriminator consumers · the `registrant ⇒ TIN` invariant · scrub/erasure classification · tax integration tests | **tax + security sign-off, ≥2 reviewers** |
| **PR-B — form UX** | country combobox · postcode-driven address · registered capital · website relabel · secondary contact · decomposition of `member-form.tsx` · unsaved-changes guard | normal review |

## 3. Decisions

| # | Reviewer asked | Decision | Why |
|---|---|---|---|
| 1 | Country dropdown: Thailand / Sweden / Others (specify) | **Searchable combobox** over the full ISO-3166 list, Thailand + Sweden pinned in a "Suggested" group | `members.country` is `char(2)` ISO-3166 and feeds the tax PDF. Three values make SG/US members unrepresentable. |
| 2 | Tax ID: 13 digits or cannot save; zero-pad shorter foreign IDs | **No zero-padding.** Store foreign IDs verbatim; omit the Tax ID line on the document when the buyer is not a Thai VAT registrant | Confirmed by the tax audit: a padded number collides with the Thai 13-digit namespace and **can match a different real taxpayer**; e-Tax Invoice would reject it or, worse, match the wrong party. It is also a false particular on a tax document. **Pushback to reviewer — hold firm.** |
| 3 | Tax ID required (13 digits) | **Required on CREATE** for a Thai juristic entity or any VAT registrant. **Edit warns, never blocks.** Also **blocked at ISSUE** when `is_vat_registered = true` and `tax_id` is NULL | Maintainer decision (2026-07-13). Note it reverses the accepted product decision recorded at `tax-id.ts:6-11` / UAT TC-MBR-04. Edit must not block, or the imported members become uneditable — the same trap avoided for the address (#8). The issue-time gate is where §86/4 actually bites. |
| 4 | Legal entity type → dropdown with 14 Thai types + popup | **"Entity type / ประเภทนิติบุคคล"** — a dropdown whose option list swaps by country; descriptions render **inline in each option**, not in a popover | "Member Type" collides with the F2 plan concept `member_type_scope` (individual / corporate), which gates the DOB field. The 14 types are Thai legal forms — a Swedish *AB* matches none. A 14-row table does not fit `PopoverContent` (`popover.tsx:40` hard-codes `w-72` = 288 px). |
| 5 | — (addition) | **`is_vat_registered` boolean**, always shown, defaulted from the entity type | The §86/4 branch particular is gated on "is the buyer a VAT registrant". Today that is *guessed* from the entity type, which is wrong for several forms — **and TSCC itself is an association that IS VAT-registered**, so the guess is not even directionally safe. VAT registration is a function of turnover (>1.8 M THB/yr, §85/1), not of legal form. |
| 6 | Website or online presence (Website, Facebook) | Keep the single `website` column; relabel, accept a bare domain (auto-prefix `https://`) | No migration; a Facebook page URL is a URL. |
| 7 | "annual turnover" → "Capital registration (ทุนจดทะเบียน)" | **Add `registered_capital_thb`; keep `turnover_thb`** | `turnover_thb` gates the F2 plan turnover band (out-of-band ⇒ mandatory override) and drives F8 tier-upgrade suggestions. Relabelling would silently re-point a membership-tier rule at a different quantity. |
| 8 | Address: postcode autofill; "Not based in Thailand" → manual; must be complete to save | Postcode drives the address **through the Country field** (no separate checkbox); required **on create only**; postcode **filters, never overwrites** | A separate checkbox is a second source of truth that can contradict `country`. Requiring a complete address on edit would lock the imported members. **Pushback to reviewer on the checkbox.** |
| 9 | Registration Date tooltip | Tooltip **+ read-only on Edit** | The field is currently rendered, seeded, and silently discarded on save. It is also the F8 renewal-cycle anchor. Re-anchoring is deferred (§ 12). |
| 10 | Secondary contact + "No secondary contact" | **`+ Add a secondary contact`** button — additive, not a negative opt-out. Create form only | An unchecked "No secondary contact" box makes a second person's PII required-by-default, which inverts GDPR Art. 25(2) and adds friction to the majority path. The Edit page already has full contact CRUD. |

## 4. The VAT-registrant discriminator — four consumers, not one

v1 claimed there was one derivation site. There are four, and one of them **re-implements the rule by hand**:

| site | today | after PR-A |
|---|---|---|
| `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts:197` | `isVatRegistrantEntityType(m.legal_entity_type)` | read `m.is_vat_registered` (**add the column to both raw SQL SELECTs at `:52-92`** — a schema-only change will not surface it) |
| `src/app/(staff)/admin/invoices/_lib/issue-review.ts:70-85` | **hand-rolled `norm === 'individual'` check**, no helper | take `buyerIsVatRegistrant: boolean` as input; warning `no_branch_line_null_entity_type` → `no_branch_line_not_vat_registrant` |
| `src/app/(staff)/admin/invoices/_components/issue-invoice-form.tsx:172` | passes the literal `'individual'` as a sentinel to suppress the line for non-membership invoices | pass `buyerIsVatRegistrant: isMembership ? member.isVatRegistered : false` |
| `src/components/members/member-form.tsx:236` | `isVatRegistrantEntityType(legal_entity_type)` gates branch code | gate on the `is_vat_registered` field value |

If only the adapter is re-pointed, the **pre-issue preview dialog will tell the admin the branch line prints while the PDF omits it** — exactly the class of defect 088 US3 was created to fix.

**`isVatRegistrantEntityType()` is deleted from production code** once these four are re-pointed. It survives only inside the backfill. Leaving it "as the checkbox-default helper" (v1's plan) reintroduces the bug it exists to cause — it returns `true` for `association`, `foundation`, `representative_office`, `cooperative` and (after the legacy remap) `sole_proprietorship`. The checkbox default comes from `VAT_DEFAULT_BY_CODE` instead.

Also update `scripts/verify-088-cutover.ts:213-219`, which audits `legal_entity_type IS NULL` as the "branch line fails closed" gate — after the cutover it would pass while measuring nothing.

## 5. Entity type catalogue

**A vocabulary already exists and ships translated.** `src/i18n/messages/{en,th,sv}.json:1117-1129` carries `admin.members.detail.legalEntityTypes` — **11 keys, complete in EN/TH/SV**:

`company · limited_company · public_company · partnership · sole_proprietor · individual · foundation · association · government · branch · representative_office`

The resolver at `src/app/(staff)/admin/members/[memberId]/page.tsx:184-195` does `tTypes.has(key) ? tTypes(key) : trimmed` — **a miss renders the raw code, silently.** v1 invented near-miss names (`sole_proprietorship` vs `sole_proprietor`, `private_limited_company` vs `limited_company`, `branch_office` vs `branch`) which would have printed `private_limited_company` on the member detail page. **Reuse the existing keys wherever the concept matches; add only what is genuinely new.**

### Canonical codes (country = TH)

| code | ไทย | English | VAT default |
|---|---|---|---|
| `sole_proprietor` *(existing key)* | บุคคลธรรมดา | Sole Proprietorship | ☐ |
| `partnership` *(existing)* | ห้างหุ้นส่วนสามัญ | Ordinary Partnership | ☐ |
| `registered_ordinary_partnership` | ห้างหุ้นส่วนสามัญจดทะเบียน | Registered Ordinary Partnership | ☑ |
| `limited_partnership` | ห้างหุ้นส่วนจำกัด | Limited Partnership | ☑ |
| `limited_company` *(existing)* | บริษัทจำกัด | Private Limited Company | ☑ |
| `public_company` *(existing)* | บริษัทมหาชนจำกัด | Public Limited Company | ☑ |
| `joint_venture` | กิจการร่วมค้า | Joint Venture | ☑ |
| `branch` *(existing)* | สำนักงานสาขาของบริษัทต่างประเทศ | Branch Office | ☑ |
| `representative_office` *(existing)* | สำนักงานผู้แทน | Representative Office | ☐ |
| `regional_office` | สำนักงานภูมิภาค | Regional Office | ☐ |
| `association` *(existing)* | สมาคม | Association | **no default — admin must choose** |
| `foundation` *(existing)* | มูลนิธิ | Foundation | **no default — admin must choose** |
| `cooperative` | สหกรณ์ | Cooperative | **no default — pending accountant (§ 13)** |
| `state_enterprise` | รัฐวิสาหกิจ | State Enterprise | ☑ |
| `government` *(existing)* | หน่วยงานราชการ | Government Agency | ☐ |
| `embassy_intl_org` | สถานทูต / องค์การระหว่างประเทศ | Embassy / International Organisation | ☐ |

Rationale for the three "no default" rows: **VAT registration is a function of turnover (§85/1: >1.8 M THB/yr), not of legal form.** SweCham/TSCC is itself an association *and* a VAT registrant — an ☐ default for `association`/`foundation` would under-print on exactly the members most like the chamber itself. `cooperative` depends on the line of business (§91 specific-business tax vs VAT) and is escalated. `government` is ☐ per §81(1) (ministries/departments remitting all receipts to the state) but `state_enterprise` is ☑ (a separate juristic person; PTT, EGAT are registrants).

`embassy_intl_org` exists because 088 US8 already ships §80/1(5) zero-rating for these buyers. Zero-rating is keyed on the admin's issue-time selection + MFA cert, **not** on entity type, so US8 does not break — this is a data-model + branch-line gap only.

### Non-Thailand

`intl_company` · `intl_partnership` · `intl_sole_proprietor` · `intl_association_foundation` · `intl_government` · `intl_other`

**`is_vat_registered` is NOT forced false for non-TH members.** v1 said it was; the tax audit refutes it — a foreign company with a Thai branch registered for Thai VAT, or a foreign juristic person registered through a permanent establishment (§85/3), is real. `members.country` is the *postal* country, not the *tax jurisdiction*; the two are orthogonal. The checkbox renders for every member, defaults `false` for non-TH, and the `registrant ⇒ Thai 13-digit TIN` invariant (§ 7) keeps the state honest.

### Where it lives

`src/modules/members/domain/value-objects/legal-entity-type.ts` — **codes + `VAT_DEFAULT_BY_CODE` only**, exported through the members barrel. Not `src/lib/` (which `eslint.config.mjs:324-332` defines as the composition/glue layer). Both consumers already have a sanctioned path: the invoicing adapter imports the members barrel (`member-identity-adapter.ts:23`), and the client form already deep-imports pure domain modules (`member-form.tsx:36,40,41`). **Labels and descriptions live in the i18n message files, never in the catalogue file.**

Hoist `resolveLegalEntityTypeLabel` out of the member detail page into a shared component and use it on the **member portal profile** too — `src/app/(member)/portal/profile/page.tsx:207-208` renders `m.legalEntityType` raw today, so members see the machine code.

## 6. Data model + migration

Two columns. The migration must be written carefully — the review found four independent ways v1's SQL was wrong.

```sql
-- 0245_members_vat_registration_and_capital.sql

-- `members` is ENABLE + FORCE RLS with a single policy TO chamber_app (0009 § 9).
-- Migrations do not run as chamber_app, so under FORCE RLS a bare UPDATE can match
-- ZERO rows — silently, because RLS also hides rows from a verification SELECT.
-- `row_security = off` makes Postgres RAISE instead of applying a policy: the
-- backfill either sees every row or the whole migration aborts.
SET LOCAL row_security = off;--> statement-breakpoint

ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "registered_capital_thb" bigint;--> statement-breakpoint
ALTER TABLE "members"
  ADD COLUMN IF NOT EXISTS "is_vat_registered" boolean NOT NULL DEFAULT false;--> statement-breakpoint

-- Mirrors members_turnover_non_negative (0009 § 7).
ALTER TABLE "members" DROP CONSTRAINT IF EXISTS "members_registered_capital_non_negative";--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_registered_capital_non_negative"
  CHECK ("registered_capital_thb" IS NULL OR "registered_capital_thb" >= 0);--> statement-breakpoint
```

**The backfill is a TypeScript script, not SQL.** Postgres `btrim()` strips spaces only, while JS `.trim()` strips tabs, newlines, NBSP and more — and `create-member.ts:54` / `update-member.ts:36` are `z.string().max(100)` with **no `.trim()`**, so `E'\tindividual\n'` is reachable through the API. Simulating JS trim semantics in SQL is a fail-OPEN waiting to happen (it would mark a natural person as a VAT registrant and print สำนักงานใหญ่ on their tax invoice — the exact defect the 088 US3 review closed on 2026-07-02). The script:

1. `SELECT DISTINCT legal_entity_type` first and **report** — do not guess the legacy vocabulary. Known values seen in fixtures: `'Co., Ltd.'`, `'co_ltd'`, `'company'`, `'company_limited'`, `'limited'`, `'individual'`, `'  Individual '`, `'   '`. (The `'both'` in `legal-entity.ts:18`'s docstring is a confusion with the **plan** enum `member_type_scope` from `0006_plans_and_fee_config.sql:5` — do not treat it as evidence.)
2. Normalise each value with the **same TS function** the app uses, map to a canonical code, and derive `is_vat_registered` from **`VAT_DEFAULT_BY_CODE`** — *not* from `NOT IN ('', 'individual')`. v1's rule would have set `true` for `association`, `foundation`, `representative_office` and `government`, which is precisely the bug this feature exists to fix, frozen into a column nobody re-checks.
3. Unknown value ⇒ `is_vat_registered = false` (fail-closed) + report it for a human to re-pick.
4. Idempotent: rows already holding a canonical code are skipped.

Prod has zero members and the importer never populated the column, so in practice the backfill touches only the `dev` branch — but it must still be correct, because the `dev` data is what the integration tests run against.

### Tighten the branch-pairing CHECK (separate migration, after the backfill)

`0236_members_branch_pairing_ck_fix.sql:24-27` pins only `is_head_office ⇔ branch_code`. Nothing — not the DB, not the snapshot VO (`member-identity-snapshot.ts:161-174`), not the server schema — prevents `(is_vat_registered = false, is_head_office = false, branch_code = '00001')`. Today the "branch ⇒ registrant" rule lives **only in the client** (`member-form.tsx:236`), so a direct API call can already store it, and the branch line then silently vanishes.

```sql
-- 0246_members_branch_requires_vat_registrant.sql
ALTER TABLE "members" DROP CONSTRAINT IF EXISTS "members_branch_pairing_ck";--> statement-breakpoint
ALTER TABLE "members" ADD CONSTRAINT "members_branch_pairing_ck" CHECK (
  (is_head_office = true AND branch_code IS NULL)
  OR (is_head_office = false AND is_vat_registered = true
      AND branch_code IS NOT NULL AND branch_code ~ '^[0-9]{5}$')
);--> statement-breakpoint
```

This **tightens** — audit for rows it would reject before applying. Mirror it in `updateMemberSchema.superRefine` (server) and keep the client rule.

### Erasure / scrub classification (build-failing gate)

`tests/unit/members/infrastructure/scrub-pii-column-coverage.test.ts:109-113` partitions every `members` column into `SCRUBBED ∪ KEPT` and **fails the build** on an unclassified column. Both new columns are §86/4 business quasi-identifiers, the same class as `turnoverThb` / `foundedYear` / `isHeadOffice` / `branchCode`, all of which are SCRUBBED:

- `registeredCapitalThb` → **SCRUBBED** → `NULL`
- `isVatRegistered` → **SCRUBBED** → `false`

That scrub result `(is_vat_registered = false, is_head_office = true, branch_code = NULL)` satisfies the tightened CHECK. Update `scrubPiiInTx` (`drizzle-member-repo.ts`), the SCRUBBED set, and `docs/compliance/processing-records.md`.

## 7. Tax ID — rules and the invariant that was missing

The load-bearing axis is **`is_vat_registered`**, not the entity type. Under ประกาศอธิบดีฯ ฉบับที่ 199 the buyer's TIN and the "สำนักงานใหญ่ / สาขาที่ …" text are a **pair** — both mandatory when the buyer is a registrant, both omitted otherwise.

| Country | Case | Rule |
|---|---|---|
| TH | `is_vat_registered = true` (any entity type, incl. บุคคลธรรมดา) | **13 digits + Mod-11 checksum, mandatory.** A VAT-registered sole proprietor is real (§85/1 turnover test) and must be representable *with* a TIN. |
| TH | juristic entity, not a registrant | 13 digits + checksum. Required on **create** (maintainer decision); **edit warns only**. |
| TH | `sole_proprietor`, not a registrant | Optional. If present: 13 digits (national ID) + checksum. |
| ≠ TH | juristic | Optional, verbatim, 1–50 chars. No padding. |
| ≠ TH | natural person | Passport / work-permit number, verbatim. **See § 8 — this carries four mandatory guards.** |
| any | empty | Saves (except the TH-juristic create case). Hint: *"Without a taxpayer identification number this member's invoice will omit the buyer Tax ID line; a VAT-registrant buyer cannot claim input VAT."* |

**v1's warning text was factually wrong** and is deleted. It said a full tax invoice could not be issued without a TIN. `issue-invoice.ts:435-451` says the opposite in as many words: a **membership** invoice with no TIN **is** issued as a full §86/4 document (the TIN line is simply omitted — `invoice-template.tsx:487` — never a placeholder); only an **event** invoice with no TIN is blocked (`event_no_tin_requires_paid_issue` → §105 as-paid). Telling an admin "you cannot issue" is what pushes them to invent a TIN — the very harm we refuse zero-padding to avoid.

### The invariant (four layers)

`is_vat_registered = true` ⇒ `tax_id` present, 13 digits, valid checksum.

Without it, `(is_vat_registered = true, tax_id = NULL)` is constructible today and prints **"สำนักงานใหญ่" with no buyer TIN** — a defective §86/4 document. Enforce at:

1. client `superRefine` (`member-form.tsx`)
2. server `createMemberSchema` / `updateMemberSchema` `superRefine`
3. `memberIdentitySnapshotSchema.superRefine` (`member-identity-snapshot.ts` — fail loud **at issue**, mirroring the existing `member_number ⇔ member_number_display` pairing at `:148-155`)
4. DB CHECK on `members`

Layer 3 is the one that legally matters: it is the last gate before a document exists.

## 8. Passport / work-permit — the four mandatory guards

Decision (maintainer, 2026-07-13): **collect it**, as the reviewer asked. The PDPA review raised four blockers; all four must ship with it, in PR-A.

1. **The document-kind flip.** `document-kind.ts:54-55` chooses the document from TIN *presence*: `event + no TIN → §105 receipt`, `event + TIN → §86/4 tax invoice`. A foreign individual typing a passport number therefore silently upgrades their own event receipt into a tax invoice. → `resolveEventDocumentKind` must key on **`buyer_is_vat_registrant`**, not `buyerHasTin`.
2. **The PDF print.** `invoice-template.tsx:487` prints any non-blank `tax_id` (`buyerHasTin` = `trim() !== ''`); it is *not* gated on registrant status. → gate `buyerTaxIdEl` on `buyer_is_vat_registrant === true`. A non-registrant's identifier has no §86/4 purpose and must not appear on the document.
3. **The audit trail survives erasure.** `update-member.ts:113-128` (`buildDiff`) writes **raw** old/new values into `audit_log.payload`, and nothing in `src/` ever updates `audit_log`. COMP-1 `eraseMember` NULLs `members.tax_id` but cannot reach the audit row, which is retained 5 years. → `buildDiff` must emit `taxId` as a **presence signal** (`{ old: '<set>', new: '<cleared>' }`); `fields_changed` already carries the accountability.
4. **The logger.** `src/lib/logger.ts` redacts `tax_id` / `taxId` at depth 0–1 only. A `member_updated` payload nests it at depth 2 (`payload.diff.taxId`). The `legal_name` comment even claims it mirrors "the depth-0/1/2 convention used for tax_id" — the comment is wrong. → add `'*.*.tax_id'` and `'*.*.taxId'`.

With guards 1 and 2 in place, a foreign natural person's passport is stored, never printed, never changes their document kind, and never enters an audit payload in the clear. Add a "Lawful basis & minimisation" note to the RoPA (`docs/compliance/processing-records.md`) covering `tax_id` as personal data for natural persons.

## 9. Address

### Postcode filters — it never overwrites

The dataset (`docs/import/Thailand_Postal_Codes_Province_District.xlsx`, measured): 1,163 rows → **955 unique postcodes, 77 provinces**. 781 postcodes → 1 district; 144 → 2; 26 → 3; 4 → 4; and **8 postcodes span two provinces** (13240 Ayutthaya/Lopburi, 18220, 22160, 36220, 58130 …).

v1 had province/district each switching between input, read-only, and select depending on the lookup. That destroys focus on remount, breaks pasting an address block (the most common admin action — the postcode handler overwrites what was just pasted), and kills Chrome's address autofill (a read-only field is not fillable), which the form correctly supports today via `autoComplete="address-level1"` / `address-level2` / `postal-code`.

**The rule: province and district are always the same editable combobox. The postcode narrows their option list; it never silently rewrites a value the admin can't see.**

- Unambiguous postcode (781/955) → set both, show an inline "auto-filled" hint with **Undo**, and announce through `src/components/ui/live-region.tsx` (WCAG **SC 4.1.3 Status Messages**): *"Province set to Bangkok, district set to Watthana. Both fields remain editable."*
- Ambiguous → **set nothing.** Narrow the combobox options to the candidates and announce *"3 districts match postcode 10110. Choose one."*
- Not found → no block; hint and let the admin type.
- SC 3.3.2 instruction on the postcode field: *"Entering a postcode fills province and district."*

Keeping one widget per field also keeps SC 3.2.2 (On Input) satisfied, which the widget-swap violated.

### ~~Language: store Thai, always, when country = TH~~ — **REVERSED, see § 16.1**

~~`compose-buyer-address.ts:49-52` freezes `city + province + postal_code` into the immutable buyer address on the §86/4 document. v1 said autofill follows the **UI locale** — which would make the language printed on a tax document depend on which admin happened to key the member in and what language they had selected. RC §86/4 วรรคสอง requires the particulars in Thai. So: country = TH ⇒ store the canonical Thai names; show the English name as secondary text inside the picker only. The generated dataset is bilingual, so both are available.~~

**Superseded (2026-07-14) — store English, always, when country = TH.** ประกาศอธิบดีกรมสรรพากร ฉบับที่ 92 (2542) pre-approves English-language + THB tax invoices without a case-by-case application, TSCC's accountant confirmed the same independently, and TSCC's live corpus is 132/132 English addresses. See § 16.1 for the full reasoning. Implemented in `src/components/members/member-form/sections/address-section.tsx` (PR-B) — the Thai name is kept as secondary `detail` text inside the picker, never dropped.

### Sub-district is required for TH

§86/4(3) requires the buyer's address. "เขตคลองเตย กรุงเทพฯ 10110" without "แขวงคลองเตย" is not a complete Thai address. The dataset stops at district level, so the sub-district (แขวง/ตำบล) is typed by hand — and the create gate must require it.

- **Create, TH**: `address_line1` + sub-district + district + province + `postal_code`.
- **Create, non-TH**: `address_line1` + city. Postal code optional (HK, AE have none).
- **Edit**: never blocks; an incomplete address shows a banner with a jump link.

`address_line2` currently holds building/floor/soi on legacy rows, so overloading it with the sub-district gives one column two meanings, and `compose-buyer-address.ts:43-44` prints it bare with no "แขวง" prefix. **Add a real `sub_district` column** in PR-B rather than overloading.

### Dataset artefact — commit it, don't fetch at build

v1 proposed generating the JSON at build time from `kongvut/thai-province-data`. `vercel-build` runs migrations then `next build`; a build that fetches GitHub couples production deploys to GitHub uptime and an unpinned upstream. The repo's precedent for third-party static assets is to **commit the artefact** (Sarabun TTF under `public/fonts/sarabun/`). So: run the generator once, offline, cross-check against the reviewer's spreadsheet, and commit `src/lib/thai-postal/data.json` + a `SOURCE.md` recording the upstream commit SHA and licence, plus a checksum test to catch hand-edits. Keep the script for regeneration only.

Lazy-load the JSON via dynamic `import()` only when country = TH. **`check:bundle-budgets` does not currently cover the members routes** (`scripts/check-bundle-budgets.ts:44-66` lists only F7/F8 routes) — v1's claim that the budget gate protects this was false. Add `/admin/members/new` and `/admin/members/[memberId]/edit` to `BUDGETS` in PR-B, or the lazy-import discipline is unenforced.

## 10. Contacts

A secondary contact is a `contacts` row with `is_primary = false`, inserted in the **same transaction** as the member and primary contact. `createWithPrimaryContactInTx(tx, draft)` already receives the `tx` from `runInTenant`, so no new tenant-context plumbing is needed — but note the repo **hardcodes `isPrimary: true`** at `drizzle-member-repo.ts:543`, and `contacts_one_primary_per_member` will reject a second primary.

- **UI**: a `+ Add a secondary contact` outline button (mirroring the Add-contact trigger at `[memberId]/page.tsx:1181-1195`), revealing the fieldset with a Remove affordance. No "No secondary contact" checkbox — additive, not a negative opt-out.
- **Fields**: first/last name, email, phone, role title, preferred language. No date of birth (that gate is primary-only and plan-driven).
- **409 attribution.** `member-create-error-map.ts:39-50` hard-maps *any* 409 `conflict` on create to `primary_contact.email` — and documents the assumption that this is the only unique index that can fire. A secondary contact breaks that assumption: a collision on the secondary email would highlight and focus the **wrong field**. → the repo must wrap each contact insert in its own try/catch and return a discriminated reason (`primary_contact_email_taken` / `secondary_contact_email_taken`); the error map keys off it. Add the cheap client + server rule `secondary.email !== primary.email` for the common case.
- **Audit**: reuse the existing `contact_created` emit (`create-member.ts:433-444`) in the same tx. **No new audit event type** — the 4-place enum change is not needed.
- **Art. 14 notice (GDPR) — DECIDED 2026-07-14: an admin attestation.** The secondary contact is a named natural person whose data we obtain from a third party (the admin) and who is never told they are in the system — no code path emails them. The chosen remedy is a **required attestation checkbox** on the contact fieldset — *"I confirm this person has been informed that their details are being shared with the chamber"* — persisted with a timestamp. It rests on **Art. 14(5)(a)** (the subject already has the information) and leaves a defensible record.

  **It must cover BOTH entry points.** The gap is about the *collection*, not the form: the Edit page's existing "Add contact" flow (`contact-crud.ts:89`) emails the new contact nothing either. This branch does not *introduce* the gap — it makes it routine rather than incidental, because a second natural person is now captured on the majority create path. Fixing only the create form would not be a fix.
- **Known residual — Art. 15(4), the org-as-subject question.** `gdpr-archive-source-adapter.ts:313-324` maps *every* contact into `contacts.json`, so a subject-access request routed through contact A ships contact B's name, email, phone and date of birth. Pre-existing (F9 audit, 2026-06-15); the secondary contact makes it routine rather than incidental.

  **Two acceptable resolutions, and the status quo is neither:** scope the archive to the requesting contact, *or* write down an explicit org-as-subject position (the data subject is the member *organisation*, and the archive is delivered to its authorised representative). The second is defensible — but right now it is an unwritten assumption doing load-bearing work, which is the one thing it must not be. **Owner: PR-A or a follow-up; not this branch.**

## 11. Form UX

Five fieldsets: Company · Address · Membership · Primary contact · Secondary contact (`+ Add`).

- **Do not wizard it.** `docs/ux-patterns.md § 3` names single-long-form as the case where a wizard is the wrong answer, and a wizard would demand "no server effect until the final step" plus a review step. Do not accordion the required sections either — a collapsed panel hides validation errors, and `FormErrorSummary`'s jump-links would land inside a closed section.
- **Collapse the genuinely optional fields** behind a `<Collapsible>` "Additional details": `description`, `notes`, `founded_year`, `registered_capital_thb`, `turnover_thb`. Give every fieldset a stable `id` so the error-summary jump-links land in the right section.
- **Unsaved-changes guard.** `docs/ux-patterns.md § 4.2` names "member edit" explicitly, and `compose-form.tsx:163-182` / `issue-invoice-form.tsx:192-212` both implement it. `member-form.tsx` has none, and this redesign roughly doubles the form. Add `isDirty` + `beforeunload` + in-app-nav guard.
- **Entity-type descriptions go inline in each `SelectItem`** (label + muted description), not in a popover. That deletes the help affordance and its keys entirely. If a full reference table is still wanted, it belongs in a `Dialog`.
- **Country combobox**: `member-picker.tsx:254-261` is the reference ARIA implementation (`role="combobox"` + `aria-expanded` + `aria-haspopup="listbox"` + `aria-controls` + `aria-labelledby` + `aria-describedby`/`aria-invalid`). `searchable-combobox.tsx` is missing five of those and takes an `ariaLabel` prop, which would detach the accessible name from the visible `<Label>` and break the `FieldError` + `FormErrorSummary` wiring. Promote a combobox into `src/components/ui/` with the full contract; feed localised country names from `country-display.tsx:76-90`, which already does lazy per-locale ISO-3166 registration.
- **Use the primitives**: `member-form.tsx:292-298` re-defines `RequiredMark`, duplicating `src/components/ui/required-mark.tsx`; `:770-777` uses a raw `<input type="checkbox">` while `src/components/ui/checkbox.tsx` exists. This redesign adds two more checkboxes.

### Decompose before adding

`member-form.tsx` is 1,022 lines and this would take it past 1,700. Split into `src/components/members/member-form/`:

`schema.ts` (the zod factory — already exported for its unit test, so a pure move) · `sections/company-section.tsx` · `sections/address-section.tsx` (owns the postcode state + the lazy `import()`) · `sections/membership-section.tsx` · `sections/tax-branch-section.tsx` · `sections/contact-fields.tsx` (**one component rendered twice**, parameterised by name-prefix and `showDob` — the secondary contact is a literal re-render of the primary's fields) · `use-member-form-errors.ts` · `member-form.tsx` as a composition root under 200 lines.

## 12. Pre-existing bugs (PR-0)

1. **`registration_date` dead on Edit** — rendered (`member-form.tsx:698-705`), seeded from the DB, never sent (`edit-member-payloads.ts:53-83`), and `updateMemberSchema` is `.strict()` without it. → read-only + tooltip.
2. **`notes` dead on Create** — rendered (`:608-621`), omitted by `toPayload` (`create-member-client.tsx:58-86`), not in `createMemberSchema`, hardcoded `notes: null` (`create-member.ts:372`). → accept it.
3. **Eight fields lack `FieldError` / `aria-invalid` / error-summary entries** — not two, as v1 claimed. QA enumerated them; `legal_entity_type` (`:499-505`) and `description` (`:598-606`) are the two v1 found. Wire all eight, because PR-B makes the address required and its errors would otherwise be invisible.

## 13. Out of scope (backlog)

- **Re-anchoring the registration date.** Editing it means recomputing the in-flight renewal cycle's `period_from`/`period_to`, refusing when the cycle has an issued or paid invoice (the printed membership period would contradict the cycle), rescheduling reminders, and a new audit event type. That is an F8 use-case, and it deserves its own branch: a "Change registration date" action on the member detail page with a dialog showing the cycle shift A → B.
- Secondary contact management on the Edit form (the contacts list covers it).
- A DB `CHECK` on `legal_entity_type` (after the DISTINCT audit confirms the column is clean).
- Bilingual `company_name_th` for the §86/4 Thai-language particular (pre-existing gap — the buyer block prints whatever the admin typed).
- Scoping `gdpr-archive-source-adapter`'s `contacts.json` to the requesting contact.

## 14. Testing

**PR-A (tax) — the mandatory set:**
- **SQL↔TS parity** (live Neon): a fixture of every legacy value (`NULL`, `''`, `'   '`, `'individual'`, `'  Individual '`, `E'\tindividual\n'`, `'Co., Ltd.'`, `'co_ltd'`, `'company'`, `'limited'`) run through both the backfill script and the app's normaliser; assert identical. **This is the only test that catches the trim mismatch.**
- **Idempotency** (live Neon): apply the backfill twice; `sole_proprietor` must still be `is_vat_registered = false`.
- **RLS reach**: the backfill must touch real rows or abort loudly — never match zero silently.
- **§86/4 matrix** (live Neon, extends `tests/integration/invoicing/member-identity-branch.test.ts`): registrant + head office → "สำนักงานใหญ่"; registrant + branch → "สาขาที่ NNNNN"; non-registrant → no line; registrant + no TIN → **rejected at issue**.
- **Preview/PDF agreement**: `issue-review.ts`'s branch-line prediction equals what the template renders, for every combination.
- **FR-038 / SC-003**: toggling `is_vat_registered` after issue does not change the already-issued document; historical snapshots re-render **byte-identical**. Confirmed safe by design — the snapshot freezes the value and the branch line is gated on `templateVersion >= HEAD_OFFICE_BRANCH_MIN_VERSION` — **so no template-version bump is needed**. Test it anyway.
- **Erasure**: `eraseMember` → `registered_capital_thb IS NULL`, `is_vat_registered = false`; the audit diff contains no raw `tax_id`.
- **Cross-tenant probe** (Principle I) on both new columns.

**PR-B**: postcode lookup (unique / multi-district / multi-province / not-found) · bare-domain → `https://` · member + primary + secondary contact created and rolled back as one unit · secondary-email collision maps to the **secondary** field · E2E: postcode filters, country switch swaps the address block, `@a11y` axe scan.

**i18n**: `pnpm check:i18n` verifies **presence only** — a Swedish value containing English passes (this repo shipped exactly that once, caught by manual QA in PR #174). Two mitigations: descriptions move inline into the options (fewer keys), and **the Thai legal term is not translated** — TH and SV render `บริษัทจำกัด (Private Limited Company)`. A Thai legal form is a proper noun; inventing a Swedish equivalent invents a legal category that does not exist in Swedish law. Add a unit test asserting every catalogue code resolves in all three locales — nothing else will catch it, because the resolver fails soft.

## 15. Questions to send out

**All of the blocking questions are now closed.** See § 16.

**To the reviewer** (for the record — these are the three places we did not do what they asked):
1. **Zero-padding a foreign Tax ID.** We refuse it. A padded number lands inside the Thai 13-digit TIN namespace and can match a *different, real* taxpayer; a passport number cannot be padded into a digit string without fabricating one; and it is a false particular on a tax document. See § 16.4(a) — and note § 16.4(b), a **separate** padding issue (Excel ate the leading zero from 113 Thai TINs) which does need fixing, but in the importer and only for Thai TINs.
2. **"Not based in Thailand" checkbox** — folded into the Country field; two sources of truth can contradict each other.
3. **"Member Type"** — renamed to "Entity type"; the term collides with the plan's `member_type_scope`.
4. The entity list needed **two additions** the source table lacked: `government` (already in our vocabulary) and `embassy_intl_org` (088 US8 zero-rating buyers). Note § 16.3: TSCC has **no members of either type**, so neither is urgent.

---

## 16. Amendments (2026-07-14) — the blocking questions, answered

Three things landed after v2 was written: TSCC's accountant answered the language question, legal research verified the citations against rd.go.th primary sources, and we read TSCC's actual member spreadsheet (`docs/import/Membership Database_Since 2025(...)_v2_Excel.xlsx`, sheet `Member Data New`, **150 members**). Several v2 decisions are reversed or sharpened below. **Where this section contradicts §§ 1–15, this section wins.**

### 16.1 English buyer particulars are legal — `company_name_th` is NOT needed

§86/4 วรรคสอง does say the particulars shall be in Thai — **but ประกาศอธิบดีกรมสรรพากร ฉบับที่ 92 (2542) pre-approves English-language + THB tax invoices automatically**, with no case-by-case Director-General application. (Case-by-case approval is needed only for a language other than English, or for a foreign currency.) TSCC's accountant confirmed the same independently: the buyer's name and address may be English, provided the data is correct and verifiable.

**Consequences:**
- **`company_name_th` is dropped.** It was the largest scope risk in PR-A; it is gone.
- **The Thai-address-storage rule in § 9 is REVERSED.** v2 said "when `country = TH`, store the Thai names". We now store **English** — because English is legal, and because TSCC's existing corpus is entirely English (§ 16.3). Storing Thai for new members while the imported 132 stay English would make one chamber issue tax documents in two languages, for no legal benefit. (Implemented in PR-B.)

### 16.2 Citation correction — it is **196 + 199**, not 199 alone

- **ประกาศอธิบดีฯ (VAT) ฉบับที่ 196** (eff. 1 Jan 2014) — requires the **buyer's 13-digit TIN**, only when the buyer is a VAT registrant.
- **ฉบับที่ 199** (eff. 1 Jan 2015) — requires the **"สำนักงานใหญ่" / "สาขาที่ NNNNN"** text, and its operative clause is explicitly *"ในกรณีผู้ประกอบการจดทะเบียนได้จัดทำใบกำกับภาษีให้แก่ผู้ซื้อ...ซึ่งเป็นผู้ประกอบการจดทะเบียน"* — i.e. only when the **buyer** is a registrant.

Both were verified against rd.go.th primary text. v2 cited 199 alone for both particulars; correct that wherever it appears.

### 16.3 What TSCC's data actually contains (150 members)

| Field | Reality |
|---|---|
| **Entity type** | **Already populated.** 111 Private Limited Company · 15 Individual · 7 State Enterprise · 5 Public Limited Company · 2 Foundation · 10 N/A. PR-A's catalogue can be **backfilled from this sheet** rather than left NULL. |
| **Tax ID** | 113 present, 37 = "N/A". **Every one of the 113 is 12 digits, not 13** — Excel stored them as numbers and ate the leading zero (`105562087242` → really `0105562087242`). |
| **Address** | 132 have one. **Zero contain a single Thai character.** 100% English. |
| **Registered capital** | 113 populated — *more complete than turnover* (78). Validates adding the column rather than renaming turnover. |
| **Secondary contact** | Columns exist; **0 rows populated.** The feature is for future use, not for the import. |
| **Country** | 127 Thailand · 4 Sweden · 19 N/A. |
| Entity types **absent** | No cooperative, no representative/regional office, no government agency, no embassy. The defaults for those are therefore not urgent. |

### 16.4 Zero-padding a foreign Tax ID — still refused

The reviewer asked for *"ถ้าบางประเทศน้อยกว่า 13 หลัก ให้ใช้ 0000 ข้างหน้า"* — pad a foreign identifier out to 13 digits. We do not, and the reasons in § 3 #2 are unchanged:
- A padded number lands inside the **Thai 13-digit TIN namespace** and can match a *different, real* Thai taxpayer.
- A passport / work-permit number is alphanumeric — it cannot be padded into a digit string without fabricating one.
- It is a **false particular on a tax document**: a penalty risk, not a UX preference.

A foreign identifier that is not 13 digits is not a *truncated* 13-digit ID — it is a different kind of identifier. Store it verbatim, and omit the Tax ID line on the document when the buyer is not a Thai VAT registrant (per ประกาศ 196, exactly the case where no buyer TIN is required at all).

> **Not this spec's problem:** TSCC's spreadsheet has a *separate* padding issue — Excel stored the Thai TINs as numbers and ate their leading zero (113 rows). That is an **importer** concern, not a form concern; it is recorded in § 16.3 and belongs to `scripts/import-members/`.

### 16.5 Tax ID is required **only when the buyer is a VAT registrant**

v2 (and an earlier maintainer decision) said "required on create for a Thai juristic entity". The data refutes that: **37 members have no TIN at all**, including all 7 State Enterprises and both Foundations. That rule would make them un-creatable through the form.

**New rule:** `tax_id` is required **iff `is_vat_registered` is true** — which is exactly where ประกาศ 196 actually bites. A non-registrant needs no TIN on the document, so the form must not demand one. (The `registrant ⇒ 13 digits + checksum` invariant of § 7 is unchanged; only the *trigger* moves from entity type to the VAT flag.)

### 16.6 VAT-registrant status is independent of legal form — verified

พ.ร.ฎ. (ฉบับที่ 432) พ.ศ. 2548 sets the **1.8 M THB/yr** threshold under §81/1, and §77/1 defines "ผู้ประกอบการ" to include natural persons and non-juristic bodies. So a **บุคคลธรรมดา above the threshold must register** and *can* carry a head-office/branch particular.

This kills the old heuristic (`legal_entity_type ≠ 'individual' ⇒ registrant`) on the law, not just on taste, and confirms `is_vat_registered` must be a **recorded fact, never derived**.

**Defaults that must NOT exist:**
- **`cooperative`** — no safe default. Savings cooperatives' interest income falls under specific business tax (§91); agricultural cooperatives are exempt under §81(1)(ก) for *unprocessed* produce only; a cooperative selling VATable goods above the threshold must register. Verified against RD ruling กค 0702/2893. **Force the admin to choose.**
- **`association` / `foundation`** — no safe default. §81(1) contains no exemption by *status*; only §81(1)(ธ) exempts certain religious/charitable *activities*. **TSCC is itself a chamber of commerce (an association) and is VAT-registered.** Force the admin to choose.

**Defaults that are defensible** (still overridable): `representative_office` / `regional_office` → false (legally barred from earning revenue in Thailand; they still hold a TIN for withholding tax). `government` → false (§81(1)(ท), ministries/departments remitting all receipts to the state). `state_enterprise` → true (a separate juristic person; not covered by the §81(1)(ท) exemption).

### 16.7 A sub-district is **not** legally required in the buyer's address

คำสั่งกรมสรรพากร ป.86/2542 sets an *unambiguous-location* standard, not a field checklist: *"กรณีระบุที่อยู่ไม่ครบถ้วนตามที่จดทะเบียน...แต่รายการที่อยู่ที่ระบุไว้ถูกต้อง และสามารถบอกตำแหน่งที่ตั้งที่ชัดเจนได้ ให้ถือว่าได้ระบุที่อยู่ครบถ้วนแล้ว"*. A missing แขวง/ตำบล does not by itself void the buyer's input-VAT claim.

So PR-B's "sub-district required on create for TH" gate is a **data-quality choice we are making deliberately**, not a legal obligation. Keep it (a complete address is worth having, and the postcode picker makes it nearly free), but do not defend it as a legal requirement — and note that **TSCC's own sheet has no sub-district column at all**, so no imported member will have one.

### 16.8 Still open — but no longer blocking

- **Membership tiers are banded on `turnover_thb`.** TSCC's sheet has registered capital for 113 members and turnover for only 78 — capital is the better-populated field. Worth asking whether tiers should eventually re-band on it. **Not blocking:** both columns now exist, and the F2/F8 rules continue to read turnover.
- **Are any of the 15 Individuals VAT-registered?** Determines what the `sole_proprietor` checkbox defaults to. **Not blocking:** the default is `false` and the admin can tick it.
