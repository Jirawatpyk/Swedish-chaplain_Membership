/**
 * #739 B3b — a failed audit append returns `persist_failed` carrying the
 * error CLASS, never the driver's message (a constraint violation quotes the
 * row it refused).
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/logger', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import type { TenantTx } from '@/lib/db';
import { planAuditAdapter } from '@/modules/plans/infrastructure/audit/plan-audit-adapter';
import type { AuditContext } from '@/modules/plans/application/ports';
import type { F2AuditEvent } from '@/modules/plans/domain/audit-event';
import { asPlanSlug, asPlanYear } from '@/modules/plans/domain/plan';
import { asTenantContext } from '@/modules/tenants';

const ctx: AuditContext = {
  tenant: asTenantContext('swecham'),
  actorUserId: 'actor-uuid',
  requestId: 'req-001',
  sourceIp: '10.0.0.1',
};

const event: F2AuditEvent = {
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

describe('planAuditAdapter persist_failed', () => {
  it('carries the error class, never the driver text', async () => {
    const tx = {
      insert: () => ({
        values: async () => {
          throw new Error('duplicate key value violates unique constraint (email)=(a@b.example)');
        },
      }),
    } as unknown as TenantTx;

    const result = await planAuditAdapter.recordInTx(tx, ctx, event);

    expect(result).toEqual({ ok: false, error: { type: 'persist_failed', message: 'Error' } });
    if (!result.ok) expect(JSON.stringify(result.error)).not.toContain('@');
  });
});
