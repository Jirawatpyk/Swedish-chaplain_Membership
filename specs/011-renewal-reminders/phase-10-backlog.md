# F8 Phase 10 Polish Backlog

Items deferred from F8 Phase 2 implementation. Tracked here so they don't fall off the radar between Wave G ship and the dedicated Phase 10 polish sweep.

## RLS+FORCE legacy gaps (from Wave C-7 / `pnpm check:multi-tenant`)

Surfaced by the readiness check at `scripts/check-multi-tenant-ready.ts` LEGACY_KNOWN_GAPS list. Each entry below is a real schema gap that predates F8 work.

### ~~`email_change_tokens` (F3) — RLS missing~~ ✅ RESOLVED 2026-05-04

- **Resolved**: migration `0097_f8_phase10_a_email_change_tokens_rls.sql` (Phase 10 batch A).
- ENABLE + FORCE + `tenant_isolation_on_email_change_tokens` policy USING + WITH CHECK on `app.current_tenant`. Pure schema add — zero rows mutated. Promoted to `SCOPED_TABLES` in the readiness check.

### ~~`notifications_outbox` (F4) — RLS missing + 10 orphan NULL-tenant rows~~ ✅ RESOLVED 2026-05-04

- **Resolved**: migration `0098_f8_phase10_a_notifications_outbox_rls.sql` (Phase 10 batch A).
  1. DELETE'd the 10 pre-launch dev orphan rows.
  2. ALTER COLUMN `tenant_id` SET NOT NULL.
  3. ENABLE + FORCE + tenant-isolation policy.
- Application code unchanged — the dispatcher cron + outbox-enqueue use-cases all pass tenantId via `runInTenant(ctx, ...)` already, so the migration was pure defence-in-depth. Promoted to `SCOPED_TABLES`.

### `processor_events` (F5) — 53 orphan NULL-tenant rows

- **Symptom**: RLS already enabled (verified during readiness audit) but 53 rows have `tenant_id IS NULL`.
- **Risk**: webhook event log carrying orphan rows could affect F5 reconcile cron behaviour if the cron filters by tenant.
- **Fix**: Audit each row's `processor_payment_intent_id` against `payments` table; backfill `tenant_id` from the linked payment. Drop rows that have no linkable payment.
- **Effort**: ~1-2 hours including data analysis.

### `audit_log` — 53,227 NULL-tenant rows

- **Status**: NOT a gap — F1 design intentionally permits global audit events (e.g. `account_created` for cross-tenant admin users). Listed in LEGACY_KNOWN_GAPS for visibility only. **No action needed**; document the intent in the readiness script's triage notes (already there) and remove from LEGACY list when consensus on "audit_log is global by design" is recorded in the constitution.

---

## CONCURRENTLY-add indexes (Wave C / T027)

- **Status**: F8 inlined every index in its migrations per F7 precedent. If any specific F8 hot-path index later proves to need online-add (i.e. would block a tx for an unacceptable duration), it would migrate into a `drizzle/post-migrations/` directory created at that time.
- **Likelihood**: low — F8 indexes are small (per-tenant scope, partial WHERE clauses).
- **Trigger**: production query latency regression on a specific index, OR a future-feature that adds an index expected to scan >100k rows.

---

## Drizzle pgEnum drift — F7 audit values (verify-run G2)

- **Symptom**: F7 broadcasts module emits ~40+ audit event types via runtime `text()` insertion. The Drizzle TypeScript pgEnum array at `src/modules/auth/infrastructure/db/schema.ts:45` does NOT list any F7 events — meaning F7's audit-adapter doesn't get compile-time enum-literal validation for its own event types.
- **Risk**: if a F7 emit site typos an event-type string (e.g. `'broadcast_send_starteed'`), Drizzle accepts it (as `string`) and Postgres rejects at INSERT-time with a runtime error that's hard to attribute. Compile-time enum union would catch typos at build.
- **Fix**: bulk-paste the F7 audit event catalogue from `src/modules/broadcasts/application/ports/audit-port.ts` into the Drizzle `auditEventTypeEnum` array, alphabetised for diffing.
- **Effort**: ~30 min including audit-trail verification that DB enum has the corresponding values from the F7 migration batch (0070-0083).
- **Priority**: low — F7 ships dark; emit sites are well-tested.

---

## Wave-internal deferrals (F8-only)

### F2 audit emit wiring on `scheduleNextRenewalPlanChange` (Wave B G1 / Wave C-8 T029c)

- **Status**: Wave C-8 shipped 4 audit event types + payload schemas + summariseEvent cases for the F2 plan-change lifecycle. Wave G composition root shipped WITHOUT wiring `recordAuditEvent` into `scheduleNextRenewalPlanChange` — the use-case still doesn't emit. **Re-targeted from Wave G to Phase 5+** at Phase 2 final verify-run C1 (2026-05-04): the audit emit naturally co-lands with the F4 invoice-paid hook + tier-upgrade-accepted use-case in Phase 5 US5 (T183-T188 cluster) since those are the call sites that drive the lifecycle (`schedule` from accept-tier-upgrade, `apply` from F4 hook, `supersede` from F2 manual change listener, `cancel` from explicit admin cancel). Implementing the emit in isolation now would leave it dead until Phase 5+ anyway.
- **Pinning**: contract test `tests/contract/f2-plan-change-audit-payloads.contract.test.ts` exercises all 4 zod schemas + 1 negative case so the schema shapes can't bit-rot between Wave C-8 and Phase 5+ wiring.
- **Trigger**: Phase 5 US5 — first user-story phase to invoke `scheduleNextRenewalPlanChange` from a route handler.

### F8 module Domain + Application + Adapter implementation (Waves D-G)

- **Status**: Wave C delivers DB schema only. Domain entities + value objects (Wave D), Application ports (Wave E), cross-tenant integration test (Wave F), composition root (Wave G) are scheduled separately.
- **Trigger**: explicit "/speckit.implement Wave D" / E / F / G commands.

### F4 throwaway-tenant E2E infra (T115t)

- **Status**: deferred from F4 phase 10 per CLAUDE.md — would require Postgres branch-per-test or per-test-tenant schema isolation. Not blocking F8 work.

---

## Triage policy

When a Phase 10 polish sweep is scheduled:

1. Open this file as the canonical backlog.
2. Group items by feature (F1/F3/F4/F5/F7) so each can ship as its own small migration.
3. Each fix lands as a separate migration (`drizzle/migrations/01xx_phase_10_*.sql`) + a sentinel addition or removal from `scripts/check-multi-tenant-ready.ts` LEGACY_KNOWN_GAPS list.
4. Re-run `pnpm check:multi-tenant` after each fix; the 4-gap warning shrinks accordingly.
5. When the LEGACY_KNOWN_GAPS list reaches zero (or only carries `audit_log` design exception), close this backlog file by moving it to `specs/011-renewal-reminders/archived/phase-10-backlog-resolved.md`.
