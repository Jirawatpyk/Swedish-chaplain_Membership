# Plan: 132 — adopt a NULL-tenant processor_events row on replay (L-1)

Spec: `specs/132-webhook-null-tenant-replay/spec.md`. Branch `132-webhook-null-tenant-replay` (this worktree, from `origin/main` 0a5091e57). One slice. No migration, no flag, no new dependency.

## Context

A Stripe event that first arrived for an unregistered account leaves a `processor_events` row with `tenant_id NULL`, `processed_at NULL`. When it is replayed after the account is registered, the dispatch runs but `markProcessed` (as `chamber_app`) matches 0 rows: the 0036 SELECT policy hides NULL-tenant rows. The probe on Neon dev confirmed it (26 Oct 2026). So every replay dispatches again and the log never records the work as done. The maintainer chose option (a): adopt the row on the owner connection when a replay arrives.

## Approach

1. **Repo, `insertIfNew` duplicate path** (`src/modules/payments/infrastructure/repos/drizzle-processor-events-repo.ts`). It already runs on the owner `db`. After the ON CONFLICT re-read, when `input.tenantId !== null` and the existing row has `tenantId === null`, run one owner-role UPDATE:
   `SET tenant_id = input.tenantId, outcome = 'processed' WHERE id = $id AND tenant_id IS NULL AND outcome IN ('acknowledged_only','rejected_environment_mismatch','rejected_api_version_mismatch') AND processor_account_id = input.processorAccountId AND livemode = input.livemode RETURNING *`.
   - 1 row → return `{ inserted: false, event: adopted, adoptedFrom: <old outcome> }`.
   - 0 rows (a predicate failed, or a concurrent replay adopted it first) → return the re-read row unchanged (re-read once more so a concurrent adopt is seen).
   - `outcome = 'processed'` matches what a fresh step-6 insert writes, so the existing recovery path, the default branch's `updateOutcome`, and the `unprocessed-events-count` gauge all behave as for a normal row. `received_at`, `correlation_id`, `payload_sha256` stay the first delivery's.
2. **Port** (`application/ports/processor-events-repo.ts`): the result gains an optional `adoptedFrom?: ProcessorEventOutcome`. Optional so no existing stub has to change; docstring rewritten.
3. **Use case** (`application/use-cases/process-webhook-event.ts`, step 6):
   - if `adoptedFrom` is set → `logger.info('stripe-webhook.unresolved_row_adopted', { eventId, eventType, tenantId, adoptedFrom })` + `paymentsMetrics.webhookUnresolvedRowAdopted(tenantId, type)`, then the existing recovery path (processed_at is NULL) dispatches.
   - **fail-closed backstop**: if not inserted and `inserted.event.tenantId !== tenantId` (still NULL, or another tenant) → do not dispatch; `logger.warn('stripe-webhook.duplicate_tenant_mismatch', { eventId, eventType, tenantId, storedTenant: 'null' | 'other' })` + `paymentsMetrics.webhookDuplicateTenantMismatch(tenantId, type)`; return `ok({ kind: 'duplicate' })`. This closes the loop for every row (a)'s predicate refuses (`rejected_signature`, account or livemode mismatch) and for an account that moved tenants. No account id in labels.
4. **Metrics** (`src/lib/metrics.ts`): two counters next to `webhookDispatchRecoveryReplay`: `payments_webhook_unresolved_row_adopted_total`, `payments_webhook_duplicate_tenant_mismatch_total`, labels `tenant`, `event_type`. Add both to `docs/observability.md` § payments metrics table.
5. **Docs**: repo + port docstrings; `specs/009-online-payment/data-model.md` § 5.4 reality-check block and the `tenant_id` row (~240), noting 0036's comment is historical; the `unprocessed-events-count` route docstring (acknowledged_only rows are no longer *permanently* NULL); `docs/decisions.md` new **D-031** "a replay adopts a NULL-tenant processor_events row on the owner connection" (revises the 2026-04-25 "never promoted" rule); `docs/changelog.md` line.

**Security (new owner-role write)**: the written tenant comes only from `resolveTenantByProcessorAccountId` (server-side lookup of the signature-verified event's account), never from the payload directly; the `processor_account_id` + `livemode` equality bounds adoption to the row's own account; `rejected_signature` is excluded (and the CHECK forbids it anyway); the backstop refuses to dispatch any mismatch. RLS is unchanged.

**Not taken**: (b) policy change (exposes every rejection row to every tenant); (c) refuse-only (event could never be applied); adopting only `acknowledged_only` (the env/api-version rows would keep looping — the backstop would stop the loop but leave them unprocessable after a config fix).

**Overlap with open PR #663**: it edits the same repo file (imports, factory docstring, `markProcessed`/`updateOutcome` get `tenant_id = tenantSlugOf(tx)`). The adopted row carries the resolved tenant, so both compose; whichever merges second rebases (a small import/docstring conflict).

## Test plan (RED commit first, then GREEN)

| Done-when | Test that goes red first |
|---|---|
| 1, 2 | **Integration** `tests/integration/payments/webhook-null-tenant-replay.test.ts` (new, live Neon dev, `createTwoTestTenants`, real `makeProcessWebhookEventDeps`): seed a NULL-tenant `acknowledged_only` row for account X; replay an unknown-type event (`customer.created`, default branch: `updateOutcome` + `markProcessed`, no money side effects) with tenant A → row has `tenant_id = A`, `processed_at` set, original `received_at`/`correlation_id`; replay again → `{ kind: 'duplicate' }`. Same for a `rejected_api_version_mismatch` row. RED today: tenant stays NULL, processed_at NULL, second call not duplicate. |
| 3 | Same file: a NULL row with a different `processor_account_id` → tenant stays NULL, result `duplicate`, no dispatch (processed_at NULL). Unit (`tests/unit/payments/application/process-webhook-event.test.ts`): duplicate stub with `tenantId: null` / another tenant and `processedAt: null` → `duplicate`, no sub-use-case called, mismatch metric called. |
| 1 (repo) | Integration in `processor-events-idempotency.test.ts`: `insertIfNew` with a tenant on an existing NULL `acknowledged_only` row returns `adoptedFrom: 'acknowledged_only'` and the adopted row; `rejected_signature` row is not adopted. |
| 4 | Unit: `adoptedFrom` set → adopted metric + info log called once with no account id. |
| 5 | Docs reviewed by the reviewers; no test. |

Cleanup: rows deleted in a `SET LOCAL ROLE neondb_owner` tx (as the existing idempotency test does), tenants via `tenant.cleanup()`. The temporary `zz-l1-probe.test.ts` is deleted before the first commit.

## Constitution Check

I tenancy: two layers kept; the owner write is bounded by account + NULL predicate, backstop refuses mismatches (security-engineer reviews). II TDD: RED commit then GREEN. III Clean Architecture: SQL stays in the repo, metrics/logs in the use case, port widened optionally. IV PCI: no card data touched; no payload in logs. V–X: no UI/i18n; observability adds two counters + docs; no dependency.

## Complexity Tracking

Solo-maintainer review for the payment surface: `/code-review high` + `financial-integrity-reviewer` + `security-engineer` (+ `pci-saqa-guardian` only if a reviewer judges it card-adjacent — webhook path, so I will run it). The five checks recorded in `plan.md` § Complexity Tracking.

## Verification

`pnpm check` → `pnpm test:coverage` → `pnpm vitest run tests/contract/` → `pnpm test:integration tests/integration/payments/webhook-null-tenant-replay.test.ts tests/integration/payments/processor-events-idempotency.test.ts tests/integration/payments/unprocessed-events-count.test.ts`. No UI, so no :3400 run; the integration test is the end-to-end proof (Done-when evidence goes in `plan.md` § Evidence). Then `/code-review high origin/main...HEAD`, the reviewers above, PR via the template, CI green. No merge.

## Rollout / Risks

Deploys with the merge; behaviour changes only for duplicate deliveries whose stored tenant is NULL or different. Risk: an operator replay now settles an invoice for a payment that arrived before the account was registered — that is the intended outcome; the adopt log + metric make it visible.
