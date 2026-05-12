# Reliability Requirements Quality Checklist: F6 — EventCreate Integration

**Purpose**: Validate the **reliability + transactional + error-handling requirements** in spec.md, plan.md, research.md, data-model.md, and contracts/* are complete, clear, consistent, measurable, and ready for `/speckit.staff-review`.
**Created**: 2026-05-12
**Feature**: [Link to spec.md](../spec.md)
**Depth**: Formal Review Gate
**Scope**: Strict-transactional ingest (FR-037), idempotency, dual-write audit fallback, quota concurrency, cron reliability, refund/archive credit-back, error path coverage.

## Strict-Transactional Semantics (FR-037 — Constitution Principle VIII NON-NEGOTIABLE)

- [ ] CHK001 - Are the **6 state changes** comprising the ACID unit explicitly enumerated (event upsert + registration insert + idempotency receipt + partnership-quota decrement + cultural-quota decrement + refund-credit-back)? [Completeness, Spec §FR-037]
- [ ] CHK002 - Is the rollback-on-any-error requirement specified with HTTP 5xx return to Zapier (so retry happens)? [Clarity, Spec §FR-037]
- [ ] CHK003 - Are the failure-stage discriminator requirements specified for the `webhook_rolled_back` audit payload (event_upsert / registration_insert / idempotency_receipt / quota_decrement / audit_emit / unknown)? [Completeness, contracts/audit-port.md webhook_rolled_back payload]
- [ ] CHK004 - Is the "quota-drift impossible by construction" claim defensible because of the single-tx design (versus stored-counter drift class)? [Measurability, research.md R6]
- [ ] CHK005 - Are the canonical SQL execution-order requirements specified (BEGIN → SET LOCAL → advisory_lock → reads/inserts → audit → COMMIT)? [Clarity, research.md R5 round-2 R2]
- [ ] CHK006 - Is the requirement for `SET LOCAL app.current_tenant` to bind BEFORE advisory-lock acquisition specified to avoid wrong-tenant-context lock semantics? [Coverage, research.md R5]

## Idempotency

- [ ] CHK007 - Are the **two independent idempotency layers** specified — `X-Request-ID` (transport, 7-day TTL) + per-attendee `externalId` (domain, persistent)? [Coverage, Spec §FR-004 + §FR-011]
- [ ] CHK008 - Is the requirement that the idempotency receipt INSERT happen **inside** the strict-transactional ACID unit (not outside) specified to prevent the receipt-without-side-effects race? [Clarity, research.md R6 step 2]
- [ ] CHK009 - Are the requirements for the `eventcreate_idempotency_receipts` table (F6-owned, NOT F5 reuse) specified completely (composite PK, source CHECK, TTL column, RLS+FORCE)? [Completeness, data-model.md § 1.4]
- [ ] CHK010 - Is the duplicate-delivery response specified (HTTP 409 with `webhook_duplicate_rejected` audit; zero side effects)? [Clarity, contracts/webhook-eventcreate-api.md]
- [ ] CHK011 - Is the CSV row-hash idempotency key construction specified (`sha256(tenant_id || event_external_id || attendee_email_lower || registered_at)`)? [Clarity, contracts/csv-import-api.md]
- [ ] CHK012 - Are the requirements for `rowsAlreadyImported` count in CSV result summary specified (distinguishing "0 new + 1000 dupes" from "0 processed")? [Coverage, contracts/admin-events-api.md round-2 R3]

## Failed-Delivery Audit Fallback (Dual-Write)

- [ ] CHK013 - Are the `webhook_rolled_back` audit-emission requirements specified to live in a **separate post-rollback tx** (not the rolled-back primary tx)? [Coverage, research.md R6 round-1 E3]
- [ ] CHK014 - Is the stderr-fallback requirement specified (`pino.fatal` with `audit_secondary_tx_failure: true` discriminator) when the separate audit-tx also fails (DB fully unavailable)? [Coverage, research.md R6 round-1 E3, contracts/audit-port.md]
- [ ] CHK015 - Is the requirement that the stderr-fallback `pino.fatal` call be wrapped in try/catch specified (defence against stderr write failure)? [Edge Case, research.md R6]
- [ ] CHK016 - Are the requirements for Vercel Fluid Compute stderr-as-runtime-logs capture documented as the canonical observability fallback path? [Clarity, research.md R6]

## Quota Concurrency (Advisory Lock)

- [ ] CHK017 - Is the advisory-lock namespace specified disjoint from F4/F5/F7/F8 lock namespaces (`'eventcreate-quota:' || tenant_id || ':' || member_id || ':' || event_id`)? [Coverage, research.md R5]
- [ ] CHK018 - Are the quota computed-on-read requirements (no stored counter) consistent with the advisory-lock-around-decision pattern across research.md R5 + data-model.md § 8? [Consistency]
- [ ] CHK019 - Are the property-based test requirements specified for SC-004's zero-error promise (10 concurrent workers × 100 random schedules, assert `SUM(counted_against_*) ≤ allotment`)? [Measurability, plan.md Testing § + research.md R5]
- [ ] CHK020 - Is the quota-exhausted "over quota" outcome specified (FR-017: registration persisted with `counted_against_* = FALSE`, NOT rejected)? [Clarity, Spec §FR-017]

## Cron Reliability

- [ ] CHK021 - Are the **two** F6 cron handlers explicitly listed (pseudonymise-eventcreate + sweep-eventcreate-idempotency) with their cadence + Bearer-auth + multi-tenant iteration pattern? [Completeness, plan.md Technical approach round-3 Z5]
- [ ] CHK022 - Is the multi-tenant cron iteration strategy specified (single global URL → super-admin enumeration → `runInTenant` per tenant)? [Clarity, research.md R9 round-1 E18]
- [ ] CHK023 - Are the cron-job.org configuration requirements specified in quickstart.md with explicit URLs + schedules? [Completeness, quickstart.md § 2.3]
- [ ] CHK024 - Are TTL-sweep cron alerting requirements specified to detect silent-stall conditions (FR-036 alert #6 — `rate(eventcreate_idempotency_sweep_rows_total[2d]) == 0` while table growing)? [Coverage, Spec §FR-036 round-4 AA1]
- [ ] CHK025 - Are integration-test requirements specified for both cron handlers (retention-sweep + idempotency-ttl-sweep)? [Coverage, plan.md Testing § round-4 AA2]

## Refund / Archive Credit-Back Semantics

- [ ] CHK026 - Is the refund-credit-back requirement specified to update `payment_status = 'refunded'` AND reverse `counted_against_*` AND emit `quota_credit_back_refund` audit — all in the same tx? [Coverage, Spec §FR-018]
- [ ] CHK027 - Is the event-archive credit-back requirement specified to reverse all `counted_against_*` flags AND emit one `quota_credit_back_archive` audit per registration? [Coverage, Spec §FR-019a]
- [ ] CHK028 - Is the requirement that subsequent webhook deliveries to an archived event still upsert new registrations (but quota-neutral) specified? [Edge Case, Spec §FR-019a]
- [ ] CHK029 - Are the relink credit-back-and-recompute requirements specified (Member A's quota credited, Member B's quota re-evaluated) for FR-014? [Coverage, Spec §FR-014]

## Error Path Coverage (Constitution Principle VIII — Reliability)

- [ ] CHK030 - Are explicit requirements specified for behaviour when `tenant_webhook_configs` row is missing (vs. `enabled = FALSE` vs. wrong signature) — three distinct 401/503 responses? [Edge Case, plan.md round-1 E4]
- [ ] CHK031 - Are requirements specified for CSV import handler memory budget (E5: profile peak heap at 1k + 5k rows, fail-fast at 500 MiB)? [Coverage, plan.md Testing § round-1 E5]
- [ ] CHK032 - Are requirements specified for what happens when EventCreate-side delivers a payload missing a previously-set field (preserved-in-metadata vs. NULL-out)? [Edge Case, FR-011a + research.md R8 strict-on-required + permissive-on-unknown]
- [ ] CHK033 - Are requirements for the `webhook_test_invoked` short-circuit behaviour specified (sentinel external_id detection, no event/registration row created)? [Clarity, contracts/admin-integration-eventcreate-api.md round-2 P8]
- [ ] CHK034 - Are requirements for chaos / DB-unavailable-mid-tx test coverage specified (E14 — covers FR-037 + stderr fallback together)? [Coverage, plan.md Testing § round-1 E14]
- [ ] CHK035 - Is the requirement that the CSV import handler process bad rows row-by-row (not all-or-nothing) specified with per-row error reporting? [Clarity, Spec §FR-029, contracts/csv-import-api.md]

## Notes

- This checklist is the canonical reliability review gate for F6 per Constitution Principle VIII.
- "[Gap]" items require resolution before `/speckit.implement`. "[Ambiguity]" items can fold into `/speckit.tasks` decomposition.
- Reliability + Security checklists share Constitution Principle I (cross-tenant) + Principle VIII (data integrity) — both must pass at `/speckit.staff-review`.
