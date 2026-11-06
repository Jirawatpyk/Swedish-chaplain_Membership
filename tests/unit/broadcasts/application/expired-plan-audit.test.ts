/**
 * Slice B (T171 / AS5) — `emitExpiredPlanAuditIfApplicable`, driven directly.
 *
 * Spec 140 s4 deleted the legacy dispatch suite, which was the only file that
 * drove this shared helper's arms (CI coverage on PR #756 read 16.66 % branch
 * against its 90 % pin). The import tick still calls it after a send; these
 * cases pin each arm on the helper itself: the plan read throws, the plan is
 * unchanged, the plan changed, the member is no longer entitled, and the audit
 * INSERT fails. Forensic only: no arm throws.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { err, ok } from '@/lib/result';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { emitExpiredPlanAuditIfApplicable } from '@/modules/broadcasts/application/use-cases/_expired-plan-audit';

const tenant = asTenantContext('test-tenant');
const BROADCAST = {
  broadcastId: '77777777-7777-4777-8777-777777777777',
  requestedByMemberId: 'member-1',
  requestedByMemberPlanIdSnapshot: 'plan-at-submit',
} as unknown as Broadcast;

function deps(lookup: () => Promise<unknown>, emit: (tx: unknown, e: unknown) => Promise<void> = async () => undefined) {
  const getPlanForMember = vi.fn(lookup);
  const auditEmit = vi.fn(emit);
  return {
    deps: { tenant, plansBridge: { getPlanForMember }, audit: { emit: auditEmit } } as never,
    getPlanForMember,
    auditEmit,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('emitExpiredPlanAuditIfApplicable', () => {
  it('the plan unchanged since submit writes nothing', async () => {
    const d = deps(async () => ok({ planId: 'plan-at-submit', planCode: 'gold', eblastPerYear: 4 }));
    await emitExpiredPlanAuditIfApplicable({ deps: d.deps, broadcast: BROADCAST });
    expect(d.getPlanForMember).toHaveBeenCalledWith(tenant, 'member-1');
    expect(d.auditEmit).not.toHaveBeenCalled();
  });

  it('a plan changed since submit writes the row with both plans and currentlyEntitled true', async () => {
    const d = deps(async () => ok({ planId: 'plan-now', planCode: 'silver', eblastPerYear: 2 }));
    await emitExpiredPlanAuditIfApplicable({ deps: d.deps, broadcast: BROADCAST });
    expect(d.auditEmit).toHaveBeenCalledTimes(1);
    const [tx, event] = d.auditEmit.mock.calls[0]! as [unknown, { eventType: string; actorUserId: string; payload: unknown }];
    expect(tx).toBeNull();
    expect(event.eventType).toBe('broadcast_sent_with_expired_member_plan');
    expect(event.actorUserId).toBe('system:cron');
    expect(event.payload).toEqual({
      broadcastId: BROADCAST.broadcastId,
      memberId: 'member-1',
      planAtSubmit: 'plan-at-submit',
      planAtDispatch: 'plan-now',
      planLookupError: null,
      currentlyEntitled: true,
    });
  });

  it('a member no longer entitled writes the row with the lookup error and currentlyEntitled false', async () => {
    const d = deps(async () => err({ kind: 'plan_lookup.member_no_plan', memberId: 'member-1' }));
    await emitExpiredPlanAuditIfApplicable({ deps: d.deps, broadcast: BROADCAST });
    expect(d.auditEmit).toHaveBeenCalledTimes(1);
    const [, event] = d.auditEmit.mock.calls[0]! as [unknown, { payload: unknown }];
    expect(event.payload).toMatchObject({
      planAtDispatch: null,
      planLookupError: 'plan_lookup.member_no_plan',
      currentlyEntitled: false,
    });
  });

  it('a plan read that throws is logged by class and writes nothing', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const d = deps(async () => {
      throw new TypeError('neon outage for member-1@example.com');
    });
    await expect(emitExpiredPlanAuditIfApplicable({ deps: d.deps, broadcast: BROADCAST })).resolves.toBeUndefined();
    expect(d.auditEmit).not.toHaveBeenCalled();
    const call = error.mock.calls.find((c) => c[1] === 'broadcasts.dispatch.expired_plan_check_threw');
    expect(call?.[0]).toMatchObject({ tenantId: 'test-tenant', broadcastId: BROADCAST.broadcastId, memberId: 'member-1' });
    expect(JSON.stringify(call?.[0])).not.toContain('example.com');
  });

  it('a failed audit INSERT is logged and does not throw', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const d = deps(
      async () => ok({ planId: 'plan-now', planCode: 'silver', eblastPerYear: 2 }),
      async () => {
        throw new Error('audit insert failed');
      },
    );
    await expect(emitExpiredPlanAuditIfApplicable({ deps: d.deps, broadcast: BROADCAST })).resolves.toBeUndefined();
    expect(error.mock.calls.some((c) => c[1] === 'broadcasts.dispatch.expired_plan_audit_emit_failed')).toBe(true);
  });
});
