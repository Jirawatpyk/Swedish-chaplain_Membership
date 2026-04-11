# SaaS Architecture — Multi-Tenant Chamber Platform

**Status**: Strategic architecture document, informs F2 onwards
**Date**: 2026-04-11
**Vision**: SweCham → Multi-chamber SaaS platform for membership organisations
**Applies to**: F2–F13 (F1 auth stays cross-tenant, F2+ are tenant-scoped)

---

## 1. Vision

Start as SweCham's membership system. Evolve into a **SaaS platform** for
chambers of commerce, professional associations, alumni clubs, and membership
organisations — particularly those needing **Thai-tax-compliant invoicing**
and **tri-lingual support (Thai + English + Swedish/other)** that commercial
platforms (GlueUp, Wild Apricot, MemberClicks) don't do well.

### Target customers (ranked by fit)

1. **Thai-based foreign chambers** — JCC (Japanese), FTCC (French), GTCC (German),
   SATCC (Swiss), DTCC (Danish), BCCT (British), AMCHAM, Netherlands,
   Nordcham, Australcham — ~15-20 chambers in Bangkok, 100-500 members each
2. **APAC chambers** — Indonesian, Vietnamese, Malaysian equivalents
3. **Thai industry associations** — BOI members, sectoral associations (TISI,
   TGCA, federations)
4. **Professional bodies** — bar associations, engineering societies, alumni clubs
5. **International chambers** — Nordic/EU chambers that want lightweight alt
   to GlueUp

### Competitive moat

1. 🎯 **Thai-tax compliant invoicing** — RD-compliant Thai-language invoices
   with VAT 7%, proper tax receipt numbering, dual-language PDFs. Competitors
   do not.
2. 🌏 **Tri-lingual by design** — SV + EN + TH mandatory from day 1.
   Expandable to JA, DE, FR, etc.
3. 🧠 **Smart chamber features** — Benefit quota tracking, at-risk detection,
   timeline per member. Competitors are dumb databases.
4. 💰 **Lower price point** — target $99-299/month vs GlueUp's $400-800/month
5. 🔒 **PDPA + GDPR compliant from day 1** — not a retrofit
6. 🛠 **Developer-friendly** — open API (future), webhook support, audit log
   query language
7. 🇹🇭 **Thai-first** — payment rails (PromptPay), banks, tax law, addresses,
   Buddhist calendar display option

---

## 2. Approach — **MTA+STD** (Multi-Tenant Aware, Single-Tenant Deployed)

This is the **spectrum position** of our architecture:

```
Single-tenant          MTA+STD ⭐              Full multi-tenant
       ▼                  ▼                            ▼
   ┌───────┐         ┌───────┐                    ┌───────┐
   │  F1   │         │  F2+  │                    │ Every │
   │ auth  │         │ plans │                    │ table │
   │ 1     │         │members│                    │tenant │
   │tenant │         │invoic.│                    │_id    │
   └───────┘         │events │                    │enforce│
                     │ ...   │                    │  RLS  │
                     └───────┘                    └───────┘
                         │
                     Tenant ID
                     hardcoded
                    'swecham' for
                       deploy
```

**MTA+STD** means:
- **Schema**: every F2+ table has `tenant_id` column
- **Queries**: every query filters by `tenant_id` at the application layer
  (middleware-injected context)
- **Currently**: `tenant_id` default is `'swecham'` so current SweCham deploy
  works like a single-tenant system
- **Future**: when another chamber signs up, `tenant_id` becomes mandatory
  (default removed) and onboarding flow provisions them

**Effort**:
- MTA+STD costs **~20-30% more effort now** vs pure single-tenant
- Full multi-tenant migration later costs **~15% more** (mostly onboarding
  UX, billing, white-label)
- Pure single-tenant now + retrofit multi-tenant later costs **100-200% more**
  than MTA+STD total because every table needs migration

---

## 3. Tenant isolation strategy

### Chosen: **Shared database, shared schema, `tenant_id` column + Postgres RLS**

```
┌─────────────────────────────────────────┐
│  ONE Postgres database (Neon)           │
│                                         │
│  ┌─────────────────────────────────┐   │
│  │ membership_plans                 │   │
│  │ ┌────────┬──────┬─────────────┐ │   │
│  │ │tenant  │plan  │ annual_fee  │ │   │
│  │ ├────────┼──────┼─────────────┤ │   │
│  │ │swecham │prem  │ 36000       │ │   │
│  │ │swecham │large │ 26000       │ │   │
│  │ │jcc     │gold  │ 50000       │ │◀──┤ Row-level isolated
│  │ │jcc     │silv  │ 30000       │ │   │ via tenant_id +
│  │ │gtcc    │a     │ 40000       │ │   │ Postgres RLS policy
│  │ └────────┴──────┴─────────────┘ │   │
│  └─────────────────────────────────┘   │
└─────────────────────────────────────────┘
```

**Why shared-DB-shared-schema** (vs schema-per-tenant or DB-per-tenant)?

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Shared DB, shared schema, `tenant_id` + RLS** ⭐ | Cheapest ops, single migration, easy backups, simple code | Noisy neighbour risk, RLS complexity | **Chosen** |
| Shared DB, schema-per-tenant | Better isolation, per-tenant tuning | Migration complexity (N schemas), expensive ops | Rejected — overkill for <100 tenants |
| DB-per-tenant | Strongest isolation, compliance-friendly | Expensive ($25/mo/DB), complex ops, not scalable | Rejected — violates unit economics |

### Postgres Row-Level Security (RLS) policy

```sql
-- One policy applied to every F2+ table
ALTER TABLE membership_plans ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation_policy ON membership_plans
  USING (tenant_id = current_setting('app.current_tenant', TRUE));

-- The application sets the current tenant per connection:
SET LOCAL app.current_tenant = 'swecham';

-- Now SELECT/INSERT/UPDATE/DELETE only see rows where tenant_id matches
```

Every connection from the app layer sets `app.current_tenant` based on the
request's resolved tenant, before running queries. Even if application code
has a bug and forgets to filter, **Postgres enforces isolation at the DB
layer**.

### Exceptions

- **Super-admin queries** (F13 console) bypass RLS via a `BYPASS_RLS` role
- **Audit log** has RLS too (audit entries are tenant-scoped)
- **F1 `users` table** does NOT have RLS (users are cross-tenant identities)
- **`tenants` table** has RLS only for super-admin operations

---

## 4. Authentication layer (F1) — **Cross-tenant by design**

F1 was built and shipped before the SaaS pivot. It does NOT have `tenant_id`
on `users`, `sessions`, `password_reset_tokens`, `invitations`, or `audit_log`.

**This is correct** — F1 represents **identity**, not **membership**:
- A person has ONE email address and ONE password
- That person can be `admin` of SweCham AND `member` of JCC simultaneously
- They sign in once, then switch between tenants via UI

### Proposed future structure (SaaS phase F10+)

```
┌─────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  users          │     │  user_tenants    │     │  tenants         │
│  (F1, unchanged)│     │  (F10, new)      │     │  (F10, new)      │
├─────────────────┤     ├──────────────────┤     ├──────────────────┤
│ id (UUID)       │────►│ user_id  FK     │◄────│ id (slug)         │
│ email (unique)  │     │ tenant_id FK    │     │ name              │
│ password_hash   │     │ role             │     │ domain            │
│ display_name    │     │ status           │     │ billing_customer  │
│ ...             │     │ joined_at        │     │ ...               │
└─────────────────┘     └──────────────────┘     └──────────────────┘
                              │
                              │ one user can have multiple rows
                              │ (one per tenant they belong to)
                              ▼
                     { user_id, tenant_id, role }
                       e.g.
                       (alice, swecham, admin)
                       (alice, jcc,     member)
```

**Session token carries current tenant**:

```
Session {
  id: "64-hex"
  user_id: UUID
  current_tenant_id: "swecham"  // NEW — was null pre-SaaS
  created_at, last_seen_at, expires_at, source_ip
}
```

When user switches tenants (e.g., "Switch to JCC" in UI), the session's
`current_tenant_id` is updated after re-verifying they have access.

### F1 migration path to SaaS

1. **Phase 0 (now)**: F1 as-is, no tenant concept in auth
2. **Phase 1 (when F10 ships)**:
   - Add `tenants` table
   - Add `user_tenants` table
   - Backfill: every existing user gets `(user_id, 'swecham', <current role>)`
   - Add `current_tenant_id` column to `sessions` (default `'swecham'`)
   - Add tenant switcher UI + policy enforcement
3. **Phase 2 (when F13 ships)**:
   - Super-admin console can impersonate into any tenant
   - Impersonation logged as audit events

---

## 5. Tenant resolution strategy (how requests find their tenant)

### Chosen: **Hybrid — subdomain default + custom domain premium**

```
┌────────────────────────────────────────────────────────┐
│ Request URL                      → Tenant ID           │
├────────────────────────────────────────────────────────┤
│ https://swecham.chamber-os.app   → 'swecham'           │ default (subdomain)
│ https://jcc.chamber-os.app       → 'jcc'               │ default (subdomain)
│ https://gtcc.chamber-os.app      → 'gtcc'              │ default (subdomain)
│ https://members.swecham.se       → 'swecham'           │ premium (custom domain)
│ https://app.jcc.or.jp            → 'jcc'               │ premium (custom domain)
└────────────────────────────────────────────────────────┘
```

**Resolution order** (in `src/proxy.ts` middleware):

1. **Custom domain lookup** — query `tenants` table where `custom_domain = request.host`
2. **Subdomain extraction** — if host ends in `chamber-os.app`, take first
   segment as `tenant_slug`
3. **Header override** (for dev / admin tooling) — `X-Tenant-Slug: swecham`
4. **Fallback** — default to `'swecham'` for local dev without DNS setup
5. **Super-admin paths** — `/_super/*` uses header override only

### Tenant onboarding (F10)

When a new chamber signs up:

1. Chooses a slug (e.g., `jcc`)
2. Platform provisions:
   - Subdomain: `jcc.chamber-os.app`
   - Default membership plans (copy from SweCham as starting point, then
     admin customises)
   - Default fee config (admin sets VAT rate, currency, registration fee)
   - First admin user account (they set password via invitation flow)
   - Branding defaults (logo upload, colour palette)
   - Optional: custom domain setup via DNS verification
3. Starts 14-day free trial
4. Stripe Customer + subscription created (F11)

---

## 6. Customisation axes (what varies per tenant)

The following MUST be configurable per tenant:

### Data
- Membership plans (each chamber has own plan catalog)
- Fee configuration (VAT rate, currency, registration fee)
- Role names (some chambers use "secretariat", "committee" instead of
  "admin", "manager") — localisable display names
- Member fields (some chambers need extra fields: founding date,
  industry code, etc.)
- Benefit types (custom benefit categories)

### Appearance
- Logo + wordmark
- Primary brand colour + accent
- Favicon
- Email templates (header, footer, signature)
- Invoice PDF template (header, footer, terms)
- Directory E-Book template

### Localisation
- Primary language (SweCham default = EN; Japanese chamber = JA)
- Supported languages (subset of platform locales)
- Calendar (Gregorian / Buddhist / Islamic — Buddhist for Thai tenants)
- Date/time format
- Currency + number format

### Integrations
- Payment processor (Stripe, Omise, 2C2P — tenant's own account)
- Email provider (Resend — platform default; bring-your-own OK)
- EventCreate (tenant's own account + Zap)
- Webhook endpoints (tenant can add custom receivers)

### Compliance
- VAT rate
- Tax invoice format (RD for Thailand, different for other countries)
- Privacy notice (tenant's own DPIA)
- Data residency preference

### What is NOT per-tenant (global)
- Platform code (features are same across tenants)
- Platform domain / brand (chamber-os.app)
- Security policies (argon2 params, session TTL, etc. — same for all)
- Audit log schema (same structure)

---

## 7. Billing model (two layers)

**Layer A** — Platform-level billing (what tenant pays us):

```
┌─────────────────────────────────────────────┐
│ SaaS Platform Pricing                        │
│                                             │
│ ┌───────────┬────────┬────────┬──────────┐ │
│ │ Plan      │ Price  │ Members│ Features │ │
│ ├───────────┼────────┼────────┼──────────┤ │
│ │ Free trial│  $0/mo │  30    │ F2-F9    │ │
│ │ Starter   │ $99/mo │ 100    │ F2-F9    │ │
│ │ Pro       │$299/mo │ 500    │ + smart  │ │
│ │ Enterprise│$799/mo │unlimit.│ + white- │ │
│ │           │        │        │ label    │ │
│ └───────────┴────────┴────────┴──────────┘ │
│                                             │
│ Stripe Subscriptions (F11)                  │
│ Billed to tenant's Stripe Customer          │
└─────────────────────────────────────────────┘
```

**Layer B** — Tenant's own membership billing (what tenant's members pay them):

```
┌─────────────────────────────────────────────┐
│ Tenant's Members → Tenant                   │
│                                             │
│ Premium Corporate: 36,000 THB/year           │
│ Platinum Partner: 150,000 THB/year           │
│ Event tickets, etc.                         │
│                                             │
│ Uses F4 (Invoicing) + F5 (Payment)          │
│ Payments go to tenant's Stripe account      │
│ (NOT to the SaaS platform's account)        │
└─────────────────────────────────────────────┘
```

**Critical**: Layer A and Layer B are **completely separate**. The SaaS
platform does NOT take a cut of tenant's member payments — that's the
tenant's revenue. SaaS platform makes money from monthly subscription only.

This is the same model as **Shopify** (merchants pay Shopify a subscription,
Shopify doesn't take a cut of merchant sales — except for Shopify Payments
which is a separate product).

### Stripe setup

- **Platform's Stripe account** handles Layer A (tenant subscription)
- **Tenant's Stripe account** handles Layer B (member payments) — each tenant
  connects their own via **Stripe Connect OAuth**
- Stripe Connect "standard" mode: tenant owns the Stripe account, SaaS only
  gets webhook notifications

---

## 8. White-label scope (F12)

Tenants on **Pro / Enterprise** plans get white-label:

### Starter plan (default)
- Platform name visible: "Powered by chamber-os.app"
- Platform logo visible in footer
- Subdomain only (no custom domain)

### Pro plan
- Platform branding hidden (no "Powered by" footer)
- Custom logo + brand colours
- Custom email templates
- Subdomain still used (but white-labelled)

### Enterprise plan
- Everything in Pro
- **Custom domain** (`members.swecham.se`)
- **Custom email sender** (`noreply@swecham.se` instead of platform)
- **Custom invoice template** (branding, terms)
- **SSO integration** (SAML, Google Workspace, Microsoft 365)
- **Dedicated support**
- **SLA (99.9% uptime commitment)**

---

## 9. Migration path — Single-tenant → Multi-tenant

### Phase 0 (now, MVP for SweCham)

- F1 deployed (no tenant concept)
- F2-F9 in development (MTA+STD schemas, hardcoded `tenant_id = 'swecham'`)
- Single domain: `swecham.chamber-os.app` or `swecham.zyncdata.app`
- One Stripe account (SweCham's)
- No onboarding flow — SweCham is the only tenant

### Phase 1 (F10 — Tenant Onboarding)

**Add**:
- `tenants` table
- `user_tenants` join table
- Backfill: `INSERT INTO tenants (id, name, domain) VALUES ('swecham', 'SweCham', 'swecham.chamber-os.app')`
- Backfill: `INSERT INTO user_tenants SELECT id, 'swecham', role FROM users`
- Subdomain-based routing in `proxy.ts`
- Onboarding wizard: new tenant signup → Stripe Checkout (trial) → provision → first-admin invitation
- Tenant switcher UI in user menu (for multi-tenant users)

**Remove** (nothing — additive only)

### Phase 2 (F11 — SaaS Billing)

- Stripe Subscriptions for Starter/Pro/Enterprise plans
- Usage limits: member count cap per plan, upgrade prompts
- Billing portal: tenant can view invoices, update card, upgrade/downgrade
- Dunning: failed payment → email → 7-day grace → feature freeze

### Phase 3 (F12 — White-label)

- Tenant branding settings (logo, colours, email templates)
- Custom domain support (DNS verification, SSL cert via Vercel)
- Feature gating: Pro features hidden on Starter

### Phase 4 (F13 — Super-admin Console)

- `/_super` route accessible only to platform owners
- View all tenants, health metrics, MRR, churn
- Impersonation into any tenant (audit-logged)
- Manual tenant operations: force-suspend, data export, GDPR deletion

---

## 10. Constitution alignment

### Principle I — Data Privacy & Security

**Tenant isolation MUST be provable**. Requirements:

- Every F2+ query filters by `tenant_id` (enforced by Postgres RLS policy)
- Every F2+ test includes a "cross-tenant access denied" case
- Audit log captures `tenant_id` on every event
- Cross-tenant data access is **impossible by design**, not by convention

### Principle III — Clean Architecture

**Tenant context as first-class domain concept**:

```typescript
// src/modules/shared/domain/tenant-context.ts
export interface TenantContext {
  readonly tenantId: TenantId; // branded string
}

// Every use case receives TenantContext as first argument:
export async function createMember(
  ctx: TenantContext,
  input: CreateMemberInput,
): Promise<Result<Member, CreateMemberError>> {
  // repo automatically filters by ctx.tenantId
  const existing = await memberRepo.findByEmail(ctx, input.email);
  // ...
}
```

Domain layer knows about `TenantContext` but doesn't depend on Postgres RLS —
isolation is enforced at two layers (application + DB) for defence in depth.

### Principle V — Internationalization

**Per-tenant locale configuration**:

- Each tenant picks supported locales from platform-supported set
- Default locale is tenant-specific (SweCham: EN; JCC: JA)
- Thai Buddhist calendar is a `th-TH` display option (not forced)

### Principle X — YAGNI

**Multi-tenant is not over-engineering because**:

1. The cost to retrofit multi-tenancy later is >5× the cost now
2. We KNOW we want SaaS (user stated it explicitly)
3. MTA+STD is the cheapest correct approach
4. 20-30% extra effort now vs 100-200% later

---

## 11. Pricing strategy vision

### Tiers

| Plan | Price/mo | Members | Features | Target |
|---|---|---|---|---|
| **Free Trial** | $0 | 30 | F2-F5, 14 days | Evaluation |
| **Starter** | $99 | 100 | F2-F9 core | Small chambers, clubs |
| **Pro** | $299 | 500 | + Smart features, white-label | Medium chambers |
| **Enterprise** | $799 | unlimited | + Custom domain, SSO, SLA | Large chambers, federations |

### Comparison to competitors

| Platform | Entry price | Features | Thai-compliance |
|---|---|---|---|
| **GlueUp** | $400/mo | Full | ❌ English only |
| **Wild Apricot** | $60/mo | Basic | ❌ English only |
| **MemberClicks** | $500/mo | Full | ❌ English only |
| **Chamber-OS** (us) | **$99/mo** | **Full + Thai** | ✅ Native |

### Revenue projection

```
Year 1:  1-3 tenants  × $99-299   = $100-900/mo MRR
Year 2:  10-20        × $150 avg  = $1,500-3,000/mo
Year 3:  30-50        × $200 avg  = $6,000-10,000/mo
Year 4:  80-150       × $250 avg  = $20,000-37,500/mo
Year 5:  200-400      × $300 avg  = $60,000-120,000/mo ARR $720k-1.4M
```

Break-even: **~20 tenants** covering ops costs (Vercel, Neon, Upstash,
Resend, engineering time).

---

## 12. Data export + GDPR right-to-portability

Every tenant MUST be able to **export all their data** at any time
(Principle I, GDPR Art. 20):

- Self-service export button in settings
- Generates a zip file: `tenant-{slug}-{date}.zip` containing:
  - `members.csv` — all member records
  - `contacts.csv` — all contacts
  - `plans.csv` — plan catalog
  - `invoices.csv` + `invoice_items.csv`
  - `events.csv` + `event_registrations.csv`
  - `audit_log.ndjson` — full audit trail
  - `settings.json` — tenant configuration
  - `README.md` — import instructions for common formats

**Deletion on request** (GDPR Art. 17):
- Tenant can request account deletion
- 30-day grace period with email reminders
- After 30 days: hard delete all tenant-scoped rows (via `tenant_id`)
- `users` table rows where the user has no other tenant are also deleted
- Audit log kept for 5 years (Constitution § retention) but anonymised

---

## 13. Open questions (for later phases, not blocking F2)

### Q-A: Pricing — per-member or flat tier?

- **Per-member pricing** (e.g., $1/member/month): aligns cost with value,
  scales with tenant growth
- **Flat tier pricing** (chosen): predictable, simpler billing, no disincentive
  to invite members
- **Hybrid**: flat base + per-member overage (common SaaS pattern)

**Recommendation**: Start flat, add overage if needed (based on usage data)

### Q-B: Free trial vs freemium?

- **Free trial** (14 days): common for B2B, creates urgency
- **Freemium** (limited forever): lowers friction, builds pipeline
- **Hybrid**: 14-day trial → auto-convert to Starter unless cancelled

**Recommendation**: 14-day trial, require credit card to avoid abuse

### Q-C: Tenant signup flow — self-service or sales-led?

- **Self-service**: tenant creates account online, picks plan, pays
- **Sales-led**: tenant contacts us, we demo, create account manually
- **Hybrid**: self-service for Starter/Pro, sales-led for Enterprise

**Recommendation**: Hybrid. Self-service covers volume; sales-led secures deals.

### Q-D: Data isolation verification — audits?

- Who verifies that RLS is actually working?
- **Internal**: automated test per release that tries cross-tenant access
- **External**: annual SOC 2 Type II audit
- **Customer**: provide pen-test results + RLS policy SQL

**Recommendation**: Internal tests MVP; SOC 2 when revenue > $10k/mo MRR

---

## 14. Action items (for later SaaS phases, not this commit)

- [ ] F10: Tenant onboarding flow (signup wizard, provisioning)
- [ ] F11: Stripe Subscriptions integration (Layer A billing)
- [ ] F12: White-label branding system (logo, colours, email templates)
- [ ] F13: Super-admin console (tenant management, impersonation)
- [ ] SOC 2 Type II audit when MRR > $10k
- [ ] Public pricing page
- [ ] Marketing site (chamber-os.app)
- [ ] Documentation site (docs.chamber-os.app)

---

## 15. References

- [Membership Benefits Analysis](./membership-benefits-analysis.md) — SweCham's 2026 plans (one tenant's data)
- [Email Broadcast Analysis](./email-broadcast-analysis.md) — F7 design
- [Event Integration Analysis](./event-integration-analysis.md) — F6 design
- [Smart Chamber Features](./smart-chamber-features.md) — cross-cutting features
- [Phases Plan](./phases-plan.md) — full roadmap
- [Constitution](../.specify/memory/constitution.md) — governance
