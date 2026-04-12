# Smart Chamber Features — Cross-cutting Differentiators

**Status**: Strategic features that differentiate Chamber-OS from commercial alternatives (GlueUp, Wild Apricot, MemberClicks)
**Date**: 2026-04-11
**Audience**: Drives Phase 3 of feature plan + guides implementation priorities
**Multi-tenancy**: All features tenant-scoped — see `docs/saas-architecture.md`

---

## 1. Why these features

A typical chamber membership system is a **dumb database**: CRUD members,
create invoices, send emails. Commercial platforms like GlueUp, Wild
Apricot, MemberClicks charge $400-800/month for this.

Chamber-OS's **competitive moat** is being **smart**: the system actively
helps admins do their job, surfaces insights, prevents mistakes, and lets
members self-serve in ways other platforms don't.

These 6 features are the **differentiators** — each is genuinely useful
AND hard for competitors to copy quickly.

### Selection rationale

User chose **Balanced + Timeline** from 10 candidates:
- ✅ #1 Benefit Usage Dashboard
- ✅ #2 At-Risk Member Detection
- ✅ #3 Smart Renewal Reminders
- ✅ #4 Command Palette (Cmd+K)
- ✅ #7 Inline Editing + Bulk Actions
- ✅ #8 Timeline View per Member

Skipped (not in MVP):
- ❌ #5 Engagement Score (derived from #1 later)
- ❌ #6 Auto Tier Upgrade Suggestions (manual for now)
- ❌ #9 Directory E-Book Auto-Generation (tracked in F9)
- ❌ #10 Partnership Benefit Compliance Tracker (tracked in F9)

---

## 2. Feature #1 — Benefit Usage Dashboard

### Problem

Members pay for benefits (X E-Blasts per year, N cultural tickets, Y hyperlinked
banner weeks) and **chambers routinely forget to deliver them**. By mid-year,
nobody — not member, not admin — knows who's used how much of what.

This creates:
- Members feeling ripped off (pay for 6 E-Blasts, use 2, lose 4)
- Admin surprise at year-end ("wait, we owe them 4 more?")
- Disputes at renewal ("we didn't get our full benefits")
- Lost upsell opportunities ("you have 2 tickets left — want to use them on Event X?")

### Solution

**Live quota dashboard per member** showing consumption vs entitlement for
every quantifiable benefit, with warnings, projections, and deep-links.

### UX

**Per-member view** (`/admin/members/:id/benefits` and `/portal/benefits`):

```
┌───────────────────────────────────────────────────────┐
│ Benefits — Fogmaker International AB                  │
│ Plan: Premium Corporate · 2026                        │
│                                                       │
│ ┌─ Brand Visibility ───────────────────────────────┐ │
│ │                                                  │ │
│ │  📧 E-Blast Service         ▓▓▓░░░  2 / 6       │ │
│ │     Last used: 15 Mar 2026 "Product launch..."   │ │
│ │     Next available: now                          │ │
│ │     [Compose new E-Blast →]                      │ │
│ │                                                  │ │
│ │  📑 Directory Listing       ✓ 1 page + logo     │ │
│ │     Active since: 1 Jan 2026                     │ │
│ │                                                  │ │
│ │  🏠 Homepage Logo           ⏸ Not scheduled      │ │
│ │     [Schedule 12-week slot →]                    │ │
│ │                                                  │ │
│ └──────────────────────────────────────────────────┘ │
│                                                       │
│ ┌─ Events ─────────────────────────────────────────┐ │
│ │                                                  │ │
│ │  🎭 Cultural Tickets         ▓░░░  1 / 2        │ │
│ │     Used at: Midsummer 2026 (21 Jun)             │ │
│ │     Expires: 31 Dec 2026                         │ │
│ │                                                  │ │
│ │  🎟 Event Discount Rate     ∞ All employees     │ │
│ │     Last event: Tax Workshop (5 Apr)             │ │
│ │                                                  │ │
│ └──────────────────────────────────────────────────┘ │
│                                                       │
│ ⚠ At 62% of year consumed, this member has used     │
│   only 33% of their benefits.                         │
│   → [Send reminder] [Suggest usage]                   │
└───────────────────────────────────────────────────────┘
```

### Data model

Dashboard is a **computed view** — no new tables needed. Queries join:
- `members` (plan_id)
- `membership_plans` (benefit entitlements)
- `broadcasts` (e-blast consumption — F7)
- `event_registrations` (event ticket + cultural ticket consumption — F6)
- `directory_ads` (future — website/homepage logo scheduling)

Materialised view for performance:

```sql
CREATE MATERIALIZED VIEW benefit_usage_v AS
SELECT
  m.tenant_id,
  m.member_id,
  m.plan_id,
  EXTRACT(YEAR FROM NOW()) AS year,
  p.eblast_per_year AS eblast_quota,
  COALESCE(
    (SELECT COUNT(*) FROM broadcasts b
     WHERE b.tenant_id = m.tenant_id
       AND b.requested_by_member_id = m.member_id
       AND b.status = 'sent'
       AND b.quota_year_consumed = EXTRACT(YEAR FROM NOW())),
    0
  ) AS eblast_used,
  p.cultural_tickets_per_year AS cultural_quota,
  COALESCE(
    (SELECT COUNT(*) FROM event_registrations er
     JOIN events e ON (e.tenant_id = er.tenant_id AND e.event_id = er.event_id)
     WHERE er.tenant_id = m.tenant_id
       AND er.matched_member_id = m.member_id
       AND er.counted_against_cultural_quota = TRUE
       AND EXTRACT(YEAR FROM e.start_date) = EXTRACT(YEAR FROM NOW())),
    0
  ) AS cultural_used
FROM members m
JOIN membership_plans p
  ON (p.tenant_id = m.tenant_id AND p.plan_id = m.plan_id);

CREATE INDEX ON benefit_usage_v (tenant_id, member_id);

-- Refresh strategy: triggered by broadcast.sent + event_registration insert
-- OR nightly refresh as fallback
```

### Complexity: **Medium**

- Requires F2, F3, F6, F7 to be built first (dependent on their data)
- Materialised view + refresh trigger
- UI component with progress bars + deep-links
- Real-time updates via SWR or Server-Sent Events

### Phase assignment: **F9** (Admin Dashboard)

Built as part of F9 because it consumes data from F2/F3/F6/F7. Member-facing
view at `/portal/benefits` shares the same queries.

---

## 3. Feature #2 — At-Risk Member Detection

### Problem

Members churn silently. By the time admin notices "Fogmaker didn't renew",
the member already left. Would have loved a heads-up 3 months earlier.

Industry data: chamber churn averages **15-20% per year**. Reducing this by
even 5% via proactive outreach = **significant revenue impact**.

### Solution

**Rule-based scoring** (no ML) that flags members showing disengagement
patterns, 90-180 days before renewal. Admin sees a list sorted by risk.

### Rules

Computed weekly by a cron job:

```ts
// src/modules/members/application/detect-at-risk.ts

interface AtRiskFactors {
  // Event engagement
  eventsAttendedLast12Months: number;       // 0 = risk
  eventsAttendedLast3Months: number;        // 0 = higher risk

  // Benefit consumption
  eblastQuotaUsedPct: number;               // < 30% = risk
  culturalQuotaUsedPct: number;             // < 50% = risk

  // Financial
  invoicesOverduCount: number;              // > 0 = high risk
  daysSinceLastPayment: number;             // > 180 = risk

  // Contact freshness
  daysSinceLastContactUpdate: number;       // > 365 = risk (stale)

  // Tier movement
  tierDowngradedInLast12Months: boolean;    // yes = risk

  // Email engagement (optional, if we opt into open tracking)
  emailOpenRateLast6Months: number;         // < 20% = risk
}

// Risk score formula (0-100)
function calculateRiskScore(factors: AtRiskFactors): number {
  let score = 0;
  if (factors.eventsAttendedLast12Months === 0) score += 25;
  else if (factors.eventsAttendedLast3Months === 0) score += 10;
  if (factors.eblastQuotaUsedPct < 30) score += 15;
  if (factors.culturalQuotaUsedPct < 50) score += 10;
  if (factors.invoicesOverduCount > 0) score += 25;
  if (factors.daysSinceLastPayment > 180) score += 10;
  if (factors.daysSinceLastContactUpdate > 365) score += 5;
  if (factors.tierDowngradedInLast12Months) score += 15;
  return Math.min(100, score);
}

// Thresholds:
// 0-24  = healthy
// 25-49 = warning
// 50-74 = at-risk (proactive outreach)
// 75+   = critical (urgent call)
```

### UX

**Admin dashboard widget**:

```
┌────────────────────────────────────────┐
│ ⚠ At-Risk Members (7 this week)        │
│                                        │
│ 🔴 Fogmaker               Score: 82     │
│    No events in 6 months               │
│    1 invoice overdue                    │
│    [Contact] [Snooze]                   │
│                                        │
│ 🟠 System In Motion       Score: 68    │
│    Downgraded from Premium in Feb      │
│    Low E-Blast usage                    │
│    [Contact] [Snooze]                   │
│                                        │
│ 🟡 Thai Nordic Tech       Score: 45    │
│    No cultural ticket used              │
│    [Contact] [Snooze]                   │
│                                        │
│ [View all →]                            │
└────────────────────────────────────────┘
```

Clicking "Contact" opens an email template (from F7 infrastructure) with
context pre-filled: "Hi Jane, we noticed Fogmaker hasn't joined us at an
event recently. Our upcoming Midsummer Networking on 21 June would be a
great chance..."

### Data model

No new tables. Just a scheduled query + a column on members:

```ts
// Add to members table (F3 schema)
{
  // ... existing fields
  riskScore: integer('risk_score'),           // 0-100, nullable if never computed
  riskScoreLastComputedAt: timestamp('risk_score_last_computed_at'),
  riskSnoozedUntil: timestamp('risk_snoozed_until'),  // admin dismissed warning
}
```

A cron job runs weekly (`/api/cron/compute-risk-scores`):

```ts
// src/app/api/cron/compute-risk-scores/route.ts
export async function POST() {
  const tenants = await tenantRepo.findAll();
  for (const tenant of tenants) {
    const members = await memberRepo.findActiveByTenant(tenant.id);
    for (const member of members) {
      const factors = await collectFactors(tenant.id, member.member_id);
      const score = calculateRiskScore(factors);
      await memberRepo.updateRiskScore(tenant.id, member.member_id, score);
    }
  }
}
```

### Complexity: **Low-Medium**

- Pure SQL + simple JS math
- No ML, no external services
- Weekly cron (Vercel Cron)
- Requires F3 + F4 + F6 + F7 data

### Phase assignment: **F8** (Renewal Tracking + Reminders)

Natural home — it's an anti-churn feature that feeds into the renewal flow.

---

## 4. Feature #3 — Smart Renewal Reminders

### Problem

Generic renewal reminders ("Your membership expires in 30 days") get ignored.
Members of different tiers have different:
- Renewal cycles (some annual, some mid-year)
- Price points (1,000 THB alumni vs 200,000 THB Diamond)
- Decision-making complexity (individual signs → immediate; Diamond
  Partnership → committee review)

One-size-fits-all reminders feel spammy for small members and too casual
for big ones.

### Solution

**Tier-aware escalation**: different reminder schedules, channels, and
escalation paths based on the member's tier, risk score, and invoice
history.

### Schedule per tier

```
THAI ALUMNI / INDIVIDUAL (1,000-6,000 THB/year)
  T-30 days  Email (friendly reminder)
  T-14 days  Email (renewal link)
  T-3 days   Email (last chance)
  T+7 days   Email (grace period ending)

START-UP / REGULAR / LARGE (10,000-26,000 THB/year)
  T-60 days  Email (heads-up)
  T-30 days  Email + dashboard widget
  T-14 days  Email (invoice attached)
  T-7 days   Email (reminder + benefit summary)
  T+0        Email (due today)
  T+7 days   Email (grace) + admin notified

PREMIUM (36,000 THB/year)
  T-90 days  Email (heads-up)
  T-60 days  Email + phone call scheduled (if high-value)
  T-30 days  Email + benefit usage summary
  T-14 days  Email (invoice)
  T-7 days   Email + phone call (admin)
  T+0        Email
  T+14 days  Call from director

PARTNERSHIP (100,000-200,000 THB/year)
  T-120 days Quarterly review meeting scheduled
  T-90 days  Email + in-person meeting proposed
  T-60 days  Benefit fulfillment report sent
  T-30 days  Email (renewal contract attached)
  T-14 days  Phone call from Executive Director
  T+0        In-person meeting + signing
  T+30 days  Escalation to board if still outstanding
```

### UX

**Admin dashboard**:

```
┌─────────────────────────────────────────────────┐
│ Renewal Pipeline                                 │
│                                                  │
│ Next 30 days:                                   │
│   🔴 2 Partnership — action needed              │
│   🟠 8 Premium — follow-up                      │
│   🟡 23 Corporate — emails sent                  │
│   ⚪ 45 Individual/Alumni — auto                 │
│                                                  │
│ [View pipeline →]                                │
└─────────────────────────────────────────────────┘
```

**Per-member renewal timeline**:

Integrated with Feature #8 Timeline View (see § 7 below).

### Data model

```ts
// New table: renewal_schedules
export const renewalSchedules = pgTable(
  'renewal_schedules',
  {
    tenantId: text('tenant_id').notNull(),
    scheduleId: uuid('schedule_id').defaultRandom(),

    memberId: uuid('member_id').notNull(),
    expiryDate: date('expiry_date').notNull(),
    tierAtScheduleTime: text('tier_at_schedule_time').notNull(),

    // Planned events (populated at schedule creation)
    plannedReminders: jsonb('planned_reminders').notNull(),  // array of {offsetDays, channel, template}

    // Execution tracking
    executedSteps: jsonb('executed_steps'),  // array of {offsetDays, executedAt, outcome}

    status: text('status').notNull().default('active'),  // 'active' | 'completed' | 'cancelled'
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.scheduleId] }),
  }),
);
```

### Complexity: **Medium**

- Cron job (daily)
- Email templates per tier (uses F7 infrastructure for composition)
- Admin task list for non-email actions (phone calls, in-person)
- Tier mapping logic

### Phase assignment: **F8** (Renewal Tracking + Reminders)

---

## 5. Feature #4 — Command Palette (Cmd+K)

### Problem

Chamber admins work with hundreds of members, dozens of events, thousands
of invoices. **Finding anything is slow** — click Members, scroll, search,
click. Click Invoices, filter by member, scroll, click.

Enterprise tools like Linear, Notion, Raycast, VS Code solve this with
**Cmd+K command palettes** — a single keyboard shortcut that searches
everything and lets you execute any action instantly.

### Solution

`⌘K` (Mac) / `Ctrl+K` (Windows) opens a universal palette that:
- Searches members, contacts, invoices, events, plans by name/email/ID
- Suggests recent items (most recently viewed/edited)
- Executes actions ("New invoice", "Mark as paid", "Add contact to Fogmaker")
- Navigates ("Go to Dashboard", "Open Renewal Pipeline")

### UX sketch

```
User presses ⌘K anywhere in the app:

┌──────────────────────────────────────────────┐
│ 🔍 Type a command or search...         [Esc] │
├──────────────────────────────────────────────┤
│                                               │
│ Recent                                        │
│   ● Fogmaker International AB                 │
│   ● Invoice MB2026-042                        │
│   ● Jane Andersson (contact)                  │
│                                               │
│ Navigate                                      │
│   → Dashboard                                 │
│   → Members                                   │
│   → Invoices                                  │
│   → Events                                    │
│   → Settings                                  │
│                                               │
│ Actions                                       │
│   + New member                                │
│   + New invoice                               │
│   + Invite staff                              │
│                                               │
└──────────────────────────────────────────────┘

User types "fog":

┌──────────────────────────────────────────────┐
│ 🔍 fog                                 [Esc] │
├──────────────────────────────────────────────┤
│                                               │
│ Members (1)                                   │
│   ● Fogmaker International AB                 │
│     Premium Corporate · 2 contacts            │
│                                               │
│ Invoices (3)                                  │
│   📄 MB2026-042 — Fogmaker — ฿38,520 paid    │
│   📄 MB2025-030 — Fogmaker — ฿100,000 paid   │
│                                               │
│ Actions                                       │
│   + New invoice for Fogmaker                  │
│   ✉ Send E-Blast as Fogmaker                 │
│                                               │
└──────────────────────────────────────────────┘
```

### Keyboard shortcuts

- `⌘K` — open palette
- `↑` / `↓` — navigate results
- `Enter` — select
- `⌘+Enter` — open in new tab
- `Esc` — close

### Implementation

- **Library**: `cmdk` (by Shadcn/pacocoursey — already part of shadcn/ui ecosystem)
- **Search backend**: PostgreSQL full-text search (tsvector) on searchable fields,
  or Typesense if we need fuzzy matching at scale
- **Data sources**: members, contacts, invoices, events, plans — all tenant-scoped
- **Permission-aware**: member role sees only their own data; admin sees everything

### Data model

Optional search-index materialised view for speed:

```sql
CREATE MATERIALIZED VIEW search_index AS
SELECT
  tenant_id,
  'member' AS entity_type,
  member_id AS entity_id,
  company_name AS title,
  tax_id || ' ' || email_domain AS secondary,
  to_tsvector('simple', company_name || ' ' || COALESCE(email_domain, '') || ' ' || COALESCE(tax_id, '')) AS search_vector
FROM members
UNION ALL
SELECT
  tenant_id,
  'contact',
  contact_id,
  full_name,
  email,
  to_tsvector('simple', full_name || ' ' || email)
FROM contacts
UNION ALL
-- ... invoices, events, plans
;

CREATE INDEX search_idx_vec ON search_index USING GIN(search_vector);
CREATE INDEX search_idx_tenant ON search_index(tenant_id);
```

Refresh strategy: after each mutation via database triggers or application
hooks.

### Complexity: **Medium-High**

- Custom search ranking logic
- Full-text search indexing
- Cross-entity result merging
- Keyboard-first interaction (accessibility important)
- Permission filtering per role

### Phase assignment: **Cross-cutting**

Implemented as part of **F3** (first feature where multi-entity search makes sense)
and then extended with each subsequent feature. Starts small (members + contacts),
grows with F4 (invoices), F6 (events), F7 (broadcasts), etc.

---

## 6. Feature #7 — Inline Editing + Bulk Actions

### Problem

Chamber admins do lots of small updates: change a contact email, update a
member's tier, mark an invoice as paid. Traditional UX:
1. Click row → opens detail page
2. Click "Edit" → opens edit form
3. Modify → click "Save"
4. Navigate back → scroll to find your place

This is **4 clicks + 2 page loads** for a 30-second edit. Multiply by 20
updates per day = serious friction.

Modern tools (Linear, Airtable, Notion, Retool) solve this with:
- **Inline editing**: click a cell, edit, Tab to next cell, Esc to cancel
- **Bulk actions**: select 20 rows, one click, apply to all
- **Optimistic updates**: change appears instantly; roll back on error
- **Undo toast**: "Marked 3 invoices as paid. [Undo]"

### Solution

Every tabular list in the admin gets **inline edit + bulk select**:

### Inline edit UX

```
Members list:

┌──────────────────────────────────────────────────────┐
│ ☐ Company                 Tier        Status  ⋯      │
├──────────────────────────────────────────────────────┤
│ ☐ Fogmaker               [Premium ▼] Active  ⋯       │
│ ☐ ABB Thailand           [Large   ▼] Active  ⋯       │
│ ☐ System In Motion       [Regular ▼] Active  ⋯       │
│ ☐ Volvo Trucks          [Premium ▼] Active  ⋯        │
│ ☐ Ericsson              [Large   ▼] Active  ⋯        │
└──────────────────────────────────────────────────────┘

User clicks "Premium" cell on Fogmaker row:

┌──────────────────────────────────────────────────────┐
│ ☐ Fogmaker  ┌─────────────┐  Active  ⋯               │
│             │ Premium  ▼  │                          │
│             ├─────────────┤                          │
│             │ Diamond      │                          │
│             │ Platinum     │                          │
│             │ Gold         │                          │
│             │ ● Premium    │                          │
│             │ Large        │                          │
│             │ Regular      │                          │
│             │ Start-up     │                          │
│             └─────────────┘                          │
└──────────────────────────────────────────────────────┘

User selects "Diamond", Tab key moves to next cell. Change persists in DB
optimistically. Toast shows:

  ┌─────────────────────────────────────┐
  │ ✓ Fogmaker upgraded to Diamond      │
  │   [Undo]                             │
  └─────────────────────────────────────┘

If DB mutation fails (e.g., "Cannot demote last admin"), change reverts:

  ┌─────────────────────────────────────┐
  │ ✗ Could not change tier:            │
  │   "Fogmaker has 0 Diamond quota..."  │
  │   Reverting.                        │
  └─────────────────────────────────────┘
```

### Bulk actions UX

```
┌──────────────────────────────────────────────────────┐
│ ☑ 3 selected · [Mark paid] [Send reminder] [...]     │
├──────────────────────────────────────────────────────┤
│ ☑ Fogmaker               Premium    Unpaid   ⋯       │
│ ☑ ABB Thailand           Large      Unpaid   ⋯       │
│ ☑ System In Motion       Regular    Unpaid   ⋯       │
│ ☐ Volvo Trucks           Premium    Paid     ⋯       │
└──────────────────────────────────────────────────────┘

Click "Mark paid" → Confirmation dialog:

  ┌─────────────────────────────────────────┐
  │ Mark 3 invoices as paid?                │
  │                                         │
  │ • MB2026-042 (Fogmaker)       ฿38,520   │
  │ • MB2026-043 (ABB Thailand)   ฿27,820   │
  │ • MB2026-044 (System In M.)   ฿17,120   │
  │                                         │
  │ Total: ฿83,460                          │
  │                                         │
  │ Payment date: [Today ▼]                 │
  │ Payment method: [Bank transfer ▼]       │
  │                                         │
  │ [Cancel] [Mark 3 as paid]               │
  └─────────────────────────────────────────┘
```

### Destructive action undo

```
User selects 5 members, clicks "Disable".

  ┌─────────────────────────────────────────┐
  │ ⚠ Disabled 5 members.                    │
  │   Session for each was ended.           │
  │   [Undo] (available for 10 seconds)     │
  └─────────────────────────────────────────┘

Clicking Undo reverts all 5 in one transaction.
After 10s, undo expires and the change is permanent.
```

### Implementation

- **Table library**: TanStack Table v8 (headless, unstyled — pairs with shadcn)
- **Inline edit**: `useMutation` with optimistic updates (`queryClient.setQueryData`)
- **Bulk actions**: row selection state in Zustand or React Query cache
- **Undo**: time-delayed actual DB mutation OR forward mutation + reverse mutation
  in cache. I recommend "delayed mutation" — 10s timer before hitting DB, undo just
  cancels timer
- **Keyboard navigation**: Tab/Shift+Tab between cells, Enter to commit, Esc to cancel
- **Conflict handling**: if two admins edit the same cell simultaneously, last-write-wins
  with a toast "Your change was overwritten by Jane — [View diff]"

### Complexity: **High**

- Table component with inline edit is complex UI work (~40 tasks per view)
- Optimistic updates require careful state management
- Conflict detection (concurrent edits) is non-trivial
- Accessibility (keyboard navigation, screen reader) adds work

### Phase assignment: **Cross-cutting — starts with F3**

Built as reusable `<EditableTable>` component in F3, then used by F4 (invoices list),
F6 (events list), F7 (broadcasts list), F9 (dashboard tables).

---

## 7. Feature #8 — Timeline View per Member

### Problem

When admin opens a member profile, they need to understand the **full
relationship history**: when did they join? What tier changes? What events
did they attend? What invoices have been sent/paid? What communications?

Typical chamber systems show this as **separate tabs** (Events tab, Invoices
tab, Contacts tab). Admin has to click each to get a picture, and
chronological ordering across tabs is lost.

### Solution

**Chronological timeline** showing every event in the member's relationship,
like Stripe's customer timeline or GitHub's PR timeline.

### UX

```
┌────────────────────────────────────────────────────────┐
│ Fogmaker International AB                              │
│ Premium Corporate · Member since 4 Apr 2025            │
│                                                        │
│ [Overview] [Contacts] [Invoices] [Events] [Timeline]   │
│ ────────────────────────────────────────────────       │
│                                                        │
│ Apr 2026                                               │
│ ├─ 🔔 11 Apr  At-risk score dropped to 24 (healthy)   │
│ ├─ 📧 05 Apr  E-Blast sent — "Product launch Q2"       │
│ │              42 recipients · 38 opened · 12 clicked  │
│ └─ 🎫 02 Apr  Jane Andersson attended Tax Workshop    │
│                (cultural ticket 1/2 used)              │
│                                                        │
│ Mar 2026                                               │
│ ├─ 💰 15 Mar  Invoice MB2026-042 paid — ฿38,520       │
│ │              Payment method: PromptPay               │
│ ├─ 📄 01 Mar  Invoice MB2026-042 issued — ฿38,520     │
│ └─ ✉ 01 Mar  Renewal reminder sent (30-day)           │
│                                                        │
│ Feb 2026                                               │
│ ├─ 👤 15 Feb  Contact added: Lars Andersson            │
│ └─ ⚙ 01 Feb  Tier changed: Large → Premium            │
│                (upgrade after turnover review)         │
│                                                        │
│ Jan 2026                                               │
│ ├─ 🎭 21 Jan  Midsummer event ticket used              │
│ ├─ 📊 01 Jan  New year quotas reset                    │
│ └─ 📧 15 Jan  E-Blast sent — "Year-end report"         │
│                                                        │
│ [Load older events...]                                 │
└────────────────────────────────────────────────────────┘
```

### Data model

No new tables — timeline is a **union query** across existing tables:

```sql
-- Union of all events for a member, ordered chronologically
WITH member_timeline AS (
  -- Tier changes (from audit_log)
  SELECT tenant_id, member_id, timestamp,
         'tier_change' AS event_type,
         summary, event_id AS related_id
  FROM audit_log
  WHERE event_type = 'role_changed' AND target_user_id = $member_id

  UNION ALL

  -- Invoices
  SELECT tenant_id, member_id, invoice_date AS timestamp,
         'invoice_issued' AS event_type,
         'Invoice ' || invoice_no || ' — ฿' || total AS summary,
         invoice_id AS related_id
  FROM invoices WHERE tenant_id = $tenant_id AND member_id = $member_id

  UNION ALL

  -- Invoices paid
  SELECT tenant_id, member_id, payment_date AS timestamp,
         'invoice_paid', 'Invoice ' || invoice_no || ' paid', invoice_id
  FROM invoices WHERE payment_status = 'Paid'

  UNION ALL

  -- Event registrations
  SELECT er.tenant_id, er.matched_member_id, e.start_date,
         'event_attended', 'Attended ' || e.name, er.registration_id
  FROM event_registrations er
  JOIN events e ON (e.tenant_id = er.tenant_id AND e.event_id = er.event_id)

  UNION ALL

  -- Broadcasts sent
  SELECT tenant_id, requested_by_member_id, sent_at,
         'broadcast_sent', 'E-Blast: ' || subject, broadcast_id
  FROM broadcasts WHERE status = 'sent'

  UNION ALL

  -- Risk score events
  SELECT tenant_id, member_id, risk_score_last_computed_at,
         'risk_score_updated', 'Risk score: ' || risk_score, NULL
  FROM members WHERE risk_score IS NOT NULL
)
SELECT * FROM member_timeline
WHERE member_id = $member_id
ORDER BY timestamp DESC
LIMIT 50;
```

### Virtualization

For members with 1000+ events, the timeline uses **virtual scrolling**
(TanStack Virtual) to render only visible rows.

### Filtering

- By event type: events only, invoices only, comms only
- By date range: last 30 days, last year, custom
- By actor: events triggered by admin vs by member vs by system

### Complexity: **Medium**

- Union query is straightforward
- Virtual scrolling is a library
- Filter UI is standard
- Permission filtering (member sees own timeline; admin sees all)

### Phase assignment: **F9** (Admin Dashboard)

Naturally belongs in F9 where member profile pages live. Member-facing
timeline at `/portal/timeline` uses the same component with a different
permission scope.

---

## 8. Summary table

| # | Feature | Phase | Complexity | Data requirements | Competitive moat |
|---|---|---|---|---|---|
| 1 | Benefit Usage Dashboard | F9 | Medium | F2, F3, F6, F7 | ⭐⭐⭐ Major |
| 2 | At-Risk Member Detection | F8 | Low-Medium | F3, F4, F6, F7 | ⭐⭐⭐ Major |
| 3 | Smart Renewal Reminders | F8 | Medium | F2, F3, F4 | ⭐⭐ Medium |
| 4 | Command Palette (Cmd+K) | Cross-cutting (F3+) | Medium-High | Search index | ⭐⭐ Medium |
| 7 | Inline Editing + Bulk | Cross-cutting (F3+) | High | All lists | ⭐⭐⭐ Major |
| 8 | Timeline View | F9 | Medium | Union query | ⭐⭐ Medium |

---

## 9. Cross-tenant considerations

All 6 features are **tenant-scoped by construction**:

- Benefit Usage Dashboard: queries filter by `tenant_id`
- At-Risk Detection: cron iterates tenants, processes each independently
- Smart Renewal: schedules per member, never cross-tenant
- Command Palette: search index partitioned by `tenant_id`, results filtered
- Inline Editing + Bulk: mutations gated by tenant context in middleware
- Timeline: union query filtered by `tenant_id`

**No feature leaks data across tenants**, enforced by Postgres RLS + application
layer + tests.

---

## 10. Effort estimate

| Feature | Tasks | Days |
|---|---|---|
| #1 Benefit Usage Dashboard | 12 | 4 |
| #2 At-Risk Detection | 10 | 3 |
| #3 Smart Renewal Reminders | 15 | 5 |
| #4 Command Palette | 18 | 6 |
| #7 Inline Editing + Bulk | 30 | 10 |
| #8 Timeline View | 12 | 4 |

**Total**: ~97 tasks, ~32 days (solo dev) — distributed across phases F3 (start), F8, F9

---

## 11. Additional Expert UX Features (Phase 3+ enhancements)

The 6 features above form the **core smart chamber MVP**. Below are additional
expert-grade UX features that can be added incrementally after the MVP is
validated. Each one represents a "small thing, big impact" UX pattern that
competitors don't have.

### Feature #9 — Global Undo / Time Travel (10-30 second window)

**Problem**: Admin accidentally disables the wrong member. By the time they
realise, data has been lost + cascading effects happen (sessions ended,
invoices blocked).

**Solution**: Every destructive action has a **10-second undo window** via toast.
Beyond that, a **30-day time travel** via audit log restores the exact state.

```
[✓ Fogmaker disabled] · [Undo (9)] ←─ 10-second delayed execution

[✓ 3 invoices marked paid] · [Undo (8)]

...

Admin Settings → History → 15 Mar 2026 14:23
  "Disabled Fogmaker" — [Restore state from before]
```

**Implementation**: Delayed-execution pattern — mutation is queued for 10s, cancelled
on undo. For 30-day time travel, audit log has enough data to reconstruct any prior
state (restore via reverse operations).

**Phase**: Cross-cutting — starts with F3 (undo for disable/delete), extends through
F4/F7.

---

### Feature #10 — Natural Language Search

**Problem**: Admin wants to find "all Premium members who haven't attended any
event in 90 days". In SQL that's ~15 lines. In a typical CRM it's 5-10 filter
clicks. Neither is fast.

**Solution**: Type natural language in the command palette (`#4`), AI converts to
a filter:

```
⌘K → "premium members no events 90 days"

↓ AI interprets →

Filter applied:
  · plan = Premium
  · last event attended < 90 days ago
  · is_active = true

Results: 12 members
```

**Implementation**: Local LLM (e.g., Transformers.js) or Vercel AI Gateway →
GPT-4o-mini. Input → AI produces a structured filter JSON → Drizzle query →
results.

**Privacy**: Query is sent to LLM but no PII (just the structured intent). Results
come back via direct SQL (not from LLM).

**Phase**: Added to F3 Command Palette as enhancement (#4 becomes smarter).

---

### Feature #11 — Keyboard Shortcuts Reference (`?` key)

**Problem**: Power features (Cmd+K, inline edit, bulk actions, undo) are
invisible — admins don't know they exist.

**Solution**: Pressing `?` anywhere opens a modal with **all available shortcuts
for the current view**:

```
┌─────────────────────────────────────────┐
│ Keyboard Shortcuts — Members List       │
│                                         │
│ Navigation                              │
│   ⌘K        Command palette             │
│   ↑↓        Navigate rows               │
│   Enter     Open row detail             │
│   Esc       Close modal / clear filter  │
│                                         │
│ Editing                                 │
│   Click     Inline edit cell            │
│   Tab       Next cell                   │
│   Shift+Tab Previous cell               │
│   ⌘Z        Undo last change            │
│                                         │
│ Bulk                                    │
│   x         Toggle row selection        │
│   ⌘A        Select all                  │
│   ⌘⇧A       Clear selection             │
│   ⌘D        Disable selected            │
│                                         │
│ Help                                    │
│   ?         Show this dialog            │
│   ⌘/        Search documentation        │
└─────────────────────────────────────────┘
```

**Implementation**: Static per-view shortcut map + modal component. ~50 lines.

**Phase**: Cross-cutting — add when first keyboard shortcuts ship in F3.

---

### Feature #12 — Saved Filters / Segments

**Problem**: Admin builds complex filter ("Premium members in Bangkok with
invoices over 100k, sorted by last event") every day. Ten clicks each time.

**Solution**: After building a filter, click "Save as segment". Name it. Pin
it to the sidebar. One-click recall next time.

```
Sidebar → Saved Segments:
  · High-value Bangkok members (12)    ← click to recall
  · At-risk Gold partners (3)
  · New members this quarter (8)
  · Expired in last 30 days (15)
  + New segment...
```

**Implementation**: Store filter JSON in DB, per-user + per-tenant. SQL generation
already works for filters — just persist the config.

**Phase**: Enhancement to F3 (members list filter) extends to F4/F7/F9.

---

### Feature #13 — CSV / Excel Import (with dry-run preview)

**Problem**: New chamber onboards with 500 existing members in Excel. Manual
entry = 10 hours of data entry + transcription errors.

**Solution**: Drag-drop CSV/XLSX upload → column mapping UI → **dry-run preview**
(shows what would be created/updated without committing) → commit + detailed error report.

```
Upload members.xlsx

Column mapping:
  Excel "Company"        → Member.company_name
  Excel "Tier"           → Member.plan_id (auto-detect: Premium/Large/Regular...)
  Excel "Contact Email"  → Contact.email (creates primary contact)
  Excel "Tax ID"         → Member.tax_id
  Excel "Join Date"      → Member.joined_at (YYYY-MM-DD)

Dry run: Will create 487 members + 502 contacts.
         Will skip 13 rows with errors:
           Row 42: Invalid plan "VIP" (not in catalog)
           Row 57: Duplicate email "info@foo.com"
           ...

[Fix errors] [Commit import]
```

**Implementation**: Uses `xlsx` library for parsing. Transactional commit. Rollback on
any fatal error. Idempotency key per row.

**Phase**: Part of F3 onboarding tools (post-MVP enhancement).

---

### Feature #14 — Real-Time Updates (SSE / WebSocket)

**Problem**: Two admins editing the same member at the same time overwrite each
other. Or admin A disables member X while admin B is writing a note for them.

**Solution**: **Server-Sent Events** push live updates to all connected clients.
When admin A changes a cell, admin B's screen updates instantly (with a subtle
highlight animation).

```
Admin A: [Change tier] → Premium → Diamond

Admin B's screen (realtime):
  · Row "Fogmaker" tier updates: Premium → Diamond
  · Toast: "Jane updated Fogmaker's tier"
  · Highlight flash on the row (1.5s fade)
```

**Implementation**: SSE over HTTP/2 (Next.js supports it natively). Upstash Redis
pub/sub for fan-out across Vercel function instances. Per-tenant channels.

**Phase**: F9 polish enhancement — MVP ships without realtime; add when concurrent
editing becomes a real problem.

---

## 12. Additional Smart Intelligence Features

These are the **"the system is smarter than a dumb database"** features. They use
rule-based logic, not ML, to deliver insights.

### Feature #15 — Engagement Score (composite 0–100)

**Problem**: Admin wants a single number per member: "how healthy is this
relationship?"

**Solution**: Weighted composite:

```
Engagement Score (0–100)
  = 30 × event_attendance_factor       (more recent = higher)
  + 25 × benefit_usage_factor          (quota consumed %)
  + 20 × payment_health_factor         (no overdue)
  + 15 × contact_freshness_factor      (contacts updated recently)
  + 10 × communication_engagement      (e-blast opens, if opted in)
```

Displayed on member list + profile, sortable, filterable.

```
Members sorted by engagement:

  Fogmaker             ▓▓▓▓▓▓▓▓▓░  87   ← healthy
  ABB Thailand         ▓▓▓▓▓▓░░░░  58   ← moderate
  System In Motion     ▓▓▓░░░░░░░  31   ← warning
  Old Chamber Member   ▓░░░░░░░░░  12   ← critical
```

**Inverse of At-Risk Score** (#2) — same data, positive framing.

**Phase**: F9 (uses data from all earlier phases).

---

### Feature #16 — Auto Tier Upgrade Suggestions

**Problem**: A Regular member's turnover grew past 100M THB (per invoice data
from F4). They qualify for Premium. Nobody notices. Chamber misses revenue.

**Solution**: Weekly rule-based check:

```
FOR each Regular member:
  IF declared_turnover > 100_000_000 THB
     OR sum(invoices paid in last 12 months) > 80_000_000:
     → suggest upgrade to Premium or Large
     → notify admin in dashboard
     → optionally draft email to member: "Congratulations! Based on your
       growth, you now qualify for Premium tier benefits..."
```

Also works for:
- Start-up → Regular (when 2-year cap approaches)
- Thai Alumni → Individual (when age 35 approaches)
- Individual → Regular (when turnover grows)

**Phase**: F8 or F9 as rule engine.

---

### Feature #17 — Activity Feed / Live Notifications

**Problem**: Admin doesn't know what's happening. An E-Blast was submitted
for approval 2 days ago — nobody reviewed it because nobody knew.

**Solution**: Real-time activity feed in admin sidebar showing:

```
┌────────────────────────────────────┐
│ Recent activity                    │
│                                    │
│ 🔔 2 min ago                        │
│   Jane submitted E-Blast           │
│   "Product launch Q2" — review →  │
│                                    │
│ 🔔 15 min ago                       │
│   Fogmaker paid MB2026-042 ฿38,520 │
│                                    │
│ 🔔 1 hour ago                       │
│   Renewal reminder sent to 12      │
│   Premium members                  │
│                                    │
│ 🔔 3 hours ago                      │
│   New contact added: Lars A.       │
│   (Fogmaker)                       │
│                                    │
│ [View all →]                       │
└────────────────────────────────────┘
```

Plus **notification bell** with unread count, grouped by category:
- Action required (pending approvals, at-risk members)
- FYI (payments received, new registrations)
- Alerts (email bounces, failed webhooks)

**Implementation**: Reads from `audit_log` filtered by tenant + recent time
window. Live updates via SSE (Feature #14) or polling every 30s.

**Phase**: F9 dashboard.

---

### Feature #18 — Partnership Benefit Compliance Tracker

**Problem**: Diamond partner paid 200k for "VDO shown at all events (1.5 min)"
and "logo on all roll-ups" + "banner on website 12 months". Admin forgets to
deliver. Partner is furious at year-end.

**Solution**: Checklist per partner, per benefit, per event:

```
Diamond Partner — Fogmaker (2026)

Events delivered:
  ✓ Midsummer 2026        VDO shown ✓   Logo at roll-up ✓   Booth ✓
  ✓ Tax Workshop           VDO shown ✓   Logo at roll-up ✓   Booth ✓
  ⏳ Christmas Party       VDO shown ☐   Logo at roll-up ☐   Booth ☐   (scheduled)
  ...

Website deliverables:
  ✓ Banner, 12 months    Started 1 Jan 2026  Active until 31 Dec
  ⏳ Homepage logo slot    Q1 ✓  Q2 ✓  Q3 ☐  Q4 ☐
  ⏳ Newsletter promo      Jan ✓  Feb ✓  Mar ✓  Apr ☐...

E-Blasts delivered:
  Used 2 of 15  (13 remaining)

Compliance: 85% (3 items pending)
```

Admin ticks checkboxes as they deliver. System auto-flags overdue items 30
days before renewal.

**Phase**: F9 partner management.

---

### Feature #19 — Smart Suggestions / Proactive Alerts

**Problem**: System has data, but admin doesn't know what to do with it.
Data without insight = just another database.

**Solution**: Rule-based alerts surface insights:

```
💡 Insight: Platinum partner "ABB" has used 0 of 4 event tickets/event for
   last 3 events. Want to send them the upcoming event list?
   [Send] [Dismiss]

💡 Insight: 5 Regular members haven't used their E-Blast quota this year.
   Want to send a reminder "You have 1 E-Blast remaining"?
   [Send] [Dismiss]

💡 Insight: Members with tax IDs matching known Swedish companies but not
   on Premium tier — 3 potential upgrades (based on external BOI data).
   [Review] [Dismiss]

💡 Insight: Event "Tax Workshop" has 15 registered but the venue holds 20.
   Want to invite 5 at-risk members?
   [Send invites] [Dismiss]
```

**Implementation**: Catalog of ~20 rules that run daily, generate insights, store
in `dashboard_insights` table with dismissal state.

**Phase**: F9 dashboard — starts with 3-5 rules, grows over time.

---

### Feature #20 — Public Member Directory (searchable)

> **Scope note**: Tenants typically have their own public website / CMS.
> This feature is reframed as **"Directory data export API + optional
> embedded widget"** — we own the data, tenant's existing website pulls it.
> The PDF E-Book generator still lives in F9.

**Problem**: Chamber brochure has Directory E-Book (PDF, once a year). Modern
users want **searchable online directory** they can access any time.

**Solution**: Public-facing directory at `{tenant}.chamber-os.app/directory`:

```
Search: [sustainable technology]

Results (8 members):

┌───────────────────────────────────────────┐
│ Fogmaker International AB                 │
│ Premium Corporate                          │
│                                           │
│ Sustainable fire suppression technology    │
│ Industry: CleanTech                        │
│ Website: fogmaker.com                     │
│ Contact: sales@fogmaker.com               │
│                                           │
│ [View full profile →]                     │
└───────────────────────────────────────────┘
```

**Privacy**:
- Members **opt-in** (default hidden)
- Tiers choose visibility: "Premium+partners listed", "all listed", etc.
- Member can hide individual contact emails (reveal on click only)
- Contact form (no email exposed): visitor fills form, system emails member
- SEO meta tags per member (for Google indexing, if member wants)

**Phase**: F9 or F14 (post-SaaS launch).

---

### Feature #21 — GDPR Self-Service Data Export

**Problem**: GDPR Article 20 (right to data portability). Member asks "give me
all my data". Admin has to manually compile it. Error-prone, takes a day.

**Solution**: Member clicks "Export my data" in portal settings. System generates
a zip file in 60 seconds:

```
member-fogmaker-export-2026-04-11.zip
├── profile.json              (member record)
├── contacts.json             (all contacts)
├── invoices.csv              (invoice history)
├── invoices/
│   ├── MB2026-042.pdf        (full PDFs)
│   └── MB2025-030.pdf
├── events.csv                (attendance history)
├── broadcasts.csv            (e-blasts sent)
├── audit_log.ndjson          (relevant audit events)
├── README.md                 (what's in each file + import guide)
└── manifest.json             (integrity checksums)
```

Delivered via email link (signed, expires in 48h) or in-portal download.

**Phase**: F9 or earlier (privacy compliance).

---

## 13. Grand feature summary

| # | Feature | Category | Phase | Complexity | Moat |
|---|---|---|---|---|---|
| 1 | Benefit Usage Dashboard | Smart | F9 | Medium | ⭐⭐⭐ |
| 2 | At-Risk Detection | Smart | F8 | Low-Med | ⭐⭐⭐ |
| 3 | Smart Renewal Reminders | Smart | F8 | Medium | ⭐⭐ |
| 4 | Command Palette (⌘K) | UX | F3+ | Med-High | ⭐⭐ |
| 7 | Inline Editing + Bulk | UX | F3+ | High | ⭐⭐⭐ |
| 8 | Timeline View | UX/Smart | F9 | Medium | ⭐⭐ |
| **9** | Global Undo (10-30s) | UX | F3+ | Medium | ⭐⭐ |
| **10** | Natural Language Search | UX/Smart | F3+ | High | ⭐⭐⭐ |
| **11** | Keyboard Shortcuts (`?`) | UX | F3+ | Low | ⭐ |
| **12** | Saved Filters / Segments | UX | F3+ | Low-Med | ⭐⭐ |
| **13** | CSV / Excel Import | UX | F3+ | Medium | ⭐⭐ |
| **14** | Real-Time Updates (SSE) | UX | F9+ | Med-High | ⭐⭐ |
| **15** | Engagement Score | Smart | F9 | Low-Med | ⭐⭐ |
| **16** | Auto Tier Upgrade Suggestions | Smart | F8/F9 | Low | ⭐⭐⭐ |
| **17** | Activity Feed / Notifications | UX/Smart | F9 | Medium | ⭐⭐ |
| **18** | Partnership Compliance Tracker | Smart | F9 | Medium | ⭐⭐⭐ |
| **19** | Smart Suggestions / Proactive Alerts | Smart | F9+ | Medium | ⭐⭐⭐ |
| **20** | Public Member Directory | UX/Smart | F9/F14 | Medium | ⭐⭐ |
| **21** | GDPR Self-Service Data Export | UX/Privacy | F9 | Low | ⭐⭐ |

**Total**: **21 smart/UX features** (6 MVP + 15 enhancements)

---

## 14. Effort estimate (expanded)

| Phase | Features | Total tasks | Total days |
|---|---|---|---|
| **MVP (6 features)** | 1, 2, 3, 4, 7, 8 | ~97 tasks | ~32 days |
| **Phase 3a Expert UX (6 features)** | 9, 10, 11, 12, 13, 14 | ~85 tasks | ~28 days |
| **Phase 3b Smart Intelligence (6 features)** | 15, 16, 17, 18, 19, 21 | ~70 tasks | ~23 days |
| **Phase 3c Public features (1 feature)** | 20 | ~15 tasks | ~5 days |
| **Total** | **21 features** | **~267 tasks** | **~88 days** |

That's **~3-4 months of solo dev work** for the complete smart chamber vision on
top of F1-F9 core (which is another ~200 tasks = ~6-7 weeks).

**Pragmatic sequencing**:
1. **F1-F5 first** (revenue-critical)
2. **MVP 6 features** (differentiation)
3. **Phase 3a Expert UX** (power user)
4. **Phase 3b Smart Intelligence** (insights)
5. **Phase 3c Public features** (growth)

---

## 15. References

- [Membership Benefits Analysis](./membership-benefits-analysis.md) — data sources
- [Email Broadcast Analysis](./email-broadcast-analysis.md) — F7 for #1 dashboard
- [Event Integration Analysis](./event-integration-analysis.md) — F6 for #1 dashboard + #8 timeline
- [SaaS Architecture](./saas-architecture.md) — multi-tenancy
- [Phases Plan](./phases-plan.md) — full roadmap
- [UX Standards](./ux-standards.md) — keyboard, inline editing, bulk action patterns
