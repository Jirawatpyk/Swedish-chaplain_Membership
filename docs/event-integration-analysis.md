# Event Integration Analysis — F6 (EventCreate)

**Feature**: F6 — EventCreate Integration (rescoped, replaces old F6 Event Management + F7 Event Registration)
**Status**: Planned
**Priority**: P2 (post-MVP, after F2-F5 are shipped)
**Depends on**: F3 (members), F2 (plans — for event ticket quotas)
**Connects to**: Smart Feature #1 (benefit quota), #8 (timeline view)
**Multi-tenancy**: Full — per-tenant Zapier + webhook credentials

---

## 1. Why rescoped

### Original plan (old F6 + F7)
Build full event management — CRUD events, calendar, venues, partners,
sponsors, capacity, pricing, attendee registration, ticket types, check-in,
attendance tracking.

### New reality
SweCham already uses **EventCreate (https://eventcreate.com)** as their
external event management SaaS. They:
1. Create events in EventCreate (landing pages, ticketing, registration)
2. Members register via EventCreate's public pages
3. Admin exports attendee data to Excel after each event
4. Excel data is copy-pasted into their internal records

**Building our own event system duplicates EventCreate's functionality** —
it is classic over-engineering. The right move is to **import event data
from EventCreate** into our member-centric system for benefit tracking and
reporting.

---

## 2. EventCreate capability research (2026-04-11)

Researched via WebSearch + WebFetch on EventCreate.com and zapier.com.

### What EventCreate offers ✅

- Event creation UI (landing pages, branding, multi-language)
- Ticketing + payment processing
- Attendee registration forms
- Check-in app
- **Zapier integration** — only automation path:
  - Trigger: `New Attendees Registered` (event.attendee.created)
  - Trigger: `New Purchase Complete` (event.purchase.completed)
  - Polling: every 15 min on Zapier free tier, faster on paid
- Pre-built integrations with 8000+ apps via Zapier
- **SOC 2 + GDPR compliant**

### What EventCreate does NOT offer ❌

- ❌ **No public REST/GraphQL API** — no direct developer access
- ❌ **No native webhooks** for developers (only Zapier-mediated)
- ❌ **No public developer documentation**
- ❌ **No bulk historical export endpoint** (admin CSV export only)
- ❌ **No action endpoints** — EventCreate is a trigger source only, not a
  destination for incoming webhooks

### Implication

The only path to programmatic integration is **through Zapier**. This is
actually fine — Zapier is a reliable middleware with HTTPS webhook actions.

---

## 3. Architecture — Zapier-driven Webhook

```
┌─────────────────────┐
│  EventCreate        │  (SaaS — tenant's own account)
│                     │
│  - Event landing    │
│  - Registration     │
│  - Ticketing        │
│  - Check-in         │
└──────────┬──────────┘
           │ Zapier polls every 15 min
           │ (tenant's trigger event)
           ▼
┌─────────────────────┐
│  Zapier             │  (tenant owns their Zap account + workflow)
│                     │
│  Trigger:           │
│    New Attendee     │
│    New Purchase     │
│                     │
│  Action:            │
│    Webhook POST     │
│      → our endpoint │
└──────────┬──────────┘
           │ HTTPS POST with shared secret
           │ (per-tenant URL + secret)
           ▼
┌────────────────────────────────────────────────────┐
│  SweCham / Chamber-OS System                       │
│                                                    │
│  POST /api/webhooks/eventcreate/:tenant            │
│                                                    │
│  - Verify shared secret header                     │
│  - Parse zod-validated payload                     │
│  - Match attendee email → members table            │
│  - Insert event row if not exists                  │
│  - Insert event_registration row                   │
│  - Update benefit quota counter                    │
│  - Emit audit event                                │
│  - Return 200 OK                                   │
└────────────────────────────────────────────────────┘
```

### Trade-offs accepted

- **15-min delay** — acceptable for chamber events (not real-time critical)
- **Zapier as dependency** — if Zapier is down, events queue and retry;
  short outages are invisible
- **Per-tenant Zap setup** — one-time work when a new chamber onboards
- **Zapier pricing** — free tier handles <100 events/month; most chambers
  fit; paid tier ($20/mo) for heavier use

---

## 4. Webhook contract

### Request

```http
POST /api/webhooks/eventcreate/swecham
Host: swecham.chamber-os.app
Content-Type: application/json
X-Chamber-Signature: sha256=<hex>         ; HMAC of body with shared secret
X-Chamber-Timestamp: 1712844000           ; request timestamp (replay protection)
X-Request-ID: 01ARZ3NDEKTSV4RRFFQ69G5FAV  ; idempotency key from Zapier

{
  "eventType": "attendee.registered",
  "tenantSlug": "swecham",
  "event": {
    "externalId": "event_abc123",          ; EventCreate event ID
    "name": "SweCham Midsummer Celebration 2026",
    "startDate": "2026-06-21T18:00:00+07:00",
    "endDate": "2026-06-21T22:00:00+07:00",
    "location": "Anantara Riverside, Bangkok",
    "category": "networking",               ; or 'cultural', 'workshop', ...
    "isMemberDiscounted": true,
    "isPartnerBooth": false,
    "eventCreateUrl": "https://events.swecham.com/midsummer-2026"
  },
  "attendee": {
    "externalId": "att_xyz789",             ; EventCreate attendee ID
    "email": "jane@fogmaker.com",
    "fullName": "Jane Andersson",
    "companyName": "Fogmaker International AB",
    "ticketType": "Member — Free",          ; EventCreate ticket tier
    "ticketPricePaid": 0,
    "paymentStatus": "paid",                ; or 'pending', 'refunded'
    "registeredAt": "2026-06-01T10:23:15Z",
    "metadata": {
      "dietary": "vegetarian",
      "company": "Fogmaker"
    }
  }
}
```

### Response

**Success (200)**:

```json
{
  "ok": true,
  "matched": "member",                      ; 'member' | 'contact' | 'non-member'
  "matchedMemberId": "01H...",
  "eventCreated": true,                     ; did we create a new event row?
  "registrationId": "01H..."
}
```

**Signature failure (401)**:

```json
{
  "type": "https://chamber-os.app/errors/invalid-signature",
  "title": "Signature verification failed",
  "status": 401,
  "detail": "HMAC did not match request body."
}
```

**Replay (409)**:

```json
{
  "type": "https://chamber-os.app/errors/duplicate-event",
  "title": "Duplicate webhook delivery",
  "status": 409,
  "detail": "Request ID 01ARZ3NDEKTSV4RRFFQ69G5FAV was already processed."
}
```

### Signature scheme

```
message = `${timestamp}.${body}`
signature = hmac_sha256(tenant_webhook_secret, message)
header = `sha256=${hex_signature}`
```

Same pattern as Stripe, Slack, GitHub webhooks. Tested with `tests/contract/eventcreate-webhook.test.ts`.

### Replay protection

- `X-Request-ID` is an idempotency key (UUID from Zapier)
- Our handler stores request IDs in a short-lived cache (Upstash Redis, 7-day TTL)
- Duplicate request → 409 Conflict (no side effects)
- Timestamp skew check: reject if `abs(now - timestamp) > 300 seconds`

---

## 5. Data model

```ts
// src/modules/events/infrastructure/db/schema.ts (F6)

// Events table — imported from EventCreate
export const events = pgTable(
  'events',
  {
    tenantId: text('tenant_id').notNull(),
    eventId: uuid('event_id').defaultRandom(),

    // Source identity
    externalId: text('external_id').notNull(),  // EventCreate event ID
    source: text('source').notNull().default('eventcreate'),  // future: other sources

    // Event details (from EventCreate)
    name: text('name').notNull(),
    description: text('description'),
    startDate: timestamp('start_date', { withTimezone: true }).notNull(),
    endDate: timestamp('end_date', { withTimezone: true }),
    location: text('location'),
    category: text('category'),               // 'networking', 'cultural', 'workshop', 'conference'
    eventCreateUrl: text('eventcreate_url'),  // deep link back to EventCreate landing

    // Partnership benefit flags (for quota tracking)
    isPartnerBenefit: boolean('is_partner_benefit').notNull().default(false),
                                              // counts toward Partnership event-tickets-included benefit
    isCulturalEvent: boolean('is_cultural_event').notNull().default(false),
                                              // counts toward cultural_tickets_per_year quota

    // Metadata
    importedAt: timestamp('imported_at').notNull().defaultNow(),
    lastUpdatedAt: timestamp('last_updated_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.eventId] }),
    externalIdxx: uniqueIndex('events_tenant_external_unique').on(
      table.tenantId,
      table.source,
      table.externalId,
    ),
    startDateIdx: index('events_tenant_start_idx').on(table.tenantId, table.startDate),
  }),
);

// Event registrations — one row per attendee per event
export const eventRegistrations = pgTable(
  'event_registrations',
  {
    tenantId: text('tenant_id').notNull(),
    registrationId: uuid('registration_id').defaultRandom(),

    eventId: uuid('event_id').notNull(),

    // Attendee identity
    externalId: text('external_id').notNull(),  // EventCreate attendee ID (idempotency)
    attendeeEmail: text('attendee_email').notNull(),
    attendeeName: text('attendee_name').notNull(),
    attendeeCompany: text('attendee_company'),

    // Match resolution
    matchType: text('match_type').notNull(),  // 'member_contact' | 'member_domain' | 'non_member' | 'unmatched'
    matchedMemberId: uuid('matched_member_id'),  // nullable
    matchedContactId: uuid('matched_contact_id'),  // nullable

    // Ticket info
    ticketType: text('ticket_type'),           // EventCreate ticket name
    ticketPriceThb: integer('ticket_price_thb'),  // 0 for free/comp
    paymentStatus: text('payment_status'),     // 'paid' | 'pending' | 'refunded' | 'free'

    // Partnership quota accounting
    countedAgainstPartnership: boolean('counted_against_partnership').default(false),
    countedAgainstCulturalQuota: boolean('counted_against_cultural_quota').default(false),

    // Timestamps
    registeredAt: timestamp('registered_at').notNull(),
    importedAt: timestamp('imported_at').notNull().defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.registrationId] }),
    uniqueIdx: uniqueIndex('event_reg_tenant_event_external_unique').on(
      table.tenantId,
      table.eventId,
      table.externalId,
    ),
    eventIdx: index('event_reg_event_idx').on(table.tenantId, table.eventId),
    memberIdx: index('event_reg_member_idx').on(table.tenantId, table.matchedMemberId),
  }),
);

// Tenant webhook config — each tenant has own EventCreate credentials
export const tenantWebhookConfigs = pgTable(
  'tenant_webhook_configs',
  {
    tenantId: text('tenant_id').notNull(),
    source: text('source').notNull(),           // 'eventcreate', 'mailchimp', ...
    webhookSecret: text('webhook_secret').notNull(),  // HMAC shared secret (rotatable)
    enabled: boolean('enabled').notNull().default(true),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    rotatedAt: timestamp('rotated_at'),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.tenantId, table.source] }),
  }),
);
```

---

## 6. Attendee → Member matching algorithm

When an attendee registration webhook arrives, we need to link the attendee
to an existing member company (for benefit quota tracking).

### Matching rules (tried in order)

1. **Exact contact email match**
   - `SELECT * FROM contacts WHERE tenant_id = ? AND LOWER(email) = LOWER(?)`
   - If found → attendee's member = contact's parent member
   - Set `match_type = 'member_contact'`

2. **Email domain match** (fallback if no contact email match)
   - Extract domain from email (e.g., `fogmaker.com`)
   - `SELECT * FROM members WHERE tenant_id = ? AND email_domain = ?`
   - If unique match → use that member
   - If multiple matches → flag for admin review (`match_type = 'ambiguous'`)

3. **Company name fuzzy match** (if domain empty/gmail)
   - Normalise company name (strip "Co., Ltd.", "Pte", "AB", etc.)
   - Levenshtein distance < 3 against all tenant members
   - If unique match → use with low confidence flag
   - If multiple → ambiguous

4. **No match** → `match_type = 'non_member'`
   - Row still inserted (for full attendee records)
   - Does NOT count against any benefit quota
   - Admin can manually link later

### Edge cases

- **Personal email (gmail.com, yahoo.com)** — domain match is not reliable;
  fall back to rule 3 or manual
- **Same person, multiple member companies** — uses rule 1 (contact email)
  to resolve to the correct parent member
- **Newly registered member not yet in system** — `match_type = 'unmatched'`,
  admin notified, manual link later
- **EventCreate attendee registered under wrong company** — admin can
  re-link via `POST /api/admin/event-registrations/:id/relink`

---

## 7. Quota accounting on attendance

### Partnership event tickets

Partnership tiers (Diamond 6, Platinum 4, Gold 2 per event) include
complimentary event tickets. When a registration arrives:

```
IF event.is_partner_benefit = true
   AND attendee matches a Partnership member
   AND partnership has remaining ticket quota for this event:
   → counted_against_partnership = true
   → decrement partnership quota for this event
ELSE:
   → counted_against_partnership = false
   → partnership quota not touched
```

Quota is **per-event, not per-year** for Partnership. Diamond gets 6 tickets
per event × unlimited events per year (limited by Partnership tier itself).

### Cultural event tickets

Corporate tiers (Premium 2/year, Large 1/year) get cultural event tickets
as an annual quota.

```
IF event.is_cultural_event = true
   AND attendee matches a Corporate member (Premium or Large)
   AND member has remaining cultural quota for this year:
   → counted_against_cultural_quota = true
   → decrement member's cultural quota
ELSE:
   → counted_against_cultural_quota = false
```

Quota reset: 1 January each year.

### Member discount rate (base benefit)

All Corporate + Partnership members get "member rate" on all events.
EventCreate handles pricing at registration time — we just record the
price paid. If price_paid < ticket_full_price, it's the member discount
in action.

No quota to track here — it's unlimited.

---

## 8. Admin UI

### Events list page (`/admin/events`)

- Table: Date | Name | Category | Registrations | Partner benefit? | Match rate
- Sort by date descending
- Click event → detail page

### Event detail page (`/admin/events/:id`)

- Event metadata (imported from EventCreate, read-only)
- Registration list (paginated, searchable)
- Match rate indicator: "95% matched to members (1 unmatched)"
- Action: "Relink unmatched registrations"
- Deep link to EventCreate landing page

### Webhook config page (`/admin/integrations/eventcreate`)

- Shows current webhook URL: `https://{tenant}.chamber-os.app/api/webhooks/eventcreate/{tenant}`
- Shared secret (masked, copy button, rotate button)
- Last received webhook timestamp
- Last 10 webhook events (audit trail)
- "How to set up Zapier" documentation (embedded)
- Test webhook button (sends fake payload to verify round-trip)

---

## 9. Tenant onboarding — Zap setup

When a new chamber signs up for the SaaS:

1. Chamber's admin signs up at `{slug}.chamber-os.app/admin`
2. Admin navigates to **Integrations** → **EventCreate**
3. System generates a fresh `webhook_secret` for this tenant
4. Admin is shown:
   - Their tenant-specific webhook URL
   - Their webhook secret (one-time reveal, store in password manager)
   - Step-by-step Zapier wizard:
     1. Connect EventCreate account in Zapier
     2. Create a new Zap
     3. Trigger: EventCreate → "New Attendees Registered"
     4. Action: Webhooks by Zapier → "POST"
     5. URL: paste tenant webhook URL
     6. Headers: paste X-Chamber-Signature + timestamp (with Zapier's formatter)
     7. Body: attendee + event fields from step 1
     8. Test + publish
5. Admin clicks "Test webhook" to verify round-trip works
6. System records "last received" timestamp → green check mark

Total setup time: **10-15 minutes** per tenant.

---

## 10. Fallback: Manual CSV upload

If Zapier is down, if EventCreate temporarily breaks, or for historical
backfill (events before F6 shipped), admins can upload a CSV:

### UX

`/admin/events/import` page:

1. Upload CSV (drag-drop)
2. System shows preview of first 10 rows + column mapping
3. Admin maps columns: External ID, Name, Start Date, Attendee Email, ...
4. Click "Import"
5. Background job processes rows, same match logic as webhook
6. Progress bar + error report
7. Result: "X events imported, Y registrations matched, Z unmatched"

### CSV format

```csv
event_external_id,event_name,event_start,event_category,attendee_email,attendee_name,ticket_type
event_001,Midsummer 2026,2026-06-21T18:00+07:00,cultural,jane@fogmaker.com,Jane Andersson,Member Free
event_001,Midsummer 2026,2026-06-21T18:00+07:00,cultural,lars@abb.com,Lars Larsson,Non-Member
```

Same match logic as webhook — admin can re-run match if new members are
added later.

---

## 11. Security

- **Shared secret per tenant** — stored in tenant_webhook_configs
- **HMAC signature verification** — SHA-256, timing-safe comparison
- **Replay protection** — idempotency key + timestamp skew check
- **Rate limiting** — 60 requests per minute per tenant (Upstash)
- **Audit log** — every webhook receipt logged with outcome
- **Tenant isolation** — webhook URL path includes `{tenant}`; handler
  verifies tenant context matches
- **Secret rotation** — admin can rotate anytime; old secret valid 24h grace

---

## 12. Out of scope for F6

Explicitly NOT building:

- ❌ Event creation / CRUD (EventCreate does this)
- ❌ Landing pages (EventCreate)
- ❌ Ticketing / payment processing (EventCreate + F5)
- ❌ Check-in app (EventCreate)
- ❌ Seat maps / reserved seating (EventCreate if they support)
- ❌ Email invites to members (EventCreate or F7)
- ❌ QR code scanning (EventCreate)
- ❌ Calendar sync (ICS) — future nice-to-have
- ❌ Multi-language event pages (EventCreate)

We are **only importing event outcomes** into our member-centric system.

---

## 13. Estimated effort

| Phase | Tasks | Time |
|---|---|---|
| F6.0 Setup & schema | 4 tasks | 1 day |
| F6.1 Webhook endpoint + HMAC | 6 tasks | 2 days |
| F6.2 Attendee matching logic | 8 tasks | 3 days |
| F6.3 Quota accounting | 6 tasks | 2 days |
| F6.4 Admin UI (events list + detail) | 8 tasks | 3 days |
| F6.5 Tenant webhook config + onboarding | 5 tasks | 2 days |
| F6.6 CSV fallback import | 6 tasks | 2 days |
| F6.7 Tests (unit + integration + E2E) | 10 tasks | 3 days |
| F6.8 Localisation | 3 tasks | 1 day |

**Total**: ~56 tasks, ~19 days (solo dev)

---

## 14. Priority & sequencing

**F6 lands in Phase 2** (after F5 Payment, alongside F8 Renewal):

```
P0 MVP:        F1 ✓ → F2 → F3 → F4
P1 Revenue:    F5
P1 Value:      F7 (E-Blast)
P1 Retention:  F8 (Renewal)
P2 Integration:F6 (EventCreate) ⭐
P2 Reporting:  F9
```

Rationale for P2:
- F6 is **read-only import** — no revenue risk if delayed
- F6 depends on F3 (members exist to match against)
- F6 benefit tracking depends on F2 (plans with quota fields)
- Until members + plans + invoicing work, event imports have no home

---

## 15. References

- [EventCreate homepage](https://www.eventcreate.com/)
- [EventCreate integrations page](https://www.eventcreate.com/features/integrations)
- [EventCreate on Zapier](https://zapier.com/apps/eventcreate/integrations)
- [Zapier EventCreate triggers](https://zapier.com/apps/eventcreate/integrations#triggers)
- [Membership Benefits Analysis](./membership-benefits-analysis.md) — quota per tier
- [SaaS Architecture](./saas-architecture.md) — multi-tenancy
- [Smart Chamber Features](./smart-chamber-features.md) — #1 dashboard, #8 timeline
