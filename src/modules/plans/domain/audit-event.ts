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
  'fee_config_updated',
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
  fee_config_updated: 'info',
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

export type AuditDiff = z.infer<typeof auditDiffSchema>;

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

const feeConfigUpdatedPayload = z.object({
  diff: auditDiffSchema,
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
  z.object({ event_type: z.literal('fee_config_updated'), payload: feeConfigUpdatedPayload }),
]);

export type F2AuditEvent = z.infer<typeof auditPayloadSchema>;

/** Narrow runtime check that a value is one of the 10 F2 event types. */
export function isF2AuditEventType(value: unknown): value is F2AuditEventType {
  return (
    typeof value === 'string' &&
    (F2_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}
