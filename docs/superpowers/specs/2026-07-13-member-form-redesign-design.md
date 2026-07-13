# Member Form Redesign — Design

**Date**: 2026-07-13
**Status**: Approved (design), pending implementation plan
**Origin**: Reviewer feedback on the admin member create/edit form (SweCham / TSCC)
**Surfaces**: `src/components/members/member-form.tsx`, `src/modules/members/**`, `src/lib/legal-entity.ts`, `src/lib/thai-postal/**` (new), `src/modules/invoicing/infrastructure/adapters/member-identity-adapter.ts`

---

## 1. Context

The reviewer walked the admin member form and returned nine changes. Five of them collide with how the system actually works today; those collisions were resolved with the maintainer before this document was written. This design records both the agreed shape **and** the three places where we deliberately do **not** do what the reviewer asked, so those can be taken back to them.

Today's form (`member-form.tsx`, 1022 lines) has four fieldsets — Company, Address, Tax branch (edit-only), Primary contact — a free-text country input, a free-text legal-entity-type input, an entirely optional address, and no secondary contact.

## 2. Decisions

| # | Reviewer asked | Decision | Why |
|---|---|---|---|
| 1 | Country dropdown: Thailand / Sweden / Others (specify) | **Searchable combobox** over the full ISO-3166 list, with Thailand + Sweden pinned to the top | `members.country` is `char(2)` ISO-3166 and feeds the tax PDF. A three-value dropdown makes SG/US/etc. members unrepresentable. A pinned combobox satisfies "dropdown" without losing coverage. |
| 2 | Tax ID: must be 13 digits or cannot save; pad shorter foreign IDs with leading zeros | **Conditional rule, no zero-padding** (see § 5) | Passport / work-permit numbers are alphanumeric — `A1234567` padded to `000000A1234567` is a fabricated identifier that would print on a Thai tax invoice. A foreign ID that is not 13 digits is not a *truncated* 13-digit ID; storing it verbatim is the correct record. **Pushback to reviewer.** |
| 3 | Legal entity type → "Member Type" dropdown, 14 Thai types, popup explaining each | **Dropdown of 14 types, labelled "Entity type / ประเภทนิติบุคคล"**, list swaps to a generic international set when country ≠ TH | "Member Type" collides with the F2 plan concept `member_type_scope` (individual / corporate), which gates the date-of-birth requirement. The 14 types are Thai legal forms — a Swedish *AB* or a UK *Ltd* matches none of them. |
| 4 | — (not asked) | **New `is_vat_registered` checkbox**, shown only when country = TH, defaulted from the entity type | The §86/4 head-office/branch line on the tax invoice is gated on "is the buyer a VAT registrant". Today that is *guessed* (`legal_entity_type ≠ 'individual'`), which is wrong for associations, foundations, and representative offices. **Addition beyond the reviewer's list.** |
| 5 | Website or online presence (Website, Facebook) | Keep the single `website` column; relabel, accept a bare domain (auto-prefix `https://`), Facebook-style placeholder | No migration; a Facebook page URL is a URL. |
| 6 | Change "annual turnover" → "Capital registration (ทุนจดทะเบียน)" | **Add `registered_capital_thb`; keep `turnover_thb`** | `turnover_thb` is not a display field. It gates the F2 plan turnover band (out-of-band ⇒ mandatory override reason) and drives F8 auto tier-upgrade suggestions. Renaming the label would silently re-point a membership-tier business rule at a different quantity. |
| 7 | Address: postcode-driven autofill; "Not based in Thailand" option → manual; one branch must be complete or cannot save | Postcode autofill **driven by the Country field** (no separate checkbox); required **on create only** | A separate "Not based in Thailand" checkbox is a second source of truth that can contradict `country`. Requiring a complete address on *edit* would lock the ~95 imported members — an admin could not fix an email without first sourcing an address. **Pushback to reviewer.** |
| 8 | Registration Date: tooltip "counted from the date the member is created in the CRM" | Tooltip **+ make the field read-only on Edit** | The field currently renders on Edit, is seeded from the DB, and is silently discarded on save (`updateMemberSchema` is `.strict()` and has no such key). It is also the anchor for the F8 renewal cycle. Read-only closes the data-loss bug without touching cycle semantics. Re-anchoring is deferred (§ 10). |
| 9 | Add a Secondary contact (same fields as primary); "No secondary contact" option | Secondary contact on the **Create** form only; Edit keeps the existing contacts list | The Edit page already has full contact CRUD (add / edit / promote-to-primary). A second surface would be two sources of truth for the same rows. |

## 3. Data model

One migration on `members`:

```sql
ALTER TABLE members
  ADD COLUMN registered_capital_thb bigint,                       -- ทุนจดทะเบียน, NULL = unknown
  ADD COLUMN is_vat_registered boolean NOT NULL DEFAULT false;    -- ผู้ประกอบการจดทะเบียน VAT

-- Backfill preserves today's behaviour exactly (fail-closed on NULL/'individual')
UPDATE members
   SET is_vat_registered = true
 WHERE legal_entity_type IS NOT NULL
   AND lower(btrim(legal_entity_type)) NOT IN ('', 'individual');

-- Legacy free-text → canonical codes. Run SELECT DISTINCT legal_entity_type FIRST;
-- any value not in the map is left untouched and rendered raw until an admin re-picks.
UPDATE members SET legal_entity_type = 'sole_proprietorship'
 WHERE lower(btrim(legal_entity_type)) = 'individual';
```

`legal_entity_type` stays `text` (no DB enum) — the 14+6 codes are enforced at the application layer so legacy rows and the CSV importer do not break. A DB `CHECK` may be added in a follow-up once `SELECT DISTINCT` confirms the column is clean.

Address columns (`address_line1`, `address_line2`, `city`, `province`, `postal_code`) are **unchanged and stay nullable** — the completeness rule lives in the application layer (create only), so existing rows without an address remain editable.

## 4. Entity type catalogue

Lives in `src/lib/legal-entity.ts` (pure, framework-free — already shared by `src/modules/**` and `src/components/**`).

### Thailand (country = TH)

| code | ไทย | English | Description | VAT default |
|---|---|---|---|---|
| `sole_proprietorship` | บุคคลธรรมดา | Sole Proprietorship | Single owner, unlimited liability. | ☐ |
| `ordinary_partnership` | ห้างหุ้นส่วนสามัญ | Ordinary Partnership | Unregistered partners, unlimited liability. | ☐ |
| `registered_ordinary_partnership` | ห้างหุ้นส่วนสามัญจดทะเบียน | Registered Ordinary Partnership | Registered entity, partners have unlimited liability. | ☑ |
| `limited_partnership` | ห้างหุ้นส่วนจำกัด | Limited Partnership | Mix of limited and unlimited liability partners. | ☑ |
| `private_limited_company` | บริษัทจำกัด | Private Limited Company | Limited liability, shares sold privately. | ☑ |
| `public_limited_company` | บริษัทมหาชนจำกัด | Public Limited Company | Limited liability, shares sold publicly. | ☑ |
| `joint_venture` | กิจการร่วมค้า | Joint Venture | Collaboration for a specific project. | ☑ |
| `branch_office` | สำนักงานสาขาของบริษัทต่างประเทศ | Branch Office | Foreign company extension, can generate income. | ☑ |
| `representative_office` | สำนักงานผู้แทน | Representative Office | Foreign company office, strictly non-revenue (e.g. market research). | ☐ |
| `regional_office` | สำนักงานภูมิภาค | Regional Office | Foreign regional hub, strictly non-revenue. | ☐ |
| `association` | สมาคม | Association | Non-profit for a common member goal. | ☐ |
| `foundation` | มูลนิธิ | Foundation | Non-profit managing assets for public charity. | ☐ |
| `cooperative` | สหกรณ์ | Cooperative | Member-owned and controlled for mutual benefit. | ☐ |
| `state_enterprise` | รัฐวิสาหกิจ | State Enterprise | Government-owned or controlled business. | ☑ |

The **VAT default** column only seeds the checkbox — the admin can always override it. It is not a source of truth.

### Non-Thailand (country ≠ TH)

`intl_company` · `intl_partnership` · `intl_sole_proprietor` · `intl_association_foundation` · `intl_government` · `intl_other`

For a non-TH member, `is_vat_registered` is forced `false` (no Thai VAT registration ⇒ no §86/4 branch line) and the checkbox is not rendered.

### Consequence for the tax PDF

`member-identity-adapter.ts:197` changes from

```ts
buyer_is_vat_registrant: isVatRegistrantEntityType(m.legal_entity_type),  // guessed
```
to
```ts
buyer_is_vat_registrant: m.is_vat_registered,                             // recorded
```

`isVatRegistrantEntityType()` survives only as the backfill / checkbox-default helper. The branch-code cross-field guard in the form gates on `is_vat_registered` instead of the entity type.

**Behaviour change to be aware of:** today `legal_entity_type` is almost always NULL, so `buyer_is_vat_registrant` is almost always `false` and **no member currently gets a buyer head-office/branch line on their tax invoice** — the §86/4 feature shipped in 088 is dormant for lack of input data. Once admins pick an entity type, VAT-registrant buyers start receiving the line. That is the intended 088 behaviour and it closes a real under-printing gap.

## 5. Tax ID rules

Enforced in the `asTaxId` domain value object and mirrored client-side (the existing pattern — `thai-tax-id-checksum.ts` is already deep-imported by the form).

| Country | Entity type | Rule |
|---|---|---|
| TH | juristic (any of the 12 non-individual Thai codes) | **Required. Exactly 13 digits + Mod-11 checksum.** Cannot save otherwise. |
| TH | `sole_proprietorship` | Optional. If present: 13 digits (national ID) + checksum. |
| ≠ TH | any juristic code | Optional. Free-form 1–50 chars (foreign VAT / org number). **No zero-padding.** |
| ≠ TH | `intl_sole_proprietor` | Optional. Passport or work-permit number (alphanumeric allowed). |
| any | empty | Saves. Shows a warning hint: *"a full tax invoice cannot be issued without a taxpayer identification number"*. |

Help popover on the field explains the four cases in plain language (EN/TH/SV).

## 6. Address + Thai postcode dataset

### Dataset

`docs/import/Thailand_Postal_Codes_Province_District.xlsx` supplied by the reviewer: 1,163 rows → **955 unique postcodes, 77 provinces, English names only, district-level (no sub-district)**.

Measured shape (this drives the UI):
- 781 postcodes → exactly 1 district (clean autofill)
- 144 → 2 districts, 26 → 3, 4 → 4 (needs a filtered picker)
- **8 postcodes span two provinces** (13240 Ayutthaya/Lopburi, 18220, 22160, 36220, 58130, …) — province cannot be blindly autofilled either

A build-time script regenerates the dataset **bilingual (TH + EN)** from `kongvut/thai-province-data` (the source the reviewer's sheet itself cites), emitting `src/lib/thai-postal/data.json` (~40–80 KB). The JSON is **lazy-loaded via dynamic import only when country = TH**, so it never enters the default bundle (`check:bundle-budgets`).

### Behaviour

1. Country = Thailand ⇒ the postcode field leads the section.
2. On 5 digits: look up. One province ⇒ fill it (read-only, with an "edit manually" escape). Several ⇒ province becomes a 2-option select.
3. One district ⇒ fill it. Several ⇒ district becomes a select filtered to that postcode's districts.
4. Postcode not found ⇒ no block; show a hint and let the admin type province/district by hand.
5. Autofilled names follow the active UI locale (TH → Thai names; EN/SV → English).
6. Country ≠ Thailand ⇒ plain manual fields (Address line 1/2, City, State/Province, Postal code).

### Completeness gate

- **Create, TH**: `address_line1` + district + province + `postal_code` all present.
- **Create, non-TH**: `address_line1` + city. Postal code optional (HK, AE, … have none).
- **Edit**: never blocks. An incomplete address shows a banner — *"address incomplete — required before a tax invoice can be issued"* — with a jump link to the section.

`city` carries the district (อำเภอ/เขต); its label becomes "District / อำเภอ・เขต" when country = TH. `address_line2` is labelled "Sub-district / แขวง・ตำบล" for TH, since the dataset stops at district level.

## 7. Contacts

Secondary contact is a second `contacts` row with `is_primary = false`, inserted **in the same transaction** as the member and the primary contact (extend `createWithPrimaryContactInTx`; roll back the whole create if the second contact fails).

- Fields: first name, last name, email, phone, role title, preferred language. **No date of birth** (the DOB gate is a primary-contact-only, plan-driven rule).
- A checkbox **"No secondary contact"** — unchecked by default, so the admin makes a conscious choice. Ticking it hides and clears the fields.
- Email must differ from the primary's and from every other contact in the tenant (`contacts_tenant_email_uniq` already enforces this). The 409 must be mapped to a readable field-level error, not a 500.

## 8. Form layout (create)

Five fieldsets, replacing the current four (plan / registration date move out of the Company section into their own Membership block):

1. **Company** — name*, country* (combobox), entity type* (select + popover), VAT registered (TH only), tax ID (+ popover), website / online presence, founded year, registered capital, annual turnover (+ hint: *used for tier banding*), description, notes
2. **Address*** — postcode-driven when TH, manual otherwise
3. **Membership** — plan*, plan year*, registration date (+ tooltip)
4. **Primary contact** — unchanged
5. **Secondary contact** — new, with the "No secondary contact" opt-out

Help affordances use `Popover` (not `Tooltip`) so they are tappable on mobile — the pattern already established at `src/app/(staff)/admin/members/[memberId]/page.tsx:1166`.

## 9. Bugs fixed along the way

Found while mapping the current form; all are pre-existing:

1. **`registration_date` is a dead input on Edit** — rendered and seeded, never sent (`buildFieldPayload` omits it; `updateMemberSchema` is `.strict()` without it). An admin's edit is silently discarded. → read-only + tooltip.
2. **`notes` is a dead input on Create** — rendered, but `toPayload` omits it and `createMemberSchema` does not accept it; `create-member.ts:372` hardcodes `notes: null`. → accept it.
3. **`legal_entity_type` and `description` have no `FieldError` / `aria-invalid` wiring** — a max-length failure produces no visible message and no error-summary entry. → wire both.

## 10. Out of scope (backlog)

- **Re-anchoring the registration date.** Making it editable means recomputing the in-flight renewal cycle's `period_from`/`period_to`, refusing the change when the cycle already has an issued or paid invoice (the printed membership period would contradict the cycle), rescheduling reminders off the new `period_to`, and adding an audit event type. That is an F8 use-case, not form polish — it deserves its own branch: a "Change registration date" action on the member detail page with a confirmation dialog showing the cycle shift A → B.
- Secondary contact management on the Edit form (the contacts list already covers it).
- A DB `CHECK` constraint on `legal_entity_type` (after the distinct-value audit).

## 11. Testing

- **Domain / unit**: `asTaxId` across every row of § 5 · postcode lookup (unique / multi-district / multi-province / not-found) · entity-type → VAT-default map · bare-domain → `https://` normalisation.
- **Contract**: `createMemberSchema` + `updateMemberSchema` accept the new fields · create rejects an incomplete address · secondary-contact email collision returns a mapped field error.
- **Integration (live Neon — mandatory for money/tax paths)**: member + primary + secondary contact created in one transaction, rolls back as a unit · `is_vat_registered` reaches `MemberIdentitySnapshot.buyer_is_vat_registrant` and the §86/4 branch line renders / does not render accordingly.
- **E2E**: postcode → autofill · switching country to a non-TH value swaps the address block to manual · entity-type popover opens · `@a11y` axe scan on the redesigned form.
- **i18n**: 14 + 6 entity types × (label + description) ≈ **80+ new keys** across EN/TH/SV. TH and SV must be complete before merge (`pnpm check:i18n`).

## 12. Rollout & risk

- One migration; production is currently empty of members (re-wiped 2026-07-12), so backfill risk is low. The `dev` Neon branch must be checked for legacy `legal_entity_type` values first.
- No feature flag — this is a direct form change, not a new subsystem.
- **Touches the tax-document path (F4).** Review must include the tax/security checklist; `member-identity-adapter` and the invoice template need integration coverage before merge.
- Downstream surfaces to update: `members-backup-csv.ts` (export headers), `scripts/import-members/` (CSV columns — ~24 members still pending from TSCC), member detail page (render the new fields).

## 13. Questions for TSCC / the reviewer

1. **Zero-padding Tax ID** — we are not doing it (§ 2 #2). Confirm the reviewer accepts storing foreign IDs verbatim.
2. **"Not based in Thailand" checkbox** — folded into the Country field (§ 2 #7). Confirm.
3. **VAT registration** — we now ask for it explicitly. Does TSCC hold ภ.พ.20 status for its members, or should the entity-type default stand until a member asks for a corrected invoice?
4. Are there members who are **บุคคลธรรมดา but VAT-registered**? They are the one case the old guess got dangerously wrong (under-printing).
5. **Registered capital vs annual turnover** — membership tiers are banded on turnover today. Does TSCC intend to keep it that way, or eventually re-band on registered capital?
