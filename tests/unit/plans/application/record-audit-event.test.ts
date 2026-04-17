import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { recordAuditEvent } from '@/modules/plans/application/record-audit-event';
import type { AuditPort, AuditContext } from '@/modules/plans/application/ports';
import type { F2AuditEvent } from '@/modules/plans/domain/audit-event';
import { asTenantContext } from '@/modules/tenants';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';

const tenant = asTenantContext('swecham');

const ctx: AuditContext = {
  tenant,
  actorUserId: 'actor-uuid',
  requestId: 'req-001',
  sourceIp: '10.0.0.1',
};

const validEvent: F2AuditEvent = {
  event_type: 'plan_created',
  payload: {
    plan_id: asPlanSlug('corporate-standard'),
    plan_year: asPlanYear(2026),
    plan_name_en: 'Corporate Standard',
    annual_fee_minor_units: 5_000_000,
    category: 'corporate',
    member_type_scope: 'company',
  },
};

function makeAudit(fail?: 'invalid_payload' | 'persist_failed'): AuditPort {
  return {
    record: vi.fn(async () => {
      if (fail === 'persist_failed') {
        return err({ type: 'persist_failed' as const, message: 'write error' });
      }
      if (fail === 'invalid_payload') {
        return err({ type: 'invalid_payload' as const, issues: ['bad field'] as readonly string[] });
      }
      return ok(undefined as void);
    }),
  } as unknown as AuditPort;
}

describe('recordAuditEvent', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns invalid_payload when event fails schema validation', async () => {
    const audit = makeAudit();
    // Pass structurally invalid event — empty object bypasses TS via cast
    const result = await recordAuditEvent(
      audit,
      ctx,
      {} as unknown as F2AuditEvent,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_payload');
      if (result.error.type === 'invalid_payload') {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    }
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('returns ok when event is valid and audit.record succeeds', async () => {
    const audit = makeAudit();
    const result = await recordAuditEvent(audit, ctx, validEvent);
    expect(result.ok).toBe(true);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('returns persist_failed from audit.record as-is', async () => {
    const audit = makeAudit('persist_failed');
    const result = await recordAuditEvent(audit, ctx, validEvent);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('persist_failed');
      if (result.error.type === 'persist_failed') expect(result.error.message).toBe('write error');
    }
  });

  it('forwards invalid_payload issues from audit.record', async () => {
    const audit = makeAudit('invalid_payload');
    const result = await recordAuditEvent(audit, ctx, validEvent);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.type).toBe('invalid_payload');
      if (result.error.type === 'invalid_payload') {
        expect(result.error.issues).toContain('bad field');
      }
    }
  });
});
