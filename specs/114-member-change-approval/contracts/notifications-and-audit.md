# Contract — Notifications, audit events, timeline, metrics

## 1. Outbox rows (`notifications_outbox`, two new `notification_type` values)

Both are enqueued with `EmailPort.enqueueInTx` on the state-changing transaction (FR-012/FR-024) and
dispatched by `src/app/api/cron/outbox-dispatch/route.ts` (at-least-once; a retry may deliver
twice, never decide twice). `context_data` carries **ids only** — the dispatcher reads the request
rows at send time (`research.md` R8), so a scrubbed request renders as scrubbed and a sent row holds
no PII.

### `member_change_request_submitted_staff` — one row per reviewer

| field | value |
|---|---|
| `to_email` | reviewer's `users.email` (every active `admin` / `super_admin`) |
| `locale` | the PLATFORM default (`defaultLocale`, `en` — `users` carries no locale column, and there is no per-tenant staff locale on this path; `members-change-request-deps.ts`); a per-reviewer locale is a follow-up |
| `context_data` | `{ tenantId, requestId, memberId, submitterUserId, fieldKeys: string[] }` |

Rendered content (EN/TH/SV): subject `"[SweCham] Change request — <company> (<member no.>)"`;
body lists the member (company name + member number), the submitting person's name and role
(primary/secondary), the submission time in the tenant timezone, then one line per field —
`<label>: <current> → <proposed>` (address groups as a block; "(empty)" for null; tax-affecting
rows marked); link `https://<host>/admin/change-requests?submitter=<userId>&state=pending`. Never
CC/BCC; never to a member address.

**Coalescing (FR-011, T087)**: not enqueued when the replaced request's `staff_notified_at` is
within 1 h; the new row inherits that timestamp (along a chain of replacements — one email per
person per hour at most, SC-013) and the submitted audit row says `coalesced: true`.
`staff_notified_at` is null only when the roster was empty at submission.

**Dispatch failure** to one reviewer is recorded by the existing outbox retry/`email_dispatch_failed`
path and does not affect the others.

### `member_change_request_decided_member` — one row

| field | value |
|---|---|
| `to_email` | the submitting contact's current `contacts.email` (re-read at dispatch; if the contact was removed/erased, the row is marked skipped, audited as `email_dispatch_failed { reason: 'recipient_gone' }`) |
| `locale` | that contact's `preferred_language` |
| `context_data` | `{ tenantId, requestId, memberId, submitterUserId }` |

Rendered content: subject per outcome (`approved` / `partially approved` / `not approved`); body
lists **applied** fields ("now live") and **not-applied** fields, the reviewer's reason **verbatim,
escaped, plain text** (never rendered as markup or links), the decision time, and a link
`https://<host>/portal/edit?resubmit=<requestId>` that prefills exactly the rejected values. The
reviewer's name is never included (organisation only).

## 2. Audit events (five new `audit_event_type` values — five places each)

All on the same tx as the state change (`AuditPort.recordInTx`); `actorRole` = the session role;
payloads carry **ids, keys and outcomes — never values**.

| event | actor | payload | timeline | bumps `last_activity_at` |
|---|---|---|---|---|
| `member_change_request_submitted` | member user | `{ member_id, request_id, contact_id, scope, field_keys[], replaced_request_id\|null, coalesced: bool, actor_role }` | yes (`timeline.audit.member_change_request_submitted`) | yes (`member_id`) |
| `member_change_request_decided` | reviewer (staff) | `{ related_member_id, request_id, contact_id, scope, outcome, fields: [{key, outcome}], reason_length, member_notified: bool, member_notification_skipped?: 'recipient_gone', actor_role }` | yes | **no** (`related_member_id` — staff action) |
| `member_change_request_withdrawn` | member user, or system on erasure | `{ member_id \| related_member_id, request_id, contact_id, scope, withdrawn_reason: member\|replaced\|erasure, replaced_by_request_id?, actor_role }` — `withdrawn_reason`, never `reason` (the bare key is on the F9 redaction deny-list); the member key is a two-variant union in `ChangeRequestAuditPayload` (exactly one of `member_id` / `related_member_id`, compiler-checked) | yes for `member` (member activity); `replaced` and `erasure` use `related_member_id` | member: yes; others: no |
| `member_change_request_rate_limited` | member user | `{ member_id, window_count, retry_after_seconds }` | no (filtered like other refusals) | no |
| `member_change_approval_setting_changed` | staff | `{ previous: bool, next: bool }` (no `member_id`) | n/a | n/a |

Cross-tenant probes on any change-request route reuse the existing `member_cross_tenant_probe`
event (FR-035); forged Group C keys reuse `member_self_update_forbidden`.

The five places: `AUDIT_EVENT_TYPES` (domain, pinned 37 → 42), `auditEventTypeEnum` + migration
0301 (the enum-only file — 0300 carries the tables), members `AuditPort` union, `audit.eventType.*`
EN/TH/SV labels (Thai script asserted), `check:audit-events`.

## 3. Timeline

No view change: the events reach `member_timeline_v` through the audit arm. i18n keys
`timeline.audit.member_change_request_{submitted,decided,withdrawn}` × 3 locales. The portal
timeline shows the same rows for the member's own timeline (existing filter).

## 4. Metrics + alerts (`docs/observability.md` § 14, new)

| name | type | labels | source |
|---|---|---|---|
| `members_change_requests_pending_count` | gauge | `tenant` | per-tenant gauges tick (R12) — NO emitter until T102 (PR-3) |
| `members_change_request_oldest_age_seconds` | gauge | `tenant` | same — NO emitter until T102 (PR-3) |
| `members_change_request_submitted_total` | counter | `tenant, scope, coalesced` | submit use case |
| `members_change_request_decided_total` | counter | `tenant, outcome` | decide use case |
| `members_change_request_refused_total` | counter | `tenant, reason` (`rate_limited`, `forbidden`, `not_owner`, `archived`, `already_decided`, `validation`) | the submit use case (incl. the durable-cap 429) + the decide / acknowledge use cases |
| `members_change_request_decide_ms` | histogram | `tenant` | decide use case |
| `members_change_request_no_reviewers_total` | counter | `tenant` | submit use case — a CREATED request with an empty reviewer roster (pages) |
| `members_change_request_decision_email_skipped_total` | counter | `tenant, reason` (`recipient_gone`) | decide use case |

Names are underscored as emitted (`src/lib/metrics.ts`); `docs/observability.md § 14.1` is the catalogue.

Alerts: `oldest_age_seconds > 7d` → warning; `> 14d` → page (both inside the 30-day DSR clock,
FR-037). Every route arm that can only be a FAULT (a throwing gate resolver, a failed use case, a
failed re-read) names itself in the `errorId` taxonomy (`M114.<route>.<arm>` — the
`check:f8-error-id` pattern, without its gate); deterministic 4xx refusals are audited / counted
by the use case (the durable-cap 429 included), or not at all.

Logs: pino with `requestId`, `tenantId`, hashed user id, `requestChangeId`; **never** field values,
reasons or emails (`docs/observability.md` § 3 forbidden fields).

Traces (`@vercel/otel`): spans `members.change_request.submit` and `members.change_request.decide`
wrapping the use-case transaction, attributes limited to `tenant.slug`, `change_request.id`,
`change_request.scope`, `change_request.outcome`, `change_request.field_count` — never values.
The dispatcher arms reuse the existing outbox span with `notification_type` as an attribute.
