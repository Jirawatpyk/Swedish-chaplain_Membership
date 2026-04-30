# F7 — Resend Broadcasts Webhook Contract

**Branch**: `010-email-broadcast` | **Date**: 2026-04-29 | **Status**: Phase 1 Design

This document specifies the contract for `POST /api/webhooks/resend-broadcasts` — the inbound endpoint that ingests Resend's per-recipient delivery events for F7 broadcasts.

This webhook is **separate** from F1+F4's existing Resend transactional webhook at `/api/webhooks/resend`. Both endpoints live on the same Resend account but accept different event streams + use different signing secrets.

---

## 1. Endpoint

```
POST /api/webhooks/resend-broadcasts
Runtime: Node.js (NOT Edge — required for raw body access; see plan.md § Complexity Tracking)
Authz: Resend webhook signature only (no session cookie)
Content-Type: application/json
```

---

## 2. Signature verification (FR-024)

Resend uses **Svix** for webhook signing. Each request carries:

```
svix-id:        msg_<id>           # message id
svix-timestamp: <unix_seconds>     # at-most-5-min skew tolerated
svix-signature: v1,<base64hmac>    # may include multiple v1,... signatures separated by space
```

The handler runs the following BEFORE reading any payload field:

```ts
import { Webhook } from 'svix';

const wh = new Webhook(env.broadcasts.webhookSecret); // RESEND_BROADCASTS_WEBHOOK_SECRET
const payload = await request.text(); // raw body
const headers = {
  'svix-id': request.headers.get('svix-id') ?? '',
  'svix-timestamp': request.headers.get('svix-timestamp') ?? '',
  'svix-signature': request.headers.get('svix-signature') ?? '',
};

let event: ResendBroadcastEvent;
try {
  event = wh.verify(payload, headers) as ResendBroadcastEvent;
} catch (err) {
  // Signature mismatch — 401, audit, no further processing
  await audit.emit('broadcast_webhook_signature_rejected', { sourceIp: request.headers.get('x-forwarded-for'), failureReason: err.message });
  return new Response('signature verification failed', { status: 401 });
}
```

**Failure handling**:

- Missing `svix-*` headers → 401 + `broadcast_webhook_signature_rejected` audit (no payload read).
- Skew > 5 min → 401 + audit (replay window guard).
- Signature mismatch → 401 + audit.
- Malformed JSON body → 400 + `broadcast_webhook_malformed_payload` audit.

Resend retries failed webhooks with exponential backoff per its own retry policy (24h max attempts).

---

## 3. Event types ingested

All events have the shape:

```ts
type ResendBroadcastEvent = {
  type: 'email.sent' | 'email.delivered' | 'email.bounced' | 'email.delivery_delayed' | 'email.complained';
  created_at: string;        // ISO 8601 UTC
  data: {
    email_id: string;        // Resend's per-recipient message id
    broadcast_id: string;    // Resend's broadcast resource id (matches broadcasts.resend_broadcast_id in our DB)
    from: string;            // 'X via Y <broadcasts@tenant.example>'
    to: string[];             // single recipient per event (Resend always sends one event per recipient)
    subject: string;
    // event-type-specific fields:
    bounce?: {
      type: 'hard' | 'soft';
      message: string;       // bank reason code or RFC 5321 reply
    };
    complaint?: {
      complainedAt: string;
      type?: 'abuse' | 'auth_failure' | 'fraud' | 'not_spam' | 'other' | 'virus';
    };
  };
};
```

The handler dispatches by `type`:

| Resend event type | F7 delivery_status | Side effects |
|-------------------|---------------------|--------------|
| `email.sent` | `sent` | Insert delivery row |
| `email.delivered` | `delivered` | Insert delivery row; if all expected events received OR 24h timeout → transition broadcast `sending → sent` per FR-028 |
| `email.bounced` (hard) | `bounced` (bounceType='hard') | Insert delivery row + auto-add to `marketing_unsubscribes` with reason='hard_bounce' (FR-027) + audit `broadcast_suppression_applied` |
| `email.delivery_delayed` (soft bounce) | `soft_bounced` | Insert delivery row only (no suppression — Resend retries internally) |
| `email.complained` | `complained` | Insert delivery row + auto-add to `marketing_unsubscribes` with reason='complaint' + audit `broadcast_complaint_received` + admin alert (FR-027 + plan.md § Performance/Observability alert #7) |

---

## 4. Idempotency (FR-025)

Every event is idempotent on `data.email_id` (Resend's globally-unique per-event id). The DB primitive:

```sql
INSERT INTO broadcast_deliveries (tenant_id, delivery_id, broadcast_id, resend_event_id, resend_message_id, ...)
VALUES (...)
ON CONFLICT (tenant_id, resend_event_id) DO NOTHING
RETURNING delivery_id;
```

If the insert is a no-op (event already processed), the handler returns 200 immediately without further side effects (no duplicate broadcast state transition, no duplicate suppression, no duplicate audit). Resend's retry sees the 200 and stops retrying.

---

## 5. Tenant resolution

The webhook handler does not know `tenant_id` from the Resend event payload directly. Resolution:

```ts
// Application layer
async function resolveTenantFromEvent(event: ResendBroadcastEvent): Promise<TenantContext> {
  const broadcast = await db.query.broadcasts.findFirst({
    where: eq(broadcasts.resendBroadcastId, event.data.broadcast_id),
    columns: { tenantId: true, broadcastId: true },
  });
  if (!broadcast) {
    // Unknown broadcast id — could be a stale event from a deleted broadcast or a misdirected event.
    // Return a sentinel so the caller can audit but not error.
    return null;
  }
  return TenantContext.fromTenantId(broadcast.tenantId);
}
```

The lookup query runs under `swecham_super` (RLS bypass) because `tenant_id` is not yet known — this is the documented bypass per plan.md § Complexity Tracking. Once resolved, the tx re-enters `runInTenant(ctx, ...)` for downstream writes.

If `broadcast_id` does not match any row (e.g., late event for a broadcast we deleted out-of-band), the handler returns 200 + emits a low-severity log line `broadcast_webhook_orphan_event_received` (NOT an audit-log event — orphan handling is logged for ops observability but does not warrant a persisted audit row, since there is no tenant context to bind it to). Resend's retry policy will eventually time out the orphan event after 24h.

---

## 6. Per-event handler use cases

### 6.1 `handle-delivered-event.ts`

```ts
async function handleDeliveredEvent(ctx: TenantContext, event: ResendBroadcastEvent): Promise<void> {
  await runInTenant(ctx, async (tx) => {
    // 1. Idempotent insert
    const inserted = await broadcastDeliveriesRepo.insertOnConflictDoNothing(tx, {
      tenantId: ctx.tenantId,
      broadcastId: <resolved>,
      resendEventId: event.data.email_id,
      resendMessageId: event.data.email_id,
      recipientEmailLower: event.data.to[0].toLowerCase().trim(),
      recipientMemberId: await membersBridge.lookupMemberByEmail(ctx, event.data.to[0]) ?? null,
      status: 'delivered',
      eventTimestamp: new Date(event.created_at),
      bounceType: null,
      errorMessage: null,
    });
    if (!inserted) return; // already processed

    // 2. Check if all expected events received → transition to 'sent'
    const counts = await broadcastDeliveriesRepo.aggregateByBroadcast(tx, broadcastId);
    const broadcast = await broadcastsRepo.findByIdForUpdate(tx, broadcastId);
    const allEventsReceived = counts.delivered + counts.bounced + counts.complained >= broadcast.estimatedRecipientCount;
    const timeoutElapsed = Date.now() - broadcast.sendingStartedAt.getTime() > 24 * 3600 * 1000;
    if (allEventsReceived || timeoutElapsed) {
      await broadcastsRepo.transitionToSent(tx, broadcastId, {
        quotaYearConsumed: currentQuotaYear(tenantTz, new Date()),
        quotaConsumedAt: new Date(),
      });
      await audit.emit('broadcast_sent', { broadcastId, ...counts });
      await audit.emit('broadcast_quota_consumed', { broadcastId, memberId, year: quotaYear, count: 1 });
      if (timeoutElapsed && !allEventsReceived) {
        await audit.emit('broadcast_send_timeout_completed', { broadcastId, expectedCount: broadcast.estimatedRecipientCount, receivedCount: counts.total });
      }
      await emailTransactional.enqueueDeliverySummary(broadcastId, counts);
    }
  });
}
```

### 6.2 `handle-bounced-event.ts` (hard bounce)

```ts
async function handleBouncedEvent(ctx: TenantContext, event: ResendBroadcastEvent): Promise<void> {
  await runInTenant(ctx, async (tx) => {
    const recipientEmail = event.data.to[0].toLowerCase().trim();
    const inserted = await broadcastDeliveriesRepo.insertOnConflictDoNothing(tx, {
      tenantId: ctx.tenantId,
      broadcastId: <resolved>,
      resendEventId: event.data.email_id,
      resendMessageId: event.data.email_id,
      recipientEmailLower: recipientEmail,
      recipientMemberId: await membersBridge.lookupMemberByEmail(ctx, recipientEmail) ?? null,
      status: 'bounced',
      eventTimestamp: new Date(event.created_at),
      bounceType: event.data.bounce?.type ?? 'hard',
      errorMessage: event.data.bounce?.message ?? null,
    });
    if (!inserted) return;

    if (event.data.bounce?.type === 'hard') {
      // FR-027: auto-add to suppression
      await marketingUnsubscribesRepo.upsertOnConflictDoNothing(tx, {
        tenantId: ctx.tenantId,
        emailLower: recipientEmail,
        memberId: await membersBridge.lookupMemberByEmail(ctx, recipientEmail),
        reason: 'hard_bounce',
        sourceBroadcastId: broadcastId,
        sourceTokenHash: null,
      });
      await audit.emit('broadcast_suppression_applied', { broadcastId, suppressedCount: 1, reason: 'hard_bounce' });
    }
  });
}
```

(Soft bounces — `email.delivery_delayed` — go through this same handler with `bounceType='soft'` but skip the suppression branch.)

### 6.3 `handle-complained-event.ts`

```ts
async function handleComplainedEvent(ctx: TenantContext, event: ResendBroadcastEvent): Promise<void> {
  await runInTenant(ctx, async (tx) => {
    const recipientEmail = event.data.to[0].toLowerCase().trim();
    const inserted = await broadcastDeliveriesRepo.insertOnConflictDoNothing(tx, {
      tenantId: ctx.tenantId,
      broadcastId: <resolved>,
      resendEventId: event.data.email_id,
      resendMessageId: event.data.email_id,
      recipientEmailLower: recipientEmail,
      recipientMemberId: await membersBridge.lookupMemberByEmail(ctx, recipientEmail) ?? null,
      status: 'complained',
      eventTimestamp: new Date(event.created_at),
      bounceType: null,
      errorMessage: event.data.complaint?.type ?? null,
    });
    if (!inserted) return;

    // FR-027: auto-add to suppression + admin alert
    await marketingUnsubscribesRepo.upsertOnConflictDoNothing(tx, {
      tenantId: ctx.tenantId,
      emailLower: recipientEmail,
      memberId: await membersBridge.lookupMemberByEmail(ctx, recipientEmail),
      reason: 'complaint',
      sourceBroadcastId: broadcastId,
      sourceTokenHash: null,
    });
    await audit.emit('broadcast_complaint_received', {
      broadcastId,
      recipientEmailHash: sha256(recipientEmail),
      memberId,
    });
    await audit.emit('broadcast_suppression_applied', { broadcastId, suppressedCount: 1, reason: 'complaint' });
    // Admin alert via plan.md § Performance/Observability alert #7
    await alertChannel.emitComplaintRateCheck(ctx.tenantId);
  });
}
```

---

## 7. Response codes summary

| Code | Meaning | Resend behaviour |
|------|---------|--------------------|
| 200 | Event processed (idempotent — replays return 200 quickly) | Stops retrying |
| 400 | Malformed JSON body | Stops retrying (Resend won't reformat) |
| 401 | Signature verification failed | Continues retrying per Resend's policy (which is wrong here, but Resend doesn't distinguish 401 from transient — operational alert fires after 1 retry) |
| 500 | Unexpected handler error | Continues retrying with backoff |

The handler is designed to NEVER return 5xx unless something genuinely transient happened (DB outage). Permanent failures (orphan event, malformed payload) return 200 with audit so Resend stops retrying.

---

## 8. Observability

Every webhook invocation emits:

- pino log line with `event_type`, `resend_broadcast_id`, `tenant_id` (if resolved), `delivery_id` (if inserted), `duration_ms`. The recipient email is **NEVER** in the log line; only its sha256 hash if cross-request correlation is needed.
- OTel span `broadcasts.webhook_handle` with attributes `tenant.id`, `broadcast.id`, `resend.event_id`, `resend.event_type`, `idempotency.was_duplicate`.
- OTel histogram `broadcasts.webhook_handler_seconds` (SLO-F7-005 backing).

Log-line redact list (extends F1+F4+F5 pino redactors): `data.to`, `data.from`, `data.subject`, `bounce.message`, `complaint.type`, `svix-signature`.
