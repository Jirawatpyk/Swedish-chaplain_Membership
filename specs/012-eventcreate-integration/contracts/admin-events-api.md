# Contract: Admin Events API

**Route prefix**: `/api/admin/events/**`
**Runtime**: Node.js (Drizzle pool access)
**Auth**: F1 session cookie — `admin` or `manager` role per FR-035
**FR refs**: FR-014, FR-019, FR-019a, FR-020, FR-021, FR-026..FR-029, FR-032a, FR-035

All endpoints scope to the resolved tenant via `runInTenant(ctx, fn)`. RBAC enforced per FR-035 — manager-read on list/detail, admin-only on mutations. Cross-tenant probes return 401 + `cross_tenant_probe` audit. Role violations return 403 + `role_violation_blocked` audit (manager attempts mutation) or 404 (member attempts any admin route — surface disclosure prevention).

---

## GET /api/admin/events

**FR**: FR-020 · **Role**: admin OR manager (read)

List imported events for the current tenant, sorted by `start_date` desc (default).

### Query params

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `page` | int ≥ 1 | 1 |  |
| `pageSize` | int 10..100 | 25 |  |
| `includeArchived` | boolean | false | When true, includes archived rows |
| `categoryFilter` | string | (none) | Exact match on `events.category` |
| `partnerBenefitOnly` | boolean | false |  |
| `culturalEventOnly` | boolean | false |  |

### 200 OK

```jsonc
{
  "items": [
    {
      "eventId": "01H...",
      "name": "SweCham Midsummer 2026",
      "startDate": "2026-06-21T18:00:00+07:00",
      "category": "networking",
      "totalRegistrations": 47,
      "matchedRegistrations": 44,
      "matchRatePct": 93.6,
      "isPartnerBenefit": true,
      "isCulturalEvent": false,
      "archivedAt": null,
      "eventcreateUrl": "https://events.swecham.com/midsummer-2026"
    }
  ],
  "pagination": { "page": 1, "pageSize": 25, "totalCount": 142 },
  "emptyStateContext": {
    "integrationConfigured": true,           // false = render "Set up EventCreate integration" CTA (US2 AS5 variant a)
    "everReceivedDelivery": true,             // false + integrationConfigured=true = render "Waiting for first event..." (variant b)
    "totalArchived": 5                        // > 0 + items.length === 0 = render "All events archived" (variant c)
  }
}
```

The `emptyStateContext` payload is always returned (even when `items.length > 0`) so the UI can render context-appropriate empty-state when paginated views land on an empty page. The 3-variant decision tree is implementation-side per US2 AS5.

---

## GET /api/admin/events/{eventId}

**FR**: FR-021 · **Role**: admin OR manager (read)

Event detail with paginated attendee table.

### Query params

| Param | Type | Default | Notes |
|-------|------|---------|-------|
| `page` | int ≥ 1 | 1 |  |
| `pageSize` | int 10..200 | 50 |  |
| `matchTypeFilter` | enum | (none) | `member_contact` / `member_domain` / `member_fuzzy` / `non_member` / `unmatched` |
| `unmatchedOnly` | boolean | false | Shortcut for `matchTypeFilter IN ('unmatched','non_member')` — wired to the "Show unmatched only" toolbar button (US2 AS4 / P4). When true, rows are sorted to put `unmatched` first (admin reviews ambiguous ones before non-members). |
| `q` | string | (none) | Substring search on attendee_email_lower / attendee_name |

### 200 OK

```jsonc
{
  "event": {
    // Same shape as the list item plus `lastUpdatedAt` — the detail
    // surface renders a "Last imported from EventCreate at …" trust
    // signal so the admin can verify the integration is still live
    // without leaving the page (added by U5 round-1 2026-05-12).
    // R012 (staff-review fix 2026-05-13): example previously inlined
    // `/* same shape as list item */` and omitted the new field.
    "eventId": "01H...",
    "name": "SweCham Midsummer 2026",
    "startDate": "2026-06-21T18:00:00+07:00",
    "category": "networking",
    "totalRegistrations": 47,
    "matchedRegistrations": 44,
    "matchRatePct": 93.6,
    "isPartnerBenefit": true,
    "isCulturalEvent": false,
    "archivedAt": null,
    "eventcreateUrl": "https://events.swecham.com/midsummer-2026",
    "lastUpdatedAt": "2026-06-15T03:21:00Z"
  },
  "registrations": [
    {
      "registrationId": "01H...",
      "attendeeEmail": "jane@fogmaker.com",
      "attendeeName": "Jane Andersson",
      "attendeeCompany": "Fogmaker International AB",
      "matchType": "member_contact",
      "matchedMemberId": "01H...",
      "matchedContactId": "01H...",
      "ticketType": "Member — Free",
      "ticketPriceThb": 0,
      "paymentStatus": "paid",
      "countedAgainstPartnership": false,
      "countedAgainstCulturalQuota": true,
      "isOverQuota": false,
      "registeredAt": "2026-06-01T10:23:15Z"
    }
  ],
  "pagination": { "page": 1, "pageSize": 50, "totalCount": 47 }
}
```

### 404 Not Found

Event does not exist OR exists for a different tenant.

---

## POST /api/admin/events/{eventId}/archive

**FR**: FR-019a · **Role**: admin only

Archive the event. Reverses all `counted_against_*` flags on its registrations and credits back the corresponding quotas. Audit `event_archived` + N × `quota_credit_back_archive`. Idempotent (no-op if already archived).

### 200 OK

```jsonc
{
  "ok": true,
  "archivedAt": "2026-05-12T08:42:00Z",
  "quotaReversals": {
    "partnership": 6,
    "cultural": 0
  }
}
```

### 403 Forbidden — `role_violation_blocked`

If actor is `manager`.

---

## POST /api/admin/events/{eventId}/toggle-partner-benefit

**FR**: FR-019 · **Role**: admin only · **Body**: `{ "isPartnerBenefit": boolean }`

Re-evaluates all registrations' partnership quota. Audit `event_partner_benefit_toggled` + N × `quota_*_decremented` or `quota_credit_back_*`.

---

## POST /api/admin/events/{eventId}/toggle-cultural-event

**FR**: FR-019 · **Role**: admin only · **Body**: `{ "isCulturalEvent": boolean }`

Same as above for cultural quota.

---

## POST /api/admin/events/{eventId}/registrations/{registrationId}/relink

**FR**: FR-014 · **Role**: admin only · **Body**: `{ "matchedMemberId": "01H..." | null }`

Relink a registration. If linking to a new member: credit back old member's quota (if `counted_against_*`), re-evaluate new member's quota effect, persist new flags. Audit `registration_relinked` + quota credit-back + new quota decrement.

### 200 OK

```jsonc
{
  "ok": true,
  "registrationId": "01H...",
  "newMatchType": "member_contact",
  "newMatchedMemberId": "01H...",
  "quotaEffect": {
    "countedAgainstPartnership": true,
    "countedAgainstCulturalQuota": false
  }
}
```

---

## POST /api/admin/events/{eventId}/registrations/{registrationId}/erase

**FR**: FR-032a · **Role**: admin only · **Body**: `{ "reason": "string" }`

Deletes the registration row, reverses any quota counted against the matched member, and emits `pii_erasure_requested` + `pii_erasure_completed` + `quota_credit_back_*`. Idempotent on re-invocation.

### 200 OK

```jsonc
{
  "ok": true,
  "erased": { "registrationId": "01H...", "quotaReversals": { "partnership": 1, "cultural": 0 } }
}
```

---

## POST /api/admin/events/import

**FR**: FR-026, FR-027, FR-028, FR-029 · **Role**: admin only · **Content-Type**: `multipart/form-data`

CSV upload + immediate processing. File field name `csv`; max 5 MiB.

### 200 OK

```jsonc
{
  "ok": true,
  "summary": {
    "rowsProcessed": 1000,
    "rowsAlreadyImported": 0,                  // rows that hit eventcreate_idempotency_receipts ON CONFLICT (duplicate of an earlier import within 7d) — distinguishes the "happy-path repeat upload" from "0 actually delivered"
    "eventsCreated": 8,
    "eventsUpdated": 4,
    "registrationsMatched": {
      "member_contact": 612,
      "member_domain": 188,
      "member_fuzzy": 140,
      "non_member": 32,
      "unmatched": 4
    },
    "errorRows": [
      { "row": 47, "reason": "Invalid email: not-an-email@" },
      { "row": 312, "reason": "Missing required column: attendee_email" }
    ],
    "durationMs": 38421
  }
}
```

### 413 Payload Too Large

File > 5 MiB.

### 429 Too Many Requests

5 imports/hour per `(tenant_id, actor_user_id)` exceeded.

---

## Audit emissions (admin route summary)

| Route | Audit events |
|-------|--------------|
| GET list / detail | (none — reads don't audit; per F4/F5/F7/F8 convention) |
| Archive | `event_archived` + N × `quota_credit_back_archive` |
| Toggle partner benefit | `event_partner_benefit_toggled` + N × quota changes |
| Toggle cultural event | `event_cultural_event_toggled` + N × quota changes |
| Relink | `registration_relinked` + quota credit-back + new decrement |
| Erase | `pii_erasure_requested` + `pii_erasure_completed` + quota credit-back |
| CSV import | One `csv_import_completed` + N × `csv_import_row_failed` for invalid rows |
| Any 403 by manager | `role_violation_blocked` |
| Cross-tenant access attempt | `cross_tenant_probe` (high severity) |
