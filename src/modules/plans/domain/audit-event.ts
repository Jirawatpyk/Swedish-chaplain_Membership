/**
 * F2 audit events — 10 new snake_case event types extending F1's
 * `audit_event_type` pgEnum.
 *
 * See data-model.md § 2.6 + § 2.6a for the normative payload shapes
 * and critique P9 for the single-source-of-truth zod schema design
 * (the audit writer and the integration test suite both run
 * `auditPayloadSchema.safeParse(...)` to guarantee they cannot drift
 * on shape).
 *
 * `severity` is **derived**, not stored — F1's audit_log table has no
 * `severity` column and adding one would mean backfilling 17 F1 event
 * types. Observability tooling queries `EVENT_SEVERITY[event_type]`
 * instead.
 *
 * Pure TypeScript + zod — zod IS allowed in Domain (it's a pure validator
 * lib with no runtime side effects and no framework coupling).
 */

import { z } from 'zod';

// --- Event type union ---------------------------------------------------------

export const F2_AUDIT_EVENT_TYPES = [
  'plan_created',
  'plan_updated',
  'plan_cloned',
  'plan_activated',
  'plan_deactivated',
  'plan_soft_deleted',
  'plan_undeleted',
  'plan_not_found',
  'plan_cross_tenant_probe',
  // NOTE: `fee_config_updated` was retired in R7/R8 consolidation
  // (migration 0029 dropped `tenant_fee_config`; F4 `tenant_invoice_settings`
  // is now authoritative). The pgEnum value remains in F1 schema as
  // legacy backward-compat for any historical audit rows. Removed from
  // this Domain union 2026-05-19 (post-ship R6 C5).
  // F8 Phase 2 Wave C T029c (migration 0095) — scheduled-plan-change
  // lifecycle audit trail. Wave B G1 verify-run remediation carry-over.
  // Emitted by the F2 scheduled-plan-change use-cases (Wave G+ when
  // composition root wires the audit emit hook into the use-cases
  // alongside the Drizzle adapter that ships per Phase 5+).
  'plan_change_scheduled',
  // `plan_change_superseded` — emitted by F8 `accept-tier-upgrade.ts`
  // after `supersedeAndInsertPendingAtomically` returns a non-null
  // `superseded` row (cross-module composition wired at F8 composition
  // root per post-ship R6 D2 — F8 deps inject F2's `planAuditAdapter`
  // via the public `@/modules/plans` barrel; Constitution III honoured
  // because composition roots may legitimately wire ports across
  // modules without coupling Application layers).
  'plan_change_superseded',
  // F2 R6 Batch 2c (D7) — `plan_change_cancelled` emitter is now
  // wired via `cancelScheduledPlanChange` use-case
  // (`application/cancel-scheduled-plan-change.ts`). Ready-to-call;
  // no API caller yet (future admin "cancel scheduled change" surface
  // or F8 auto-supersede flow wires the route at composition root).
  'plan_change_cancelled',
  // F2 R6 Batch 2d (D7) — `plan_change_applied` emitter is now wired
  // at the F8 invoice-paid callback (renewal-applier path) in
  // `src/modules/renewals/infrastructure/_lib/apply-tier-upgrade-on-
  // paid-callback.ts` — POST-tx, after F4+F8 in-tx state commits. The
  // F2 `scheduled_plan_changes` row is flipped from `pending` →
  // `applied` (the Phase 5+ deferred state-machine apply that
  // `apply-pending-tier-upgrade.ts` lines 13-25 explicitly called
  // out), then the audit row lands. Non-rollback on F2-emit failure:
  // F4+F8 state is committed by then; operator backfills from the
  // structured log.
  'plan_change_applied',
] as const;

export type F2AuditEventType = (typeof F2_AUDIT_EVENT_TYPES)[number];

// --- Derived severity lookup (critique — severity not stored) -----------------

export type AuditSeverity = 'info' | 'high';

export const EVENT_SEVERITY: Record<F2AuditEventType, AuditSeverity> = {
  plan_created: 'info',
  plan_updated: 'info',
  plan_cloned: 'info',
  plan_activated: 'info',
  plan_deactivated: 'info',
  plan_soft_deleted: 'info',
  plan_undeleted: 'info',
  plan_not_found: 'info',
  plan_cross_tenant_probe: 'high',
  // F8 Phase 2 Wave C T029c — scheduled-plan-change lifecycle.
  plan_change_scheduled: 'info',
  plan_change_superseded: 'info',
  plan_change_cancelled: 'info',
  plan_change_applied: 'info',
};

// --- Normative diff shape (critique P9) ---------------------------------------

/**
 * `{ [field]: { before, after } }` — only changed fields appear.
 * Create events have `before: null`; delete events have `after: null`.
 */
export const auditDiffSchema = z.record(
  z.string(),
  z.object({
    before: z.unknown(),
    after: z.unknown(),
  }),
);

/**
 * Immutable diff record — prevents post-construction mutation that
 * could cause the recorded audit event to diverge from the caller's
 * intent if the write is async-interleaved.
 *
 * Use `MutableAuditDiff` for construction, then widen to `AuditDiff`.
 */
export type AuditDiff = Readonly<
  Record<string, Readonly<{ before: unknown; after: unknown }>>
>;

/** Mutable builder type — use for constructing diffs, then assign to `AuditDiff`. */
export type MutableAuditDiff = Record<string, { before: unknown; after: unknown }>;

// --- Per-event payload schemas (single source of truth per data-model § 2.6) --

const planIdentifierSchema = z.object({
  plan_id: z.string().min(1).max(63),
  plan_year: z.number().int().min(2000).max(2100),
});

const planCreatedPayload = planIdentifierSchema.extend({
  plan_name_en: z.string().min(1),
  annual_fee_minor_units: z.number().int().nonnegative(),
  category: z.enum(['corporate', 'partnership']),
  member_type_scope: z.enum(['company', 'individual', 'both']),
});

const planUpdatedPayload = planIdentifierSchema.extend({
  diff: auditDiffSchema,
});

const planClonedPayload = z.object({
  source_year: z.number().int().min(2000).max(2100),
  target_year: z.number().int().min(2000).max(2100),
  plan_ids: z.array(z.string().min(1).max(63)),
  count: z.number().int().nonnegative(),
});

const planActivatedPayload = planIdentifierSchema.extend({
  diff: auditDiffSchema.optional(),
});

const planDeactivatedPayload = planIdentifierSchema.extend({
  diff: auditDiffSchema.optional(),
});

const planSoftDeletedPayload = planIdentifierSchema.extend({
  diff: auditDiffSchema.optional(),
});

const planUndeletedPayload = planIdentifierSchema.extend({
  diff: auditDiffSchema.optional(),
});

const planNotFoundPayload = z.object({
  requested_plan_id: z.string().min(1).max(63),
  requested_year: z.number().int().min(2000).max(2100),
  method: z.enum(['GET', 'PATCH', 'DELETE', 'POST']),
  route: z.string().min(1).max(500),
});

const planCrossTenantProbePayload = z.object({
  requested_plan_id: z.string().min(1).max(63),
  found_in_tenant_id: z.string().min(1).max(63),
  original_event_id: z.string().min(1),
  actor_user_id: z.string().min(1),
  escalation_reason: z.string().min(1).max(500),
});

// --- F8 Phase 2 Wave C T029c — scheduled-plan-change lifecycle payloads ---

const planChangeScheduledPayload = z.object({
  member_id: z.string().uuid(),
  scheduled_change_id: z.string().min(1),
  effective_at_cycle_id: z.string().uuid(),
  from_plan_id: z.string().min(1),
  to_plan_id: z.string().min(1),
  reason: z.string().max(500).nullable().optional(),
});

const planChangeSupersededPayload = z.object({
  member_id: z.string().uuid(),
  scheduled_change_id: z.string().min(1),
  effective_at_cycle_id: z.string().uuid(),
  superseded_by_scheduled_change_id: z.string().min(1).nullable().optional(),
});

const planChangeCancelledPayload = z.object({
  member_id: z.string().uuid(),
  scheduled_change_id: z.string().min(1),
  effective_at_cycle_id: z.string().uuid(),
  reason: z.string().max(500).nullable().optional(),
});

const planChangeAppliedPayload = z.object({
  member_id: z.string().uuid(),
  scheduled_change_id: z.string().min(1),
  effective_at_cycle_id: z.string().uuid(),
  from_plan_id: z.string().min(1),
  to_plan_id: z.string().min(1),
  applied_at_invoice_id: z.string().uuid().nullable().optional(),
});

// --- Discriminated-union top-level audit-payload schema ----------------------

/**
 * The normative audit-payload schema — a discriminated union over
 * `event_type` + `payload`. Both the audit writer
 * (`record-audit-event.ts`) and the integration test suite
 * (`tests/integration/plans/audit-diff.test.ts`) import and use the
 * same schema, so they cannot drift.
 */
export const auditPayloadSchema = z.discriminatedUnion('event_type', [
  z.object({ event_type: z.literal('plan_created'), payload: planCreatedPayload }),
  z.object({ event_type: z.literal('plan_updated'), payload: planUpdatedPayload }),
  z.object({ event_type: z.literal('plan_cloned'), payload: planClonedPayload }),
  z.object({ event_type: z.literal('plan_activated'), payload: planActivatedPayload }),
  z.object({ event_type: z.literal('plan_deactivated'), payload: planDeactivatedPayload }),
  z.object({ event_type: z.literal('plan_soft_deleted'), payload: planSoftDeletedPayload }),
  z.object({ event_type: z.literal('plan_undeleted'), payload: planUndeletedPayload }),
  z.object({ event_type: z.literal('plan_not_found'), payload: planNotFoundPayload }),
  z.object({
    event_type: z.literal('plan_cross_tenant_probe'),
    payload: planCrossTenantProbePayload,
  }),
  // F8 Phase 2 Wave C T029c.
  z.object({
    event_type: z.literal('plan_change_scheduled'),
    payload: planChangeScheduledPayload,
  }),
  z.object({
    event_type: z.literal('plan_change_superseded'),
    payload: planChangeSupersededPayload,
  }),
  z.object({
    event_type: z.literal('plan_change_cancelled'),
    payload: planChangeCancelledPayload,
  }),
  z.object({
    event_type: z.literal('plan_change_applied'),
    payload: planChangeAppliedPayload,
  }),
]);

export type F2AuditEvent = z.infer<typeof auditPayloadSchema>;

/** Narrow runtime check that a value is one of the 10 F2 event types. */
export function isF2AuditEventType(value: unknown): value is F2AuditEventType {
  return (
    typeof value === 'string' &&
    (F2_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}
