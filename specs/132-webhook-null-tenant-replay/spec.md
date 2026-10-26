# 132 — A replayed Stripe event whose first delivery had no tenant

**Size**: L by the table (money + tenancy on the live Stripe webhook path), built as one slice: two payments files plus docs, no migration, no flag.
**Status**: building on `132-webhook-null-tenant-replay`, 26 Oct 2026.
**Source**: finding L-1 of the `financial-integrity-reviewer` on PR #663 (spec 130 s7). It predates that PR. The maintainer kept #663 a pure predicate sweep and chose option (a), "adopt on replay", on 26 Oct 2026.

## Why

1. An event arrives for a Stripe account no tenant has registered. The route answers 200 and `insertRejectedProcessorEvent` writes a `processor_events` row with `tenant_id NULL`, `processed_at NULL`, `outcome 'acknowledged_only'`.
2. Later the account is registered, and someone replays the same event id from the Stripe dashboard.
3. `insertIfNew` hits ON CONFLICT. Its owner-role read sees `processed_at NULL`, so `processWebhookEvent` takes the recovery path and dispatches.
4. `markProcessed` runs as `chamber_app` and matches 0 rows: the SELECT policy of migration 0036 hides NULL-tenant rows from every tenant context. The row stays unstamped and NULL-tenant, and every further replay dispatches again.

No money moves twice (the sub-use-cases are idempotent: `lockForUpdate` + `canTransition`), and Stripe stops retrying on 2xx, so only manual replays reach this. But the idempotency log is wrong forever, the recovery-replay metric fires on every replay, and the event's work is never recorded as done.

The same loop opens for a `rejected_environment_mismatch` or `rejected_api_version_mismatch` row replayed after the config was corrected, since the replay then passes the route's gates.

## Premises checked against the code

- **Probe, Neon dev, 26 Oct 2026**: a NULL-tenant `acknowledged_only` row, then `repo.markProcessed` inside a real `runInTenant` → the row is unchanged; `UPDATE … SET tenant_id = 'swecham' WHERE id = $id AND tenant_id IS NULL RETURNING id` as `chamber_app` → 0 rows. The documented constraint holds: `chamber_app` cannot adopt the row. Policy change is rejected (it would show every rejection row to every tenant, Principle I).
- `insertIfNew` already runs on the owner connection (`db`, `neondb_owner`, BYPASSRLS), so an owner-role UPDATE there needs no new connection or role.
- The route reaches `processWebhookEvent` only after the signature, livemode and api-version gates have passed and `resolveTenantByProcessorAccountId` returned a tenant. A non-null `tenantId` at `insertIfNew` therefore means "this delivery passed every gate and its account belongs to this tenant".
- CHECK `processor_events_sig_reject_implies_null_tenant` forbids a tenant on a `rejected_signature` row, so that row must never be adopted.
- PR #663 (open) makes `markProcessed` / `updateOutcome` bind `tenant_id = tenantSlugOf(tx)`. An adopted row carries the resolved tenant, so it is compatible with that.

## Done when

1. **A replay adopts the row.** A NULL-tenant row with outcome `acknowledged_only`, `rejected_environment_mismatch` or `rejected_api_version_mismatch` is replayed by a delivery whose tenant resolved, with the same `processor_account_id` (or a row recorded with `''`: a platform-owner event from before the route's account fallback was configured) and `livemode`. `insertIfNew` sets `tenant_id` to the resolved tenant and `outcome` to `'processed'` in one owner-role UPDATE, and returns the adopted row. The dispatch then stamps `processed_at`. End state on Neon dev: `tenant_id` = the tenant, `processed_at` set, `received_at` and `correlation_id` still the first delivery's.
2. **A second replay is a duplicate.** After (1), the same event id again returns `{ kind: 'duplicate' }` and dispatches nothing.
3. **Rows that must not be adopted are not, and are not dispatched.** A NULL-tenant row that is `rejected_signature`, or whose `processor_account_id` or `livemode` differs from the delivery, keeps `tenant_id NULL`. `processWebhookEvent` does not dispatch any duplicate whose stored `tenant_id` is not the resolved tenant (NULL, or another tenant). It answers `{ kind: 'duplicate' }`, logs a warn, and counts it on a metric. So no replay can loop.
4. **Adoption is visible and durable.** Each adoption writes a `webhook_unresolved_event_adopted` audit row (10 y; event id, type, the outcome it replaced, the first delivery's `received_at` and correlation id; no account id), and is not counted as a crash recovery. It also logs `stripe-webhook.unresolved_row_adopted` with the event id, type, tenant and the outcome it replaced, and adds 1 to a counter with tenant and event-type labels. No payload content, no account id in the metric labels.
5. **Docs say what the code does.** The repo and port docstrings, `data-model.md` § 5.4 (the reality-check block and the `tenant_id` row), the `unprocessed-events-count` route docstring and `docs/changelog.md` describe adopt-on-replay. `docs/decisions.md` records it as a decision that revises the 2026-04-25 "never promoted" rule. Migration 0036's comment is on `main` and stays; the docs mark it historical.

## Out of scope

- Changing any RLS policy or the `outcome` CHECK.
- Replaying events automatically (a sweep that adopts old rows without a replay).
- Reconciling an event that was never replayed; that stays a manual operator task.

## Open questions

None.
