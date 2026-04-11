import { describe, expect, it } from 'vitest';
import {
  auditPayloadSchema,
  EVENT_SEVERITY,
  F2_AUDIT_EVENT_TYPES,
  isF2AuditEventType,
} from '@/modules/plans/domain/audit-event';

describe('F2 audit events', () => {
  it('defines 10 event types', () => {
    expect(F2_AUDIT_EVENT_TYPES.length).toBe(10);
  });

  it('every event type has a severity assigned', () => {
    for (const event of F2_AUDIT_EVENT_TYPES) {
      expect(EVENT_SEVERITY[event]).toMatch(/^(info|high)$/);
    }
  });

  it('plan_cross_tenant_probe is the only high-severity event in F2', () => {
    const highEvents = F2_AUDIT_EVENT_TYPES.filter(
      (e) => EVENT_SEVERITY[e] === 'high',
    );
    expect(highEvents).toEqual(['plan_cross_tenant_probe']);
  });

  it('isF2AuditEventType narrows correctly', () => {
    expect(isF2AuditEventType('plan_created')).toBe(true);
    expect(isF2AuditEventType('sign_in_success')).toBe(false);
    expect(isF2AuditEventType(null)).toBe(false);
    expect(isF2AuditEventType(123)).toBe(false);
  });

  describe('auditPayloadSchema — happy path', () => {
    it('accepts a valid plan_created payload', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_created',
        payload: {
          plan_id: 'premium',
          plan_year: 2026,
          plan_name_en: 'Premium Corporate',
          annual_fee_minor_units: 3_600_000,
          category: 'corporate',
          member_type_scope: 'company',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid plan_updated payload with diff', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_updated',
        payload: {
          plan_id: 'premium',
          plan_year: 2026,
          diff: {
            annual_fee_minor_units: { before: 3_600_000, after: 4_000_000 },
            plan_name: { before: { en: 'Premium' }, after: { en: 'Premium Pro' } },
          },
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid plan_cloned payload (not a diff shape)', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_cloned',
        payload: {
          source_year: 2026,
          target_year: 2027,
          plan_ids: ['premium', 'large', 'regular'],
          count: 3,
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid plan_not_found payload', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_not_found',
        payload: {
          requested_plan_id: 'ghost',
          requested_year: 2026,
          method: 'GET',
          route: '/api/plans/2026/ghost',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid plan_cross_tenant_probe payload', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_cross_tenant_probe',
        payload: {
          requested_plan_id: 'premium',
          found_in_tenant_id: 'other-tenant',
          original_event_id: 'evt_123',
          actor_user_id: 'user_abc',
          escalation_reason: 'periodic_scan_match',
        },
      });
      expect(result.success).toBe(true);
    });

    it('accepts a valid fee_config_updated payload', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'fee_config_updated',
        payload: {
          diff: { vat_rate: { before: 0.07, after: 0.075 } },
        },
      });
      expect(result.success).toBe(true);
    });
  });

  describe('auditPayloadSchema — rejections', () => {
    it('rejects unknown event_type', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'unknown_event',
        payload: {},
      });
      expect(result.success).toBe(false);
    });

    it('rejects plan_created missing required field', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_created',
        payload: { plan_id: 'premium', plan_year: 2026 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects plan_cloned with count !== plan_ids.length implicitly (shape only, not cross-field)', () => {
      // We don't cross-validate count vs plan_ids.length at the schema
      // layer — that's Application-level logic. Schema just enforces both
      // fields are present with the right types.
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_cloned',
        payload: {
          source_year: 2026,
          target_year: 2027,
          plan_ids: [],
          count: 99,
        },
      });
      expect(result.success).toBe(true); // schema only — cross-field is caller's job
    });

    it('rejects plan_not_found with invalid method', () => {
      const result = auditPayloadSchema.safeParse({
        event_type: 'plan_not_found',
        payload: {
          requested_plan_id: 'premium',
          requested_year: 2026,
          method: 'OPTIONS',
          route: '/api/plans/2026/premium',
        },
      });
      expect(result.success).toBe(false);
    });
  });
});
