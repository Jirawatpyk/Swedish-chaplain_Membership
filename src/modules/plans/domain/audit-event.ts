/**
 * F2 audit events — 13 snake_case event types extending F1's
 * `audit_event_type` pgEnum (9 `plan_*` lifecycle + 4 `plan_change_*`
 * scheduled-plan-change lifecycle).
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
import type { Plan } from './plan';

// --- Event type union ---------------------------------------------------------

// Emit sites:
//   plan_{created,updated,cloned,activated,deactivated,soft_deleted,
//         undeleted,not_found,cross_tenant_probe}
//     → F2 Application use-cases under `src/modules/plans/application/**`
//   plan_change_scheduled / plan_change_superseded
//     → `src/modules/plans/application/schedule-next-renewal-plan-change.ts` +
//       `src/modules/renewals/application/use-cases/accept-tier-upgrade.ts` post-tx
//   plan_change_cancelled
//     → `src/modules/plans/application/cancel-scheduled-plan-change.ts`
//       (admin route at `src/app/api/admin/scheduled-plan-changes/[id]/cancel/route.ts`)
//   plan_change_applied
//     → `src/modules/renewals/infrastructure/_lib/apply-tier-upgrade-on-paid-callback.ts:_internal.finaliseF2ScheduledPlanChangeForCycle`
//       (post-tx, after F4 invoice-paid commits)
//
// `fee_config_updated` was retired in R7/R8 (migration 0029); the
// pgEnum value remains in F1 schema for historical rows but is NOT in
// this Domain union.
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
  'plan_change_scheduled',
  'plan_change_superseded',
  'plan_change_cancelled',
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
 * R2 Batch 3f (R2-S12) — typed enum of diffable Plan field names. A
 * typo like `'plan_naem'` in an emit site would otherwise log under
 * the wrong key + silently fail any downstream "diff keys must be
 * valid Plan field names" assertion. The `as const satisfies` chain
 * ties the runtime literal array to `keyof Plan` so a future Plan
 * field rename fails compile here.
 *
 * `tenant_id` + identity fields (`plan_id`, `plan_year`) are EXCLUDED
 * because they're immutable post-create — a diff entry referencing
 * them would be a bug.
 */
export const KNOWN_DIFF_FIELDS = [
  'plan_name',
  'description',
  'sort_order',
  'plan_category',
  'member_type_scope',
  'annual_fee_minor_units',
  'includes_corporate_plan_id',
  'min_turnover_minor_units',
  'max_turnover_minor_units',
  'max_duration_years',
  'max_member_age',
  'benefit_matrix',
  'is_active',
  'deleted_at',
  'updated_at',
  'updated_by',
] as const satisfies ReadonlyArray<keyof Plan>;

export type DiffableField = (typeof KNOWN_DIFF_FIELDS)[number];

/**
 * `{ [field]: { before, after } }` — only changed fields appear.
 * Create events have `before: null`; delete events have `after: null`.
 *
 * R2 Batch 3f (R2-S12) — keys constrained to `DiffableField`. Emit
 * sites that pass an unknown field name are rejected at the zod
 * boundary AND at the TypeScript level via the `AuditDiff` type
 * below.
 */
export const auditDiffSchema = z.record(
  z.enum(KNOWN_DIFF_FIELDS),
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
 * R2 Batch 3f (R2-S12) — keys constrained to `DiffableField`. Emit
 * sites that try to log under an arbitrary string key get a compile
 * error. `Partial<>` because not every field is in every diff (only
 * changed fields appear).
 *
 * Use `MutableAuditDiff` for construction, then widen to `AuditDiff`.
 */
export type AuditDiff = Readonly<
  Partial<Record<DiffableField, Readonly<{ before: unknown; after: unknown }>>>
>;

/** Mutable builder type — use for constructing diffs, then assign to `AuditDiff`. */
export type MutableAuditDiff = Partial<
  Record<DiffableField, { before: unknown; after: unknown }>
>;

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

/**
 * R2 Batch 3g (R2-S13) — hand-written discriminated union for
 * `F2AuditEvent`. Previously `F2AuditEvent = z.infer<typeof
 * auditPayloadSchema>` chained the Domain type to a specific zod
 * version forever (every consumer transitively imported zod). The
 * hand-written union below decouples Domain types from the runtime
 * validator: `auditPayloadSchema` validates HTTP-boundary input;
 * `F2AuditEvent` is the compile-time contract that propagates through
 * use-cases, ports, and adapters.
 *
 * **Drift defence**: the `_zodInferMatchesHandWritten` type-level
 * assertion below uses mutual structural assignability to fail
 * compilation if the hand-written union diverges from
 * `z.infer<typeof auditPayloadSchema>`. Any future payload-schema
 * change must update BOTH the zod schema (above) AND the hand-written
 * type (below) — TypeScript catches the drift instantly.
 */
export type F2AuditEvent =
  | {
      readonly event_type: 'plan_created';
      readonly payload: {
        readonly plan_id: string;
        readonly plan_year: number;
        readonly plan_name_en: string;
        readonly annual_fee_minor_units: number;
        readonly category: 'corporate' | 'partnership';
        readonly member_type_scope: 'company' | 'individual' | 'both';
      };
    }
  | {
      readonly event_type: 'plan_updated';
      readonly payload: {
        readonly plan_id: string;
        readonly plan_year: number;
        readonly diff: AuditDiff;
      };
    }
  | {
      readonly event_type: 'plan_cloned';
      readonly payload: {
        readonly source_year: number;
        readonly target_year: number;
        readonly plan_ids: ReadonlyArray<string>;
        readonly count: number;
      };
    }
  | {
      readonly event_type: 'plan_activated';
      readonly payload: {
        readonly plan_id: string;
        readonly plan_year: number;
        readonly diff?: AuditDiff;
      };
    }
  | {
      readonly event_type: 'plan_deactivated';
      readonly payload: {
        readonly plan_id: string;
        readonly plan_year: number;
        readonly diff?: AuditDiff;
      };
    }
  | {
      readonly event_type: 'plan_soft_deleted';
      readonly payload: {
        readonly plan_id: string;
        readonly plan_year: number;
        readonly diff?: AuditDiff;
      };
    }
  | {
      readonly event_type: 'plan_undeleted';
      readonly payload: {
        readonly plan_id: string;
        readonly plan_year: number;
        readonly diff?: AuditDiff;
      };
    }
  | {
      readonly event_type: 'plan_not_found';
      readonly payload: {
        readonly requested_plan_id: string;
        readonly requested_year: number;
        readonly method: 'GET' | 'PATCH' | 'DELETE' | 'POST';
        readonly route: string;
      };
    }
  | {
      readonly event_type: 'plan_cross_tenant_probe';
      readonly payload: {
        readonly requested_plan_id: string;
        readonly found_in_tenant_id: string;
        readonly original_event_id: string;
        readonly actor_user_id: string;
        readonly escalation_reason: string;
      };
    }
  | {
      readonly event_type: 'plan_change_scheduled';
      readonly payload: {
        readonly member_id: string;
        readonly scheduled_change_id: string;
        readonly effective_at_cycle_id: string;
        readonly from_plan_id: string;
        readonly to_plan_id: string;
        readonly reason?: string | null;
      };
    }
  | {
      readonly event_type: 'plan_change_superseded';
      readonly payload: {
        readonly member_id: string;
        readonly scheduled_change_id: string;
        readonly effective_at_cycle_id: string;
        readonly superseded_by_scheduled_change_id?: string | null;
      };
    }
  | {
      readonly event_type: 'plan_change_cancelled';
      readonly payload: {
        readonly member_id: string;
        readonly scheduled_change_id: string;
        readonly effective_at_cycle_id: string;
        readonly reason?: string | null;
      };
    }
  | {
      readonly event_type: 'plan_change_applied';
      readonly payload: {
        readonly member_id: string;
        readonly scheduled_change_id: string;
        readonly effective_at_cycle_id: string;
        readonly from_plan_id: string;
        readonly to_plan_id: string;
        readonly applied_at_invoice_id?: string | null;
      };
    };

// R2 Batch 3g (R2-S13) — compile-time drift defence. Mutual structural
// assignability between the hand-written union (above) and the
// zod-inferred type (below). If either diverges, this assertion fails
// compile and the maintainer must update BOTH.
type _ZodInfer = z.infer<typeof auditPayloadSchema>;
type _AssertHandWrittenMatchesZodInfer = F2AuditEvent extends _ZodInfer
  ? _ZodInfer extends F2AuditEvent
    ? true
    : never
  : never;

/** Narrow runtime check that a value is one of the 13 F2 event types. */
export function isF2AuditEventType(value: unknown): value is F2AuditEventType {
  return (
    typeof value === 'string' &&
    (F2_AUDIT_EVENT_TYPES as readonly string[]).includes(value)
  );
}
