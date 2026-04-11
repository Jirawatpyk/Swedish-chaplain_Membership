# Membership Benefits Analysis — 2026 Package

**Source**: `docs/_2026_Membership Package.pdf` (authoritative, as of 2026-04-11).
Note: this document represents **ONE tenant's** membership plans (SweCham 2026).
Other chambers on the SaaS platform will have their own plans.
**Supersedes**: `docs/database-analysis.md` (deleted 2026-04-11 — Excel-derived,
known to be inaccurate — Excel tier list was assembled by admin and did not
match the official 2026 package)
**Applies to**: F2 (Membership Plans) + cascade to F3, F4, F7 Email Broadcast,
F8 Renewal, F9 Dashboard
**Multi-tenancy**: Platform is **Multi-Tenant Aware, Single-Tenant Deployed**
(MTA+STD). See `docs/saas-architecture.md` for the strategy. Schemas in this
document include `tenant_id` columns and are designed for future SaaS use.

---

## 1. Two-layer tier structure (not one!)

The 2026 package has **two independent layers**:

```
┌──────────────────────────────────────────────────────────────┐
│  LAYER A — CORPORATE MEMBERSHIP                              │
│  (base tier that every member company pays)                  │
│                                                              │
│   Premium      36,000 THB/year   turnover > 100M THB         │
│   Large        26,000 THB/year   turnover 50–100M            │
│   Regular      16,000 THB/year   turnover < 50M              │
│   Start-up     10,000 THB/year   max 2 years                 │
│   Individual    6,000 THB/year   individual membership       │
│   Thai Alumni   1,000 THB/year   up to age 35 / students     │
└──────────────────────────────────────────────────────────────┘
                              +
┌──────────────────────────────────────────────────────────────┐
│  LAYER B — PARTNERSHIP (optional, sponsorship add-on)        │
│  (Partnership packages INCLUDE Premium Corporate already)    │
│                                                              │
│   Diamond     200,000 THB/year   6 tickets/event included    │
│   Platinum    150,000 THB/year   4 tickets/event included    │
│   Gold        100,000 THB/year   2 tickets/event included    │
│                                                              │
│   ⭐ "SweCham Premium Corporate Membership included"         │
│      → means the 36k Premium base is bundled into the        │
│        partnership fee, NOT invoiced separately.             │
└──────────────────────────────────────────────────────────────┘

Additional fees (all tiers):
  + 7% VAT on every fee
  + 1,000 THB one-time registration fee (new members only)
```

**Critical insight**: Partnership is NOT a "higher membership tier" — it is a
**sponsorship product** that bundles Premium Corporate membership as part of
its fee. A company buying Platinum partnership:
- Is effectively a Premium Corporate member for benefit purposes
- Gets ADDITIONAL sponsorship benefits (event tickets, logos, ads, booths)
- Pays one invoice for 150k (not 36k + 114k sponsorship)

**The Excel file analysed earlier** flattened these two layers into a single
"membership type" list with Platinum/Gold at the top. That representation is
**wrong** for data modeling because:
1. Partnership tiers have fundamentally different benefit categories (sponsorship, not just discount rates)
2. A member can upgrade/downgrade Partnership without changing Corporate tier
3. Billing logic differs (Partnership includes base fee, corporate doesn't)
4. The Excel tier names (Platinum/Gold as top membership levels) don't match the PDF (those are partnership levels)

---

## 2. Full benefit matrix (corporate tiers)

From `_2026_Membership Package.pdf` pages 1–2:

| Benefit | Unit / Type | **Premium** | **Large** | **Regular** | **Start-up** | **Individual** | **Thai Alumni** |
|---|---|---|---|---|---|---|---|
| Annual fee (THB) | currency | 36,000 | 26,000 | 16,000 | 10,000 | 6,000 | 1,000 |
| Turnover requirement | THB/year | > 100M | 50–100M | < 50M | — | n/a | n/a |
| Membership duration | years | unlimited | unlimited | unlimited | **max 2** | unlimited | **until age 35** |
| **Brand Visibility** | | | | | | | |
| E-Blast Service | count/year | 6 | 3 | 1 | 0 | 0 | 0 |
| Website Page | type | Member News Update | Member News Update | Member News Update | SMEs Spotlight | — | Student/Intern CV |
| Hyperlinked logo on homepage | category | Premium | Large Corporate | Regular Corporate | Start-up | — | — |
| Directory E-Book listing | size | 1 page + logo | 1 page + logo | ½ page + logo | ½ page + logo | ⅛ page + logo | ⅛ page + logo |
| **Events** | | | | | | | |
| Member discount rate scope | enum | all employees | all employees | all employees | all employees | 1 ticket/event | 1 ticket/event |
| Member entry at co-branded chambers | bool | ✓ | ✓ | — | — | — | — |
| Cultural event tickets | count/year | 2 | 1 | 0 | 0 | 0 | 0 |
| **Additional Benefits** | | | | | | | |
| Member-to-member benefits access | bool | ✓ | ✓ | ✓ | ✓ | — | — |
| Business referrals | bool | ✓ | ✓ | ✓ | ✓ | — | — |
| Tailor-made services | bool | ✓ | ✓ | ✓ | — | — | — |

**Totals**: 6 corporate tiers × 12 benefit dimensions = 72 data points to encode

---

## 3. Full benefit matrix (partnership tiers)

From `_2026_Membership Package.pdf` page 3:

| Benefit | Unit | **Diamond** | **Platinum** | **Gold** |
|---|---|---|---|---|
| Annual fee (THB) | currency | 200,000 | 150,000 | 100,000 |
| Includes Premium Corporate | bool | ✓ | ✓ | ✓ |
| **Events** | | | | |
| Event tickets included | count/event | 6 | 4 | 2 |
| Complimentary networking events access | scope | all | all | all |
| Complimentary booth at all SweCham events | bool | ✓ | ✓ | ✓ |
| Roll-up + logo at all events | bool | ✓ | ✓ | ✓ |
| **Brand Visibility - Events** | | | | |
| Logo on promotional merch | bool | ✓ | ✓ | ✓ |
| Corporate VDO at events (duration) | minutes | 1.5 | 1.0 | 1.0 |
| Corporate VDO frequency | scope | all SweCham events | all SweCham events | 3 SweCham events of choice |
| **Brand Visibility - Website & E-Pub** | | | | |
| Hyperlinked logo on SweCham website | months | 12 | 6 | 3 |
| Advertising banner on website | count/year | 20 | 15 | 10 |
| Promotion of corporate news in Newsletter | bool | ✓ | ✓ | ✓ |
| Hyperlinked logo in all E-Newsletters | bool | ✓ | ✓ | ✓ |
| E-Blast Service | count/year | 15 | 10 | 6 |
| Premium Directory advertisement position | text | pages 1–2 (diamond position) | one of first pages | one of first 10 pages |

**Totals**: 3 partnership tiers × 13 benefit dimensions = 39 data points

**Plus**: Partnership members inherit all Premium Corporate benefits.

---

## 4. Data model recommendation (for F2 spec)

### Decision: **single `membership_plans` table, benefits flattened per row**

Rationale:
1. **Plans change infrequently** — once per year at most, usually stable for 2–4 years
2. **Small cardinality** — 9 rows total (6 corporate + 3 partnership)
3. **Query simplicity wins over DRY** at this scale — joining Partnership → Premium to merge benefits adds complexity for minimal data-saving
4. **Single source of truth per plan** — admin reads one row to see "what does a Platinum partner get?"
5. **Versioning friendly** — when 2027 package launches, new rows are added with `plan_year: 2027` and the old rows stay (historical integrity)

### Proposed schema

```ts
// src/modules/members/infrastructure/db/schema.ts (F2)
import { pgEnum, pgTable, text, integer, boolean, decimal, uniqueIndex } from 'drizzle-orm/pg-core';

export const planCategoryEnum = pgEnum('plan_category', ['corporate', 'partnership']);
export const directoryListingSizeEnum = pgEnum('directory_listing_size', ['full_page', 'half_page', 'eighth_page']);
export const eventDiscountScopeEnum = pgEnum('event_discount_scope', ['all_employees', 'one_ticket_per_event', 'none']);

export const membershipPlans = pgTable(
  'membership_plans',
  {
    // MULTI-TENANT: every plan belongs to a specific tenant (chamber).
    // Different chambers have different plan catalogs — SweCham has 9,
    // another chamber might have 5 or 12. Row-level isolation via tenant_id.
    tenantId: text('tenant_id').notNull().default('swecham'),

    // Identity
    planId: text('plan_id').notNull(), // 'premium', 'large', 'regular', 'start-up', 'individual', 'thai-alumni', 'diamond', 'platinum', 'gold'
    planName: text('plan_name').notNull(), // Display name: "Premium Corporate", "Diamond Partnership"
    planCategory: planCategoryEnum('plan_category').notNull(),
    planYear: integer('plan_year').notNull().default(2026), // Versioning — 2026 package
    sortOrder: integer('sort_order').notNull(), // display order in dropdowns

    // Pricing (all values in THB, net of VAT)
    annualFeeThb: integer('annual_fee_thb').notNull(),
    // Partnership plans have this set; corporate plans NULL
    includesCorporatePlanId: text('includes_corporate_plan_id'), // 'premium' for all partnership tiers

    // Eligibility constraints
    minTurnoverThb: integer('min_turnover_thb'), // 100000000, 50000000, null, null (Premium, Large, Regular, others)
    maxTurnoverThb: integer('max_turnover_thb'), // null, 100000000, 50000000, ...
    maxDurationYears: integer('max_duration_years'), // null for unlimited, 2 for start-up
    maxMemberAge: integer('max_member_age'), // null for unlimited, 35 for thai-alumni

    // Brand Visibility benefits
    eblastPerYear: integer('eblast_per_year').notNull().default(0),
    websitePageType: text('website_page_type'), // 'member_news_update', 'smes_spotlight', 'student_intern_cv', null
    homepageLogoCategory: text('homepage_logo_category'), // 'premium', 'large', 'regular', 'start_up', null
    directoryListingSize: directoryListingSizeEnum('directory_listing_size'), // full_page / half_page / eighth_page

    // Event benefits (base — applies to both corporate and partnership)
    eventDiscountScope: eventDiscountScopeEnum('event_discount_scope').notNull(),
    eventsCobrandedAccess: boolean('events_cobranded_access').notNull().default(false), // JFCCT, EABC
    culturalTicketsPerYear: integer('cultural_tickets_per_year').notNull().default(0),

    // Additional benefits (corporate-focused)
    m2mBenefitsAccess: boolean('m2m_benefits_access').notNull().default(false),
    businessReferrals: boolean('business_referrals').notNull().default(false),
    tailorMadeServices: boolean('tailor_made_services').notNull().default(false),

    // Partnership-only benefits (NULL for corporate plans)
    eventTicketsIncluded: integer('event_tickets_included'), // 6 / 4 / 2 / null
    boothIncluded: boolean('booth_included').default(false),
    rollupLogoAtEvents: boolean('rollup_logo_at_events').default(false),
    logoOnMerch: boolean('logo_on_merch').default(false),
    videoDurationMinutes: decimal('video_duration_minutes', { precision: 3, scale: 1 }), // 1.5 / 1.0 / 1.0
    videoFrequencyScope: text('video_frequency_scope'), // 'all_events', 'three_selected_events'
    websiteLogoMonths: integer('website_logo_months'), // 12 / 6 / 3
    bannerPerYear: integer('banner_per_year'), // 20 / 15 / 10
    newsletterPromotion: boolean('newsletter_promotion').default(false),
    enewsletterLogo: boolean('enewsletter_logo').default(false),
    directoryAdPosition: text('directory_ad_position'), // 'pages_1_and_2' / 'first_pages' / 'first_10_pages'

    // Metadata
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    // Composite PK: (tenant_id, plan_id, plan_year) — same plan_id can exist
    // across different tenants and years
    pk: primaryKey({ columns: [table.tenantId, table.planId, table.planYear] }),
    tenantCategoryIdx: index('membership_plans_tenant_category_idx').on(
      table.tenantId,
      table.planCategory,
    ),
  }),
);

// PER-TENANT fee config (VAT rate + registration fee varies by country/chamber)
// SweCham: VAT 7%, 1,000 THB registration
// Future tenants: different values (e.g., JFCCT might use VAT 10%)
export const membershipFeesConfig = pgTable(
  'membership_fees_config',
  {
    tenantId: text('tenant_id').primaryKey().default('swecham'),
    currencyCode: text('currency_code').notNull().default('THB'), // ISO 4217
    vatRate: decimal('vat_rate', { precision: 5, scale: 4 }).notNull().default('0.07'), // 7% Thailand
    registrationFee: integer('registration_fee').notNull().default(1000), // one-time, in smallest unit (THB × 1)
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
);
```

**⚠ Per-tenant considerations**:
- **VAT rate varies by country** — Thailand 7%, Japan 10%, Singapore 8%, EU countries 15-25%
- **Currency varies** — THB for SweCham, JPY for Japanese chamber, EUR for European
- **Registration fee is optional** — some chambers waive it; tenant can set to 0
- **Plan IDs are tenant-scoped** — "premium" in SweCham ≠ "premium" in German chamber

### Seed data

All seeds are tenant-scoped to `'swecham'`. When a new chamber onboards, they
run a similar seed with `tenant_id = '<their-slug>'` and their own plan values.

```sql
-- drizzle/migrations/000X_seed_swecham_plans.sql
-- SweCham 2026 plans — 9 rows (6 corporate + 3 partnership)
INSERT INTO membership_plans (tenant_id, plan_id, plan_name, plan_category, plan_year, sort_order, annual_fee_thb, includes_corporate_plan_id, /* ... remaining 20+ columns ... */)
VALUES
-- Corporate (6 rows)
('swecham', 'premium',      'Premium Corporate',    'corporate',   2026, 10, 36000,  NULL,       /* ... */),
('swecham', 'large',        'Large Corporate',      'corporate',   2026, 20, 26000,  NULL,       /* ... */),
('swecham', 'regular',      'Regular Corporate',    'corporate',   2026, 30, 16000,  NULL,       /* ... */),
('swecham', 'start-up',     'Start-up',             'corporate',   2026, 40, 10000,  NULL,       /* ... */),
('swecham', 'individual',   'Individual',           'corporate',   2026, 50,  6000,  NULL,       /* ... */),
('swecham', 'thai-alumni',  'Thai Alumni/Student',  'corporate',   2026, 60,  1000,  NULL,       /* ... */),
-- Partnership (3 rows — all include Premium Corporate)
('swecham', 'diamond',      'Diamond Partnership',  'partnership', 2026,  1, 200000, 'premium',  /* ... */),
('swecham', 'platinum',     'Platinum Partnership', 'partnership', 2026,  2, 150000, 'premium',  /* ... */),
('swecham', 'gold',         'Gold Partnership',     'partnership', 2026,  3, 100000, 'premium',  /* ... */);

-- Per-tenant fee config (SweCham: Thailand, THB, VAT 7%, registration 1,000 THB)
INSERT INTO membership_fees_config (tenant_id, currency_code, vat_rate, registration_fee)
VALUES ('swecham', 'THB', 0.07, 1000);
```

### Relationship to `members` (F3)

```ts
// In F3 members schema (proposed)
members {
  member_id ...
  plan_id TEXT NOT NULL REFERENCES membership_plans(plan_id),  -- current plan
  membership_start_date DATE NOT NULL,                          -- for start-up 2-year cap
  ...
  CHECK (plan_id IS NOT NULL)
}
```

Only **one plan** per member at a time. If a member upgrades from Regular → Platinum
Partnership, their `plan_id` changes from `'regular'` to `'platinum'`. Historical
record is kept in the audit log, not duplicated in the members table.

---

## 5. Open questions for F2 `/speckit.clarify`

These need answers when we run `/speckit.specify` for F2:

- **Q1**: For the Start-up "max 2 years" rule — does the 2-year clock start from:
  (a) the member's `membership_start_date`, or
  (b) the company's incorporation date (if we track that)?
  The PDF just says "Start-up membership status is limited to a maximum of 2 years"
  — most likely interpretation is (a).

- **Q2**: For Thai Alumni "age ≤ 35" — this is a PERSONAL age, but our members
  table is company-level. How does this work?
  - Option A: Thai Alumni is actually an INDIVIDUAL membership (not a company)
    — members table needs to distinguish company vs individual rows
  - Option B: Thai Alumni lives in a separate table (`individual_members`)
  - Option C: It's modeled the same as Individual, just with age validation on the linked contact
  - **Best practice recommendation**: Option A — a single `members` table with a
    `member_type ENUM ('company', 'individual')` column. Individual members
    (including Thai Alumni) have `company_name = contact.full_name`.

- **Q3**: Pro-rated fees — if someone joins mid-year (say October), do they pay:
  (a) full annual fee, or
  (b) 3/12 × annual fee for the remainder of the year?
  Not addressed in PDF.
  - **Best practice default**: Pro-rate by remaining months; F4 invoicing calculates.

- **Q4**: Upgrade / downgrade mid-term — if a Regular company wants to upgrade to
  Premium in March, do they:
  (a) get credited for the unused Regular portion, or
  (b) pay the full Premium fee on top, or
  (c) pay the difference pro-rated?
  - **Best practice default**: (c) pay the difference, pro-rated.

- **Q5**: Registration fee 1,000 THB — when does this apply?
  - PDF says: "an additional registration fee of THB 1,000 (one-time cost)
    applies to new members."
  - Does "new" mean "first-ever member" or "any new fiscal year enrolment"?
  - **Best practice default**: first-ever enrolment. Tracked via
    `members.registration_fee_paid_at`.

---

## 6. Cascade impact summary

| Feature | Impact | Change needed |
|---|---|---|
| **F1 Auth & RBAC** | ✅ None — already merged (PR #1) | — |
| **F2 Membership Plans** | 🚨 **Major rewrite vs Excel-derived scope** | Schema above + seed 9 plans + fee config + 5 clarifications |
| **F3 Members & Contacts** | ⚠ Moderate | `plan_id` FK, `member_type` enum (company/individual), `membership_start_date`, start-up 2-year cap, Thai Alumni age rule |
| **F4 Membership Invoicing** | ⚠ Moderate | Pro-rate logic, registration fee, VAT 7%, partnership fee (single line, not corporate + sponsorship split) |
| **F5 Online Payment** | ✅ None | Payment processor doesn't care about tier structure |
| **F6 Event Management** | ✅ None | Events are plan-agnostic |
| **F7 Event Registration** | 🚨 **Major** | Ticket allocation from `membership_plans.event_tickets_included`, co-branded chamber access check (`events_cobranded_access`), cultural tickets counter, discount scope logic |
| **F8 Renewal Tracking** | ⚠ Moderate | Start-up auto-expire at 2 years (upgrade prompt), Thai Alumni auto-expire at age 35, registration fee skipped on renewals |
| **F9 Admin Dashboard + Directory** | 🚨 **Major** | Directory listing generation (size from plan), homepage logo slots (category from plan), E-Blast quota tracker, banner schedule (Partnership), admin UI for F2 plan editing |

---

## 7. Business rules derived from benefits

These rules should be implemented in the domain layer (`src/modules/members/domain/`)
and enforced by the application layer:

### 7.1 Turnover eligibility

- **Premium**: requires declared turnover > 100,000,000 THB — stored on
  `members.declared_turnover_thb`, validated at member creation and upgrade
- **Large**: requires 50,000,000 ≤ turnover ≤ 100,000,000 THB
- **Regular**: requires turnover < 50,000,000 THB
- **Start-up / Individual / Thai Alumni**: no turnover requirement
- **Partnership (any)**: no explicit turnover requirement (they pay more than
  Premium already, so eligibility is assumed met)

### 7.2 Start-up time limit

- Members on the `start-up` plan must be upgraded or removed within 2 years of
  their `membership_start_date`
- F8 (Renewal) fires a warning at 18 months and a blocking notice at 24 months
- After 24 months, the member is auto-moved to `regular` status unless manually
  upgraded (this needs Q1 clarification)

### 7.3 Thai Alumni age limit

- Members on the `thai-alumni` plan must be ≤ 35 years old
- F8 (Renewal) fires a notice 30 days before the linked contact's 36th birthday
- After 35, the member must upgrade to `individual` (or another plan)
- **Data prerequisite**: `contacts.date_of_birth` column needed in F3 (a
  departure from Excel which doesn't track DOB)

### 7.4 Partnership benefit inheritance

- When a member has `plan_id IN ('diamond', 'platinum', 'gold')`, the
  benefit-lookup code MUST merge the partnership row with the
  `includes_corporate_plan_id = 'premium'` row for complete benefits
- Example: a Gold Partner has `newsletter_promotion: TRUE` (from gold row) AND
  all Premium Corporate benefits (inherited via `includes_corporate_plan_id`)
- The merge is **additive** — partnership benefits ADD to corporate benefits,
  they don't replace them
- Query pattern:
  ```sql
  SELECT
    plan.* ,
    corp.m2m_benefits_access AS inherited_m2m,
    corp.tailor_made_services AS inherited_tailor_made
  FROM membership_plans plan
  LEFT JOIN membership_plans corp
    ON corp.plan_id = plan.includes_corporate_plan_id
   AND corp.plan_year = plan.plan_year
  WHERE plan.plan_id = $1;
  ```

### 7.5 Invoice line items

For a corporate plan (e.g., Premium):
```
Line 1: Premium Corporate Membership (2026)   36,000.00
Line 2: VAT 7%                                  2,520.00
Line 3: Registration fee (new member only)     1,000.00 + VAT 70.00
---
Total (new member):   39,590.00 THB
Total (renewal):      38,520.00 THB
```

For a partnership plan (e.g., Platinum):
```
Line 1: Platinum Partnership (2026)           150,000.00
Line 2: VAT 7%                                  10,500.00
Line 3: Registration fee (new member only)      1,000.00 + VAT 70.00
---
Total (new member):  161,570.00 THB
Total (renewal):     160,500.00 THB
```

Note: The partnership fee is NOT split into "corporate + sponsorship" on the
invoice. It is one line item at the headline price. The Premium Corporate
inclusion is a **benefit-side** concept, not a billing-side concept.

---

## 8. Action items

- [x] Analysis of PDF and delta vs Excel — this document
- [ ] Update `docs/database-analysis.md` §6 with correction pointing here
- [ ] Update `docs/phases-plan.md` to reflect expanded F2 scope + cascade
- [ ] Run `/speckit.specify` for F2 (use this document as primary input, not Excel)
- [ ] Answer Q1–Q5 during `/speckit.clarify` for F2
- [ ] Propagate `plan_id` + related fields into F3 spec when it is drafted

---

## 9. Revision log

| Date | Source | Change |
|---|---|---|
| 2026-04-09 | Excel template v11 | Initial analysis (now known to be inaccurate) |
| **2026-04-11** | **PDF 2026 Membership Package** | **Corrected two-layer structure, added partnership tier, full benefit matrix, data model recommendation, Q1–Q5 for F2 clarify** |
