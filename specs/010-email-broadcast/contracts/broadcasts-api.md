# F7 — Broadcasts REST API Contracts

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Status**: Phase 1 Design

This document defines the REST API contracts for the F7 member + admin surfaces. All routes are tenant-scoped via middleware-resolved `TenantContext` (subdomain → tenant lookup). All request + response bodies are zod-validated. Bilingual (EN/TH/SV) error codes per FR-039.

Common headers: `Content-Type: application/json`, `Accept-Language: en|th|sv` (resolved per F1 + next-intl convention).

---

## 1. Member-facing routes (`(member)/portal` actor)

### 1.1 `POST /api/broadcasts/draft`

Create a new draft broadcast. Authz: `member` role on own member record.

**Request body**:

```ts
const CreateDraftBody = z.object({
  subject: z.string().min(1).max(200).optional(),
  bodyHtml: z.string().max(200 * 1024).optional(),     // sanitised at submit, not at draft
  bodySource: z.string().max(200 * 1024).optional(),   // Tiptap JSON or markdown
  segmentType: z.enum(['all_members', 'tier', 'event_attendees_last_90d', 'custom']).optional(),
  segmentParams: z.record(z.unknown()).optional(),
  customRecipientEmails: z.array(z.string().email()).max(100).optional(),
  scheduledFor: z.string().datetime({ offset: true }).optional(),
});
```

**Response 201**:

```ts
{
  broadcastId: string,           // uuid
  status: 'draft',
  createdAt: string,             // ISO 8601 UTC
  updatedAt: string,
  // ... echoed input fields
}
```

**Response 400**: zod validation failure (per-field errors).
**Response 403**: not authorised (e.g., manager role).
**Response 429**: draft-save rate limit exceeded (60/5min per actor).

---

### 1.2 `PUT /api/broadcasts/draft`

Update an existing draft. Authz: same actor as creator. Body identical to 1.1; rejects if `status != 'draft'` (FR-004 + Clarifications Q3).

**Response 200**: same shape as 1.1.
**Response 409**: `broadcast_immutable_after_submit` if status is not draft.

---

### 1.3 `POST /api/broadcasts/submit`

Submit a draft for admin review. Authz: `member` role on own member record + own draft.

**Request body**:

```ts
const SubmitBroadcastBody = z.object({
  broadcastId: z.string().uuid(),
});
```

**Response 200**:

```ts
{
  broadcastId: string,
  status: 'submitted',
  submittedAt: string,
  estimatedRecipientCount: number,
  reservedQuotaSlot: true,
  reviewSlaTargetHours: 48,      // surfaced per FR-013 + Q2
}
```

**Response 422** (precondition failures from FR-002 a–j):

```ts
{
  errorCode: 'broadcast_quota_blocked' | 'broadcast_empty_segment_blocked' |
             'broadcast_rate_limit_exceeded' | 'broadcast_not_in_plan' |
             'broadcast_subject_too_long' | 'broadcast_body_too_large' |
             'broadcast_body_unsafe_html' | 'broadcast_audience_too_large' |
             'broadcast_custom_recipient_unknown' |
             'broadcast_member_missing_primary_contact_email',
  errorMessageI18nKey: string,                                // resolves via next-intl
  errorDetails?: {
    forbiddenConstructs?: string[],                            // body_unsafe_html only
    unresolvedEntries?: string[],                              // custom_recipient_unknown only — verbatim addresses
    submittedSize?: number,                                    // body_too_large only
    submittedLength?: number,                                  // subject_too_long only
    profileEditDeepLink?: string,                              // member_missing_primary_contact_email only
  }
}
```

**Response 429**: 10-submissions-per-rolling-24h rate limit per FR-002d.

---

### 1.4 `POST /api/broadcasts/[id]/cancel`

Cancel a `submitted` or `approved` broadcast. Authz: originating member only.

**Request body**:

```ts
const CancelBroadcastBody = z.object({
  cancellationReason: z.string().max(500).optional(),
});
```

**Response 200**:

```ts
{
  broadcastId: string,
  status: 'cancelled',
  cancelledAt: string,
  reservationReleased: true,
}
```

**Response 409**: `broadcast_cancel_too_late` per FR-004a / Q10.

---

### 1.5 `GET /api/broadcasts/[id]`

Get one broadcast by id. Authz: originating member only (FR-037 cross-member-probe → 404).

**Response 200**:

```ts
{
  broadcastId: string,
  status: BroadcastStatus,
  subject: string,
  bodyHtml: string,                                            // sanitised
  segmentType: SegmentType,
  segmentParams: Record<string, unknown> | null,
  customRecipientEmails: string[] | null,                      // own data — visible to creator
  estimatedRecipientCount: number,
  scheduledFor: string | null,
  submittedAt: string | null,
  approvedAt: string | null,
  rejectedAt: string | null,
  rejectionReason: string | null,                              // verbatim — member sees their reason
  cancelledAt: string | null,
  cancellationReason: string | null,
  sentAt: string | null,
  // Delivery summary (only populated for status='sent')
  deliverySummary: {
    delivered: number,
    bounced: number,
    complained: number,
    suppressedAtDispatch: number,
  } | null,
  createdAt: string,
  updatedAt: string,
}
```

**Response 404**: not found OR cross-member probe (FR-037).

---

### 1.6 `GET /api/broadcasts`

List own broadcasts with pagination + filtering. Authz: originating member only.

**Query params**:

```ts
const ListBroadcastsQuery = z.object({
  status: z.array(z.enum([...statuses])).optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(50).default(20),
});
```

**Response 200**:

```ts
{
  items: Array<{
    broadcastId: string,
    status: BroadcastStatus,
    subject: string,
    submittedAt: string | null,
    sentAt: string | null,
    estimatedRecipientCount: number,
  }>,
  nextCursor: string | null,
}
```

---

### 1.7 `GET /api/broadcasts/quota`

Get the current quota counter for the signed-in member. Backs Smart Feature #1 Benefit Dashboard.

**Response 200**:

```ts
{
  planId: string,                                              // member's current plan id
  eblastPerYear: number,                                       // from plans.eblast_per_year
  quotaYear: number,                                           // current quota year per FR-006
  used: number,                                                // count of status='sent' && quota_year_consumed=year
  reserved: number,                                            // count of status IN ('submitted','approved')
  remaining: number,                                           // = eblastPerYear - used - reserved
  nextResetAt: string,                                         // ISO 8601 UTC; next-year boundary in tenant timezone
  tenantTimezone: string,                                      // e.g., 'Asia/Bangkok'
}
```

---

## 2. Admin-facing routes (`(staff)/admin` actor)

### 2.1 `GET /api/admin/broadcasts`

Review queue + tenant-wide list. Authz: `admin` or `manager` (manager is read-only).

**Query params**:

```ts
const ListAdminBroadcastsQuery = z.object({
  status: z.array(z.enum([...statuses])).default(['submitted']),
  memberId: z.string().uuid().optional(),
  segmentType: z.enum([...segmentTypes]).optional(),
  fromDate: z.string().datetime().optional(),
  toDate: z.string().datetime().optional(),
  cursor: z.string().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  sort: z.enum(['submitted_at_asc', 'submitted_at_desc']).default('submitted_at_asc'),
});
```

**Response 200**:

```ts
{
  items: Array<{
    broadcastId: string,
    status: BroadcastStatus,
    subject: string,
    requestedByMemberId: string,
    requestedByMemberDisplayName: string,                      // joined from members table
    actorRole: 'member_self_service' | 'admin_proxy',
    submittedByUserDisplayName: string,                        // visible for proxy submissions
    segmentType: SegmentType,
    estimatedRecipientCount: number,
    submittedAt: string,
    submittedAtAge: string,                                    // e.g., "2 days ago" — locale-aware
  }>,
  nextCursor: string | null,
  totalPending: number,                                        // dashboard badge count
}
```

---

### 2.2 `POST /api/admin/broadcasts/[id]/approve`

Approve a submitted broadcast. Authz: `admin` only (manager → 403).

**Request body** — variant 1 (send now):

```ts
const ApproveSendNowBody = z.object({
  decision: z.literal('send_now'),
});
```

**Request body** — variant 2 (schedule):

```ts
const ApproveScheduleBody = z.object({
  decision: z.literal('schedule'),
  scheduledFor: z.string().datetime({ offset: true })
    .refine(t => new Date(t).getTime() > Date.now() + 5 * 60 * 1000, { message: 'scheduled_for_must_be_at_least_5min_in_future' }),
});
```

**Response 200**:

```ts
{
  broadcastId: string,
  status: 'approved' | 'sending',                             // 'sending' on send_now path; 'approved' on schedule path
  approvedAt: string,
  scheduledFor: string | null,
  resendBroadcastId: string | null,                            // populated only on send_now path
}
```

**Response 409**: `broadcast_invalid_state_transition` (e.g., already cancelled by member between admin's queue load and approve click) — per US2 AS6 + FR-004 trigger.
**Response 403**: manager role attempting to approve.

---

### 2.3 `POST /api/admin/broadcasts/[id]/reject`

Reject a submitted broadcast with required reason. Authz: `admin` only.

**Request body**:

```ts
const RejectBroadcastBody = z.object({
  rejectionReason: z.string().min(1).max(2000),                // FR-012: min 1 non-whitespace char
});
```

**Response 200**:

```ts
{
  broadcastId: string,
  status: 'rejected',
  rejectedAt: string,
  reservationReleased: true,
}
```

---

### 2.4 `POST /api/admin/broadcasts/[id]/cancel`

Cancel a submitted or approved broadcast as admin. Authz: `admin` only. Admin-cancel reason is required (FR-004a).

**Request body**:

```ts
const AdminCancelBody = z.object({
  cancellationReason: z.string().min(1).max(500),              // required for admin per FR-004a
});
```

**Response 200**: same shape as 1.4.

---

### 2.5 `POST /api/admin/broadcasts/proxy-submit`

Admin-on-behalf-of-member submission (Clarifications Q12). Authz: `admin` only.

**Request body**:

```ts
const ProxySubmitBody = z.object({
  // Identifies the member being proxied for
  requestedByMemberId: z.string().uuid(),
  // Same content fields as draft create + submit
  subject: z.string().min(1).max(200),
  bodyHtml: z.string().min(1).max(200 * 1024),
  bodySource: z.string().min(1).max(200 * 1024),
  segmentType: z.enum([...segmentTypes]),
  segmentParams: z.record(z.unknown()).optional(),
  customRecipientEmails: z.array(z.string().email()).max(100).optional(),
  scheduledFor: z.string().datetime({ offset: true }).optional(),
});
```

The use case creates a draft + immediately transitions to `submitted` in one tx; the broadcast row carries `actor_role='admin_proxy'`, `submitted_by_user_id=<admin>`, `requested_by_member_id=<proxied member>`, with the audit log emitting `broadcast_submitted` with `actor_role='admin_proxy'`. The proxied broadcast then goes through the standard admin queue (admins do NOT auto-approve their own proxied submissions).

**Response 200**: same shape as 1.3 plus `actorRole: 'admin_proxy'`.

**Response 422**: same precondition errors as 1.3 (the proxied member's preconditions are checked, not the admin's).

---

### 2.6 `GET /api/admin/broadcasts/[id]`

Admin-side broadcast detail with full delivery breakdown. Authz: `admin` or `manager` (read-only).

**Response 200**: extends 1.5 response with:

```ts
{
  // ... 1.5 fields
  requestedByMember: {
    memberId: string,
    displayName: string,
    primaryContactEmail: string,
  },
  submittedByUser: {
    userId: string,
    displayName: string,
    email: string,
  },
  actorRole: 'member_self_service' | 'admin_proxy' | 'system',  // 'system' added 2026-04-29 (N1 remediation) for cascade-cancelled broadcasts
  rejectionReasonHash: string | null,                          // sha256 — for audit-correlation; raw reason in rejectionReason field
  audit: Array<{                                                // recent audit events for this broadcast
    eventType: string,
    actorId: string,
    actorRole: string,
    timestamp: string,
    payload: Record<string, unknown>,                          // already PII-stripped
  }>,
  deliveryDetail: {                                             // per-recipient breakdown for admin
    delivered: Array<{ emailHash: string, memberId: string | null, eventTimestamp: string }>,
    bounced:   Array<{ emailHash: string, bounceType: 'hard' | 'soft', errorMessage: string, eventTimestamp: string }>,
    complained: Array<{ emailHash: string, eventTimestamp: string }>,
  } | null,
}
```

(Admin sees `emailHash` not raw email for non-member recipients; for member recipients, the admin can drill into the member detail.)

---

### 2.7 `GET /api/admin/broadcasts/sla-stats`

Admin queue SLA banner data source (FR-013 + SC-002 — N2 remediation post-/speckit.analyze 2026-04-29). Backs the 48-hour SLA target banner on the admin queue page header (T125a). Authz: `admin` or `manager` (read-only).

**Query params**: none (computes rolling 30-day window server-side).

**Response 200**:

```ts
{
  targetSlaHours: 48,                                          // FR-013 informational target (literal constant in MVP)
  rollingWindow: '30d',                                        // SC-002 measurement window
  medianTimeToDecisionHours: number,                           // p50 from broadcasts WHERE submitted_at >= NOW() - INTERVAL '30 days' AND status IN ('approved','rejected')
  p95TimeToDecisionHours: number,                              // p95 same window
  decisionCount: number,                                       // sample size for the percentile calc
  bannerSeverity: 'green' | 'amber' | 'red',                  // green: median <=24h AND p95 <=40h; amber: median <=24h AND p95 <=48h; red: any breach
  computedAt: string,                                          // ISO 8601 UTC; cache with revalidate 60s per perf.md CHK056
}
```

**Response 200 (zero-data path)**:

```ts
{
  targetSlaHours: 48,
  rollingWindow: '30d',
  medianTimeToDecisionHours: null,                             // null when decisionCount === 0
  p95TimeToDecisionHours: null,
  decisionCount: 0,
  bannerSeverity: 'green',                                     // default green when no data
  computedAt: string,
}
```

**Response 403**: not authorised (member role).

---

## 3. Cron route

### 3.1 `GET /api/cron/broadcasts/dispatch-scheduled`

Cron-job.org HTTP trigger every 5 min per plan.md § Performance + research.md § 6. Authz: `Authorization: Bearer ${CRON_SECRET}`.

**Request**: empty.

**Response 200**:

```ts
{
  dispatchedCount: number,
  skippedCount: number,                                         // rows already locked by another worker
  failedCount: number,
  durationMs: number,
}
```

**Response 401**: missing or invalid bearer.

---

### 3.2 `GET /api/cron/broadcasts/reconcile-stuck-sending`

Cron-job.org HTTP trigger every 15 min per perf.md CHK033 (R2-NEW-3 stuck-`sending` reconciliation). Detects broadcasts in `sending` status with `dispatched_at > 5 min ago`, queries Resend dashboard for existence, transitions to `failed_to_dispatch` on 404 after 24h sustained.

**Authz**: `Authorization: Bearer ${CRON_SECRET}`.

**Response 200**:

```ts
{
  reconciledCount: number,
  resourceMissingCount: number,                                 // emitted broadcast_resend_resource_missing
  durationMs: number,
}
```

---

### 3.3 `GET /api/cron/broadcasts/prune-expired-drafts`

Cron-job.org HTTP trigger daily per FR-001a (draft 30-day TTL — A1 remediation post-/speckit.analyze 2026-04-29). Deletes `broadcasts WHERE status = 'draft' AND updated_at < NOW() - INTERVAL '30 days'`.

**Authz**: `Authorization: Bearer ${CRON_SECRET}`.

**Response 200**:

```ts
{
  prunedCount: number,
  durationMs: number,
}
```

NO audit event emitted — drafts are user-controlled scratch space per FR-001.

---

## 4. Error envelope (shared across all routes)

```ts
{
  errorCode: string,                                           // machine-readable; one of the spec FR error codes
  errorMessageI18nKey: string,                                  // e.g., 'broadcasts.errors.quotaBlocked' — resolved client-side via next-intl
  errorMessageEn: string,                                       // pre-resolved English fallback
  errorDetails?: Record<string, unknown>,                       // machine-readable extra context (e.g., entries listing, sizes)
  requestId: string,                                            // log correlation id (forbidden-fields-redacted pino root id)
}
```

---

## 5. Rate limit headers

Every rate-limited endpoint returns standard headers per F1 convention:

- `X-RateLimit-Limit`
- `X-RateLimit-Remaining`
- `X-RateLimit-Reset` (seconds-to-reset)

When 429, `Retry-After` is set to seconds-to-reset.

---

## 6. Idempotency

Endpoints that accept an `Idempotency-Key` header:

| Route | Key derivation if absent |
|-------|--------------------------|
| `POST /api/broadcasts/submit` | `sha256(tenantId + memberId + draftBodySha256)` |
| `POST /api/admin/broadcasts/[id]/approve` | `sha256(tenantId + adminUserId + broadcastId + decision)` |
| `POST /api/admin/broadcasts/[id]/reject` | `sha256(tenantId + adminUserId + broadcastId + reasonSha256)` |
| `POST /api/admin/broadcasts/proxy-submit` | `sha256(tenantId + adminUserId + memberId + draftBodySha256)` |

The key persists in Upstash Redis for 24h and de-duplicates retries.

---

## 7. Audit emission per route (non-exhaustive)

Each successful response emits the corresponding audit event(s); the table maps route → event types:

| Route | Audit events emitted |
|-------|----------------------|
| `POST /api/broadcasts/draft` | `broadcast_drafted` (only on first create; subsequent draft updates do NOT re-audit) |
| `POST /api/broadcasts/submit` | `broadcast_submitted` (success); `broadcast_*_blocked` event matching the failure case (rejection paths) |
| `POST /api/broadcasts/[id]/cancel` | `broadcast_cancelled` (success); `broadcast_cancel_too_late` (failure) |
| `POST /api/admin/broadcasts/[id]/approve` (send_now) | `broadcast_approved` + `broadcast_send_started` |
| `POST /api/admin/broadcasts/[id]/approve` (schedule) | `broadcast_approved` |
| `POST /api/admin/broadcasts/[id]/reject` | `broadcast_rejected` |
| `POST /api/admin/broadcasts/[id]/cancel` | `broadcast_cancelled` |
| `POST /api/admin/broadcasts/proxy-submit` | `broadcast_submitted` (with `actor_role='admin_proxy'`) |
| `GET /api/cron/broadcasts/dispatch-scheduled` | `broadcast_send_started` per dispatched row |

Cross-tenant + cross-member probes emit `broadcast_cross_tenant_probe` / `broadcast_cross_member_probe` regardless of method.
