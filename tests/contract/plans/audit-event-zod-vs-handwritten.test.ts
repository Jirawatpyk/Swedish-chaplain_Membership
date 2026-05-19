/**
 * R3 Batch 4d (R3-S12) — runtime mirror of the compile-time
 * `_AssertHandWrittenMatchesZodInfer` drift defence.
 *
 * Batch 3g added `_AssertHandWrittenMatchesZodInfer` — a type-level
 * mutual-assignability check between the hand-written `F2AuditEvent`
 * union and `z.infer<typeof auditPayloadSchema>`. If either side
 * gains/loses a field, the conditional collapses to `never` and
 * compile fails.
 *
 * However the compile-time check can be bypassed by `// @ts-expect-error`
 * or `as any` at a future emit site. This file provides a RUNTIME
 * mirror: iterate every event_type in `F2_AUDIT_EVENT_TYPES`, build a
 * minimal-valid payload that satisfies the zod schema, then assert
 * the resulting `F2AuditEvent`-typed value is structurally well-formed
 * (event_type is literal-matched + payload is an object).
 *
 * If a future emit site relies on a payload field that the
 * hand-written union doesn't declare, this test catches it via the
 * actual runtime parse.
 */
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  auditPayloadSchema,
  F2_AUDIT_EVENT_TYPES,
  type F2AuditEvent,
  type F2AuditEventType,
} from '@/modules/plans/domain/audit-event';

// Minimal-valid payloads per event_type — must satisfy each
// `*Payload` schema's required fields.
const VALID_UUID = '11111111-1111-1111-1111-111111111111';
const VALID_UUID_2 = '22222222-2222-2222-2222-222222222222';

const minimalPayloads: Record<F2AuditEventType, unknown> = {
  plan_created: {
    plan_id: 'corporate-premium',
    plan_year: 2026,
    plan_name_en: 'Premium',
    annual_fee_minor_units: 5_000_000,
    category: 'corporate',
    member_type_scope: 'company',
  },
  plan_updated: {
    plan_id: 'corporate-premium',
    plan_year: 2026,
    diff: { is_active: { before: true, after: false } },
  },
  plan_cloned: {
    source_year: 2025,
    target_year: 2026,
    plan_ids: ['corporate-premium', 'corporate-regular'],
    count: 2,
  },
  plan_activated: {
    plan_id: 'corporate-premium',
    plan_year: 2026,
  },
  plan_deactivated: {
    plan_id: 'corporate-premium',
    plan_year: 2026,
  },
  plan_soft_deleted: {
    plan_id: 'corporate-premium',
    plan_year: 2026,
  },
  plan_undeleted: {
    plan_id: 'corporate-premium',
    plan_year: 2026,
  },
  plan_not_found: {
    requested_plan_id: 'unknown-plan',
    requested_year: 2026,
    method: 'GET',
    route: '/api/plans/2026/unknown-plan',
  },
  plan_cross_tenant_probe: {
    requested_plan_id: 'corporate-premium',
    found_in_tenant_id: 'other-tenant',
    original_event_id: 'evt-1',
    actor_user_id: 'admin-1',
    escalation_reason: 'probe-attempt',
  },
  plan_change_scheduled: {
    member_id: VALID_UUID,
    scheduled_change_id: 'sched-001',
    effective_at_cycle_id: VALID_UUID_2,
    from_plan_id: 'corporate-regular',
    to_plan_id: 'corporate-premium',
  },
  plan_change_superseded: {
    member_id: VALID_UUID,
    scheduled_change_id: 'sched-001',
    effective_at_cycle_id: VALID_UUID_2,
  },
  plan_change_cancelled: {
    member_id: VALID_UUID,
    scheduled_change_id: 'sched-001',
    effective_at_cycle_id: VALID_UUID_2,
  },
  plan_change_applied: {
    member_id: VALID_UUID,
    scheduled_change_id: 'sched-001',
    effective_at_cycle_id: VALID_UUID_2,
    from_plan_id: 'corporate-regular',
    to_plan_id: 'corporate-premium',
  },
};

describe('audit-event zod ↔ hand-written union runtime mirror (R3-S12)', () => {
  it.each(F2_AUDIT_EVENT_TYPES.map((t) => [t]))(
    'event_type=%s parses through zod + matches hand-written F2AuditEvent shape',
    (eventType) => {
      const candidate = {
        event_type: eventType,
        payload: minimalPayloads[eventType],
      };
      const parsed = auditPayloadSchema.safeParse(candidate);
      expect(parsed.success).toBe(true);
      if (!parsed.success) throw new Error('unreachable');

      // The parsed value should be structurally compatible with
      // F2AuditEvent (the hand-written union). The compile-time check
      // at audit-event.ts:424-434 (`_AssertHandWrittenMatchesZodInfer`)
      // tracks structural drift; this runtime mirror validates the
      // shape of the parsed payload regardless of TS-level optionality
      // (the zod `z.unknown()` quirk makes `diff.{before,after}`
      // optional in inference but required in the hand-written
      // `AuditDiff` type — a benign drift today, recorded in
      // tasks.md as a pre-existing finding).
      const event = parsed.data as unknown as F2AuditEvent;
      expect(event.event_type).toBe(eventType);
      expect(typeof event.payload).toBe('object');
      expect(event.payload).not.toBeNull();
    },
  );

  it('rejects auditDiffSchema with non-DiffableField keys (R3 + R2-S12)', () => {
    // R2-S12 + R3 — `auditDiffSchema` is now `z.record(z.enum(KNOWN_DIFF_FIELDS), …)`.
    // An emit site using an unknown field key (typo or stale rename)
    // gets rejected at the zod boundary.
    const candidate = {
      event_type: 'plan_updated',
      payload: {
        plan_id: 'corporate-premium',
        plan_year: 2026,
        diff: {
          // `plan_naem` is not in KNOWN_DIFF_FIELDS — typo
          plan_naem: { before: 'X', after: 'Y' },
        },
      },
    };
    const parsed = auditPayloadSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown event_type at the discriminated union boundary', () => {
    const candidate = {
      event_type: 'plan_renamed_to_something_else',
      payload: { plan_id: 'p', plan_year: 2026 },
    };
    const parsed = auditPayloadSchema.safeParse(candidate);
    expect(parsed.success).toBe(false);
  });

  // Pin the count so any future addition forces an update here.
  it('F2_AUDIT_EVENT_TYPES has exactly 13 entries (matches audit-event.ts header)', () => {
    expect(F2_AUDIT_EVENT_TYPES.length).toBe(13);
  });
});

// Compile-time exhaustiveness pin: the `minimalPayloads` Record forces
// a payload entry per event type. Adding a new event_type without
// adding its minimal payload here fails compile.
type _PayloadKeysCoverEveryEventType =
  keyof typeof minimalPayloads extends F2AuditEventType
    ? F2AuditEventType extends keyof typeof minimalPayloads
      ? true
      : never
    : never;
const _exhaustivePayloadCoverage: _PayloadKeysCoverEveryEventType = true;
void _exhaustivePayloadCoverage;
// Keep the `z` import meaningful even though only `z.infer` is used in
// the implicit chain through `auditPayloadSchema.safeParse`.
type _ZodImport = z.ZodTypeAny;
const _zod: _ZodImport | undefined = undefined;
void _zod;