# Contract: Batch Dispatch (US1)

**Spec FRs**: FR-001..008c · **Clarifications**: round-1 Q1, round-2 Q1 · **Use-cases**: `splitBroadcastIntoBatches`, `dispatchBroadcastBatch`, `retryFailedBatches`, `acceptPartialDelivery`

---

## 1. Server actions

### 1.1 `splitBroadcastIntoBatches(broadcastId)` — internal, invoked by dispatcher cron

**Auth**: System (cron-job.org Bearer auth via `CRON_SECRET`).
**Input** (zod):
```typescript
const Input = z.object({
  tenantId: z.string().uuid(),
  broadcastId: z.string().uuid(),
  resolvedRecipientCount: z.number().int().min(1).max(50000),
});
```
**Output**: `Promise<Result<{ batchManifestIds: string[]; batchCount: number }, BroadcastError>>`.
**Audit events emitted**: `broadcast_dispatched_in_batches` (one event per call carrying total batch count + per-batch recipient ranges).
**RBAC**: N/A (system call).
**Tenant invariant**: `runInTenant(ctx, fn)` wraps every DB write; cross-tenant probe test asserts a tenant A broadcast cannot trigger batch creation in tenant B's namespace.
**Contract test**: `tests/contract/broadcasts/batch-dispatch.test.ts` covers (a) 5k recipients → 1 batch (still uses batched path for uniformity); (b) 25k recipients → 3 batches of 10k/10k/5k; (c) 50k → 5 batches of 10k each; (d) idempotency key collision rejection.

### 1.2 `dispatchBroadcastBatch(batchManifestId)` — internal, invoked by dispatcher worker

**Auth**: System.
**Input**:
```typescript
const Input = z.object({
  tenantId: z.string().uuid(),
  batchManifestId: z.string().uuid(),
});
```
**Output**: `Promise<Result<{ providerAudienceId: string; recipientCount: number }, BroadcastError>>`.
**Audit events**: Implicit via Resend webhook → existing F7 MVP `broadcast_sent` event (per-batch info captured in event payload's `batchIndex` field).
**Concurrency**: Acquires `pg_advisory_xact_lock('broadcasts-batch:'||tenantId||':'||broadcastId||':'||batchIndex)` (research.md § 4); dispatcher service maintains a concurrency-cap-of-N semaphore (default 4, tenant-configurable 1-8).
**Contract test**: Concurrent dispatch of same batch from 2 workers → exactly 1 dispatches, other returns no-op via advisory lock + idempotency key.

### 1.3 `retryFailedBatches(broadcastId)` — admin server action

**Route**: `POST /api/admin/broadcasts/:id/retry`
**Auth**: admin role (RBAC enforced at server action boundary).
**Input**:
```typescript
const Input = z.object({
  broadcastId: z.string().uuid(),
});
```
**Output**: `Promise<Result<{ retryAttempt: number; retriedBatchCount: number }, BroadcastError>>` — `retryAttempt` is 1-3 (post-increment); `BroadcastError` includes `MANUAL_RETRY_BUDGET_EXHAUSTED` when budget hit.
**Audit events**: `broadcast_retry_initiated` (on call), `broadcast_retry_completed` (on all batches reaching terminal).
**Preconditions**: Broadcast must be in `partially_sent` state with `manual_retry_count < 3`.
**Contract test**: (a) Retry from `partially_sent` with budget remaining → succeeds + emits both events; (b) Retry from `partially_sent` with budget=3 exhausted → rejected with `MANUAL_RETRY_BUDGET_EXHAUSTED`; (c) Retry from `sent` (terminal) → rejected with `INVALID_STATE_TRANSITION`.

### 1.4 `acceptPartialDelivery(broadcastId, reason?)` — admin server action

**Route**: `POST /api/admin/broadcasts/:id/accept-partial`
**Auth**: admin role.
**Input**:
```typescript
const Input = z.object({
  broadcastId: z.string().uuid(),
  reason: z.string().max(500).optional(),
});
```
**Output**: `Promise<Result<{ acceptedAt: Date }, BroadcastError>>`.
**Audit event**: `broadcast_partial_delivery_accepted` (carries admin user_id + reason if provided).
**Preconditions**: Broadcast must be in `partially_sent` state.
**Post-condition**: State transitions to `partial_delivery_accepted` (terminal).
**Contract test**: (a) Accept from `partially_sent` → state transitions + audit event; (b) Subsequent retry attempt → rejected with `INVALID_STATE_TRANSITION`.

---

## 2. Error taxonomy

| Code | When | HTTP status (if API surface) |
|------|------|------------------------------|
| `MANUAL_RETRY_BUDGET_EXHAUSTED` | retryFailedBatches with manual_retry_count >= 3 | 409 |
| `INVALID_STATE_TRANSITION` | Action attempted from incompatible state | 409 |
| `BATCH_ALREADY_DISPATCHED` | Idempotency key collision (advisory lock held) | 409 |
| `BATCH_OVER_RECIPIENT_CAP` | Batch recipient_count > 10000 (Resend audience cap) | 400 (caller bug) |
| `BROADCAST_NOT_FOUND` | broadcastId resolves to no row (or RLS hides it) | 404 |
| `CROSS_TENANT_PROBE` | Tenant ctx mismatch with broadcast.tenant_id | 403 + audit event `broadcast_cross_tenant_probe` |

---

## 3. UI surface

- **Admin broadcast detail page** — adds collapsible per-batch breakdown (FR-006) below the consolidated roll-up; partial-failure state surfaces "Retry failed batches (X/3 remaining)" + "Accept partial delivery" actions
- **Admin broadcast list** — adds `partially_sent` filter chip + badge column
- **Member archive view** — unchanged (members see only consolidated counts per existing F7 MVP)

WCAG 2.1 AA verification: collapsible uses `<details>/<summary>`; retry button has confirmation modal with `aria-modal` + focus trap; SR-tested per SC-019.
