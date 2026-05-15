# F5 Carry-over guidance from F4 R10 review

Captured at the end of the F4 ten-round review cycle (2026-05-15)
before F5 implementation begins. These items are **patterns to
adopt** or **anti-patterns to avoid**, not F4 bugs.

## 1. Webhook handler pattern (extends F4 try/catch baseline)

F4's PDF + resend routes established a baseline:

```text
1. require* context guard (auth/RBAC)
2. params extraction
3. try { use-case } catch { logger.error + 500 internal_error }
4. if (!result.ok) { logger.warn + map error code to HTTP status }
5. success path
```

F5's Stripe webhook handler MUST extend this pattern with **three
additional layers BEFORE step 3**:

### 1.1 Signature verification — outside the use-case try/catch

```ts
const rawBody = await request.text();
const sig = request.headers.get('stripe-signature');
let event: Stripe.Event;
try {
  event = stripe.webhooks.constructEvent(
    rawBody, sig ?? '', env.stripe.webhookSecret
  );
} catch (err) {
  await audit.emit(null, {
    eventType: 'webhook_signature_rejected',
    ...
  });
  return NextResponse.json(
    { error: 'invalid_signature' },
    { status: 401 },  // ← NOT 500. Stripe stops retrying on 4xx.
  );
}
```

F4's "wrap in try/catch → 500" pattern would cause Stripe to retry
the webhook indefinitely. Signature-rejection must return 4xx so
the retry queue drains.

### 1.2 Idempotency lookup — `processor_events` table

```ts
const dup = await processorEventsRepo.findById(event.id);
if (dup) return NextResponse.json({ ok: true, deduped: true });
```

Webhooks deliver at-least-once. F4 reads are naturally idempotent +
F4 writes use tx-bound advisory locks, so F4 doesn't need this layer.
F5 webhook → side-effect → must dedupe.

### 1.3 Permanent vs transient HTTP status

After the use-case `await`:

| `result.error.code` | HTTP status | Stripe retries? |
| --- | --- | --- |
| `unsupported_event_type` | `200 ignored` | No (treated as ack) |
| `invalid_payload` | `400` | No |
| `payment_not_found` | `200 ignored` | No (event raced ahead of our DB) |
| Any other error | `500` | Yes (assumed transient) |

F4's blanket `500 internal_error` would cause permanent errors to
loop on Stripe's retry queue.

## 2. Comment convention — drop the round-ID archaeology

F4 accumulated ~91 `R[0-9]+-X` markers across 31 source files over
ten review rounds (R3-H1, R4-UX-NB2, R5-REL-M1, R7-M2, R8-M-rel-2,
etc.). R10 swept the most-visible ones but the pattern is
self-reproducing: every fix labels itself with a round prefix that
becomes archaeology by the next round.

**Rule for F5 (and beyond):** Round IDs belong in **commit messages
+ retrospective.md + git blame**, NEVER in source comments. The
*WHY* explanation goes in source; the *WHO/WHEN* attribution goes
in git history. If a comment needs a round prefix to be meaningful,
the WHY isn't strong enough — strengthen the WHY instead.

Add this rule to `specs/009-online-payment/tasks.md` § "Comment
Discipline" before the first /speckit.implement runs. Reviewers
flag any `R[0-9]+-` prefix in F5 source as a correction-needed
finding.

## 3. Cron route pattern — already established by F4

F4's cron routes (`outbox-dispatch`, `receipt-pdf-reconcile`) use:

```ts
- Bearer auth via env.cronSecret (constant-time compare)
- tenantId from request body OR derived from row (NOT trusted from header)
- pg_advisory_xact_lock(hashtextextended('namespace:'||tenantId||':'||id))
- pino structured logs with `cron: 'route-name'` tag
```

F5's planned cron coordinators (`stale-pending-count`,
`sweep-stale-pending-refunds`) MUST inherit this shape. Namespace
strings — disjoint per module:

| Module | Namespace | Examples |
|---|---|---|
| F4 invoicing | `invoicing:` | `invoicing:fy-2026:invoice` |
| F5 payments | `payments:` | `payments:t-swecham:inv-...` |
| F7 broadcasts | `broadcasts:` | `broadcasts:t-swecham:bc-...` |
| F8 renewals | `renewals:` | `renewals:t-swecham:cycle-...` |

Adding F5 namespaces to this table prevents cross-module advisory
lock collision.

## 4. `streamPdfFromBlob` helper — reuse when applicable

`src/lib/stream-pdf-from-blob.ts` (R10-S1) replaces ~210 lines of
duplicated fetch+stream+timeout boilerplate across F4's 6 PDF
routes. F5's planned Stripe receipt download (e.g.
`/api/portal/payments/[paymentId]/receipt/pdf` from the F5 spec)
should call this helper directly instead of re-paste — bug fixes
land in one place, the 15s timeout + Sentry-friendly log shape are
inherited for free.

If F5 has a different cache/CDN strategy (e.g. signed Stripe-hosted
receipt URLs the member fetches directly), this helper is
unnecessary — but then F5 must own the JSON-leak hardening
(R3-BUG1 + R7-B1 + R10-E1) on whichever proxy layer it does use.

## 5. Audit emit ordering — audit BEFORE side-effect

R8-M1 + R9-E1 established the pattern for F4 PDF downloads:

```ts
// 1. ownership check (cheap; can fail → no side effect committed)
// 2. await audit.emit(...);                  // ← durable forensic trail
// 3. await blob.signDownloadUrl(...);         // ← the side-effect
// 4. return ok({ url, ... });
```

The audit emit happens BEFORE the side-effect so a failed audit
aborts the side-effect entirely (forensic safety: never serve bytes
whose access cannot be reconstructed). The R8 migration 0147
incident proved this matters in practice — when the enum value
wasn't in DB, the audit threw, the side-effect was skipped, and
the user saw a clean 500 instead of an audit-less download.

F5's `record-payment-success` use-case should follow the same
ordering for `payment_succeeded` audit + Stripe charge metadata
read. F5's webhook handler should NOT — webhook idempotency means
the audit row may already exist from a prior attempt.

## 6. `tenant_invoice_settings.upsert` partial-patch bug (R10-DEBUG)

While diagnosing R10-T5, the F4 settings upsert was found to fail
silently in production on **any partial settings patch** (e.g.
admin toggling auto-email, flipping a single prefix) because the
INSERT-side `DEFAULT` for `vat_rate NOT NULL` (no DB default) is
evaluated BEFORE the ON CONFLICT branch fires.

Fixed in `drizzle-tenant-settings-repo.ts:upsert` by branching on
row existence (UPDATE if exists; INSERT if not). The settings-form
UI happens to always send a full payload so the bug never reached
a user — but the F5 settings analogue (`tenant_payment_settings`
toggle for `online_payment_enabled`) MUST verify its repo's upsert
pattern doesn't have the same issue. Run a partial-patch
integration test before F5 ship.
