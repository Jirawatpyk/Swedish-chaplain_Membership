# F8 — Admin Renewals API Contract

**Feature**: F8 Renewal Tracking + Smart Reminders
**Branch**: `011-renewal-reminders`
**Date**: 2026-05-03
**Status**: Phase 1 contract output

All admin endpoints below require `admin` role. `manager` role is read-only on GET endpoints + **one mutation exception**: `POST /api/admin/renewals/at-risk/[memberId]/outreach` IS permitted for manager per FR-033 + FR-052a (board-level relationship tracking — manager can record their own phone calls / meetings). All other mutating endpoints (POST/PATCH/DELETE) reject `manager` with **403** + audit event `f8_role_violation_blocked` (defence in depth alongside UI-layer hide/disable).

All endpoints are tenant-scoped. Tenant context is resolved from session middleware (subdomain or signed header). Cross-tenant access attempts emit `renewal_cross_tenant_probe`.

---

## 1. Pipeline (read)

### `GET /api/admin/renewals`

List active members in the renewal pipeline, grouped by urgency bucket.

**Query params**:
- `tier` — optional tier-bucket filter (`thai_alumni` | `start_up` | `regular` | `premium` | `partnership`)
- `urgency` — optional urgency filter (`t-90` | `t-60` | `t-30` | `t-14` | `t-7` | `t-0` | `grace` | `lapsed`)
- `cursor` — opaque pagination cursor
- `limit` — page size (default 50, max 200)

**Response 200**:

```json
{
  "items": [
    {
      "cycle_id": "...",
      "member_id": "...",
      "company_name": "Fogmaker International AB",
      "tier_bucket": "premium",
      "expires_at": "2026-08-15T17:00:00Z",
      "urgency": "t-90",
      "status": "upcoming",
      "last_reminder_at": "2026-05-15T08:00:00Z",
      "last_reminder_step_id": "t-90.email",
      "linked_invoice_id": null
    }
  ],
  "next_cursor": "...",
  "summary": {
    "total_in_window": 600,
    "by_urgency": { "t-90": 50, "t-60": 100, "t-30": 200, ... },
    "lapsed_count": 12
  }
}
```

**Errors**: 401 unauth · 403 cross-tenant · 503 if `FEATURE_F8_RENEWALS=false`

**SLO**: p95 < 500ms @ 5,000 active members + 600 in 90-day window (FR-046 / SC-003)

---

### `GET /api/admin/renewals/[cycleId]`

Detail view for a single cycle.

**Response 200**: cycle row + reminder event history + escalation tasks + linked invoice info.

---

## 2. Pipeline (mutate — admin only)

### `POST /api/admin/renewals/[cycleId]/send-reminder-now`

Manually dispatch a reminder for a cycle. Same use-case path as cron (FR-018).

**Body**:
```json
{ "step_id": "t-30.email" }
```

**Response 200**: `{ event_id, dispatched_at, delivery_id }`
**Response 409**: idempotency-hit if same `step_id` already dispatched for this cycle in this `year_in_cycle`
**Audit**: `renewal_reminder_sent` with `actor_user_id = admin_id`

**Rate limit**: 30 manual sends / 5 min per `(tenant_id, actor_user_id)`

---

### `POST /api/admin/renewals/[cycleId]/cancel`

Manually cancel a cycle (e.g., member is leaving).

**Body**: `{ reason: string }` (max 500 chars)

**Response 200**: `{ status: "cancelled", closed_at }`
**Audit**: `renewal_cycle_cancelled`

---

### `POST /api/admin/renewals/[cycleId]/mark-paid-offline`

Admin records an out-of-band payment. F4 invoice is created and immediately marked paid in the same transaction.

**Body**:
```json
{ "payment_method": "bank_transfer" | "cash" | "cheque", "payment_reference": "BT-2026-0042", "payment_date": "2026-05-15" }
```

**Validation rules** (Round 7 S-R6-3):
- `payment_method`: enum `{ bank_transfer | cash | cheque }` (no `other` — F8 mark-paid-offline is for known offline channels only).
- `payment_reference`: 1–100 chars. **MUST NOT** match the PAN paste-error pattern (`\d{13,}` ASCII OR 13+ Arabic-Indic / Eastern Arabic-Indic / Devanagari / Thai script digits in a row — Constitution Principle IV PCI DSS NON-NEGOTIABLE defence-in-depth). Hyphen- or space-separated PANs (`4111-1111-1111-1111` / `4111 1111 1111 1111`) are intentionally NOT blocked at this layer — operator workflow surfaces the value in the confirmation toast as second line of defence. Non-PAN references with separators (e.g. Thai bank format `KTB-20260504-12345`) MUST be accepted.
- `payment_date`: `YYYY-MM-DD` (Bangkok-local).

**Response 200**: `{ cycle_status: "completed", invoice_id, new_expires_at }`
**Response 400**: `{ error: { code: "invalid_body", details: { fieldErrors: ... } } }` — includes the PAN-rejection case.
**Response 502**: `{ error: { code: "f4_failure", stage } }` — `reason` field is intentionally scrubbed from the body (logged server-side; see Round 5 W-02).
**Response 409 (orphan)**: `{ error: { code: "f4_orphan_invoice", orphan_invoice_id } }` — `reason` likewise scrubbed.
**Audit**: `renewal_invoice_created` + `renewal_completed` + `renewal_cycle_completed_offline`

---

## 3. At-risk widget

### `GET /api/admin/renewals/at-risk`

List at-risk members (score ≥ 50, not snoozed).

**Query params**: `band` (warning | at-risk | critical) · `cursor` · `limit`

**Response 200**:
```json
{
  "items": [
    {
      "member_id": "...",
      "company_name": "...",
      "tier_bucket": "premium",
      "risk_score": 78,
      "risk_score_band": "critical",
      "risk_score_factors": { "events_attended_12m": 0, "invoices_overdue": 1, ... },
      "risk_score_last_computed_at": "2026-05-03T02:00:00Z",
      "last_outreach_at": null
    }
  ],
  "next_cursor": "...",
  "summary": { "warning": 5, "at-risk": 7, "critical": 2, "f6_active": false, "active_max": 70 }
}
```

---

### `POST /api/admin/renewals/at-risk/[memberId]/snooze`

Suppress at-risk widget surfacing for N days.

**Body**: `{ duration_days: 7 | 30 | 90 }`

**Response 200**: `{ snoozed_until }`
**Audit**: `at_risk_snoozed`

---

### `POST /api/admin/renewals/at-risk/[memberId]/outreach`

Record an outreach action. **Permitted for `admin` AND `manager` roles** (FR-033 + FR-052a manager exception).

**Body**:
```json
{ "channel": "email" | "phone" | "meeting", "template_id"?: "at_risk.outreach.event_drought", "outcome_note"?: "..." }
```

**Response 201**: `{ outreach_id, created_at }`
**Audit**: `at_risk_outreach_recorded` (with `actor_role` recorded so admin/manager attribution is preserved)

**Side effect (FR-033)**: when an outreach is recorded, the daily reminder cron will skip email steps for this member for the next 7 days (audit reason `outreach_in_progress`) — prevents collision between admin's personal outreach and system-dispatched form emails. Pause auto-expires after 7 days.

---

## 4. Tier-upgrade queue

### `GET /api/admin/renewals/tier-upgrades`

List open + pending suggestions.

**Query params**: `status` (open | accepted_pending_apply) · `cursor` · `limit`

**Response 200**:
```json
{
  "items": [
    {
      "suggestion_id": "...",
      "member_id": "...",
      "company_name": "...",
      "from_plan_id": "...",
      "from_plan_name": "Regular Corporate",
      "to_plan_id": "...",
      "to_plan_name": "Premium Corporate",
      "reason_code": "declared_turnover_above_threshold",
      "evidence_jsonb": { "turnover_thb": 120000000, "threshold_thb": 100000000, "threshold_met_at": "2026-04-15" },
      "status": "open",
      "created_at": "2026-05-01T03:00:00Z"
    }
  ],
  "next_cursor": "..."
}
```

---

### `POST /api/admin/renewals/tier-upgrades/[suggestionId]/accept`

Accept a tier-upgrade suggestion. Triggers Q5 round 2 pending-state flow (FR-039):

1. Suggestion → `accepted_pending_apply`
2. Member transactional email dispatched
3. T-180 admin verification task created if `expires_at - today > 180 days`

**Body**: (none)

**Response 200**: `{ status: "accepted_pending_apply", target_apply_at_cycle_id, member_email_dispatched, admin_verification_task_id? }`

**Audit**: `tier_upgrade_accepted` + `tier_upgrade_pending_member_notified` + (`tier_upgrade_pending_admin_verification_due` if task created)

---

### `POST /api/admin/renewals/tier-upgrades/[suggestionId]/dismiss`

**Body**: `{ reason: string }` (max 500 chars)

**Response 200**: `{ status: "dismissed", suppressed_until }`
**Audit**: `tier_upgrade_dismissed`

---

### `POST /api/admin/renewals/tier-upgrades/[suggestionId]/escalate`

Open a pre-filled outreach email draft.

**Body**: (none)

**Response 200**: `{ outreach_id, email_draft: { subject, body_template_id, rendered_preview } }`
**Audit**: `at_risk_outreach_recorded` (outreach created with `template_id = 'tier_upgrade_outreach.{tier}'`)

---

## 5. Escalation task queue

### `GET /api/admin/renewals/tasks`

List open escalation tasks.

**Query params**: `assigned_to_user_id` (`me` | UUID | `unassigned`) · `task_type` · `cursor` · `limit`

**Response 200**: array of task rows.

---

### `POST /api/admin/renewals/tasks/[taskId]/done`

**Body**: `{ outcome_note?: string }` (max 1000)

**Response 200**: `{ status: "done", closed_at }`
**Audit**: `escalation_task_completed`

---

### `POST /api/admin/renewals/tasks/[taskId]/skip`

**Body**: `{ reason: string }` (max 500, required)

**Response 200**: `{ status: "skipped", closed_at }`
**Audit**: `escalation_task_skipped`

---

### `POST /api/admin/renewals/tasks/[taskId]/reassign`

**Body**: `{ to_user_id: UUID }`

**Response 200**: `{ assigned_to_user_id }`
**Audit**: `escalation_task_reassigned`

---

## 6. Settings

### `GET /api/admin/renewals/settings/tenant`

Read tenant-level F8 settings.

**Response 200**: `{ grace_period_days, auto_upgrade_enabled, min_tenure_days_for_at_risk, dispatch_cron_enabled, reply_to_email, reply_to_display_name }`

---

### `PUT /api/admin/renewals/settings/tenant`

Update tenant settings. Validation per `tenant_renewal_settings` table CHECK constraints.

**Audit**: `renewal_schedule_policy_updated` (reused; payload includes which keys changed)

---

### `GET /api/admin/renewals/settings/schedules`

Read all 5 schedule policies for the tenant.

**Response 200**:
```json
{
  "policies": [
    { "tier_bucket": "thai_alumni", "steps": [...] },
    { "tier_bucket": "start_up", "steps": [...] },
    ...
  ]
}
```

---

### `PUT /api/admin/renewals/settings/schedules/[tierBucket]`

Update one bucket's schedule policy. Validates step shape against zod schema.

**Body**: `{ steps: [...] }`

**Response 200**: `{ tier_bucket, updated_at }`
**Audit**: `renewal_schedule_policy_updated`
