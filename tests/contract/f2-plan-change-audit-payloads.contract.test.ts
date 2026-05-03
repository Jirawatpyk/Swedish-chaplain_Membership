/**
 * E1 (F8 Phase 2 Wave C-8 verify-run remediation) — pin the 4 F2
 * `plan_change_*` audit payload schemas.
 *
 * Wave C-8 / T029c registered 4 new F2 audit event types with zod
 * payload schemas + summariseEvent cases, but emission from the
 * `scheduleNextRenewalPlanChange` use-case is intentionally deferred
 * to Wave G when composition root threads the F2 audit port into
 * `ScheduleNextRenewalPlanChangeDeps`. This contract test pins the
 * schemas as live code so a future refactor that drifts the shape
 * away from the data-model is caught at CI time, not at the Wave G
 * wiring step.
 *
 * Each contract:
 *   1. Construct the canonical payload literal for the event-type.
 *   2. Assert `auditPayloadSchema.safeParse({event_type, payload})`
 *      returns `{success: true}`.
 *   3. Mutate one required field to invalid + assert
 *      `safeParse(...).success === false` to prove the schema actually
 *      validates (positive AND negative case).
 */
import { describe, expect, it } from 'vitest';
import { auditPayloadSchema } from '@/modules/plans/domain/audit-event';

const MEMBER_ID = '00000000-0000-0000-0000-0000000000a1';
const CYCLE_ID = '00000000-0000-0000-0000-0000000000c1';
const SCHEDULED_CHANGE_ID = 'mem-1';
const INVOICE_ID = '00000000-0000-0000-0000-0000000000d1';

describe('Contract — F2 plan_change_* audit payload schemas (T029c)', () => {
  // ── plan_change_scheduled ──────────────────────────────────────────
  it('plan_change_scheduled — accepts the canonical payload + rejects malformed UUIDs', () => {
    const accept = auditPayloadSchema.safeParse({
      event_type: 'plan_change_scheduled',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        from_plan_id: 'corporate-regular',
        to_plan_id: 'corporate-premier',
        reason: 'tier upgrade accepted by member',
      },
    });
    expect(accept.success).toBe(true);

    const reject = auditPayloadSchema.safeParse({
      event_type: 'plan_change_scheduled',
      payload: {
        member_id: 'not-a-uuid',
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        from_plan_id: 'corporate-regular',
        to_plan_id: 'corporate-premier',
      },
    });
    expect(reject.success).toBe(false);
  });

  // ── plan_change_superseded ─────────────────────────────────────────
  it('plan_change_superseded — accepts canonical payload incl. nullable superseded_by', () => {
    const accept = auditPayloadSchema.safeParse({
      event_type: 'plan_change_superseded',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        superseded_by_scheduled_change_id: 'mem-2',
      },
    });
    expect(accept.success).toBe(true);

    // The superseded_by_* field is optional + nullable.
    const acceptNull = auditPayloadSchema.safeParse({
      event_type: 'plan_change_superseded',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
      },
    });
    expect(acceptNull.success).toBe(true);

    const reject = auditPayloadSchema.safeParse({
      event_type: 'plan_change_superseded',
      payload: {
        // missing required scheduled_change_id
        member_id: MEMBER_ID,
        effective_at_cycle_id: CYCLE_ID,
      },
    });
    expect(reject.success).toBe(false);
  });

  // ── plan_change_cancelled ──────────────────────────────────────────
  it('plan_change_cancelled — accepts canonical payload + enforces 500-char reason cap', () => {
    const accept = auditPayloadSchema.safeParse({
      event_type: 'plan_change_cancelled',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        reason: 'admin cancelled',
      },
    });
    expect(accept.success).toBe(true);

    // 501-char reason should fail the schema-level length cap.
    const reject = auditPayloadSchema.safeParse({
      event_type: 'plan_change_cancelled',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        reason: 'x'.repeat(501),
      },
    });
    expect(reject.success).toBe(false);
  });

  // ── plan_change_applied ────────────────────────────────────────────
  it('plan_change_applied — accepts canonical payload incl. nullable applied_at_invoice_id', () => {
    const accept = auditPayloadSchema.safeParse({
      event_type: 'plan_change_applied',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        from_plan_id: 'corporate-regular',
        to_plan_id: 'corporate-premier',
        applied_at_invoice_id: INVOICE_ID,
      },
    });
    expect(accept.success).toBe(true);

    // applied_at_invoice_id is optional + nullable (manual mark-paid path).
    const acceptNull = auditPayloadSchema.safeParse({
      event_type: 'plan_change_applied',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        from_plan_id: 'corporate-regular',
        to_plan_id: 'corporate-premier',
      },
    });
    expect(acceptNull.success).toBe(true);

    const reject = auditPayloadSchema.safeParse({
      event_type: 'plan_change_applied',
      payload: {
        // missing required to_plan_id
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        from_plan_id: 'corporate-regular',
      },
    });
    expect(reject.success).toBe(false);
  });

  // ── Discriminated-union sanity ────────────────────────────────────
  it('discriminated union — wrong event_type for payload shape is rejected', () => {
    // `plan_change_scheduled` payload submitted under `plan_change_applied`
    // event_type — the discriminated union must surface a mismatch.
    const reject = auditPayloadSchema.safeParse({
      event_type: 'plan_change_applied',
      payload: {
        member_id: MEMBER_ID,
        scheduled_change_id: SCHEDULED_CHANGE_ID,
        effective_at_cycle_id: CYCLE_ID,
        // Missing from_plan_id + to_plan_id required for `applied`.
      },
    });
    expect(reject.success).toBe(false);
  });
});
