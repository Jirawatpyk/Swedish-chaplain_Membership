/**
 * Unit: `bulkSendRenewalReminder` (#4 members-ux) — the per-member bucketing
 * that sits on top of F8's `sendReminderNow`. `sendReminderNow` is mocked (it is
 * integration-tested in F8) so these tests pin ONLY the mapping this use-case
 * adds: no-active-cycle → skipped, each dispatch outcome kind → the right
 * bucket, and dispatch errors → skipped/failed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ok, err } from '@/lib/result';

vi.mock('@/modules/renewals/application/use-cases/send-reminder-now', () => ({
  sendReminderNow: vi.fn(),
}));

import { sendReminderNow } from '@/modules/renewals/application/use-cases/send-reminder-now';
import { bulkSendRenewalReminder } from '@/modules/renewals/application/use-cases/bulk-send-renewal-reminder';

const mockSend = vi.mocked(sendReminderNow);

const M1 = '11111111-1111-4111-8111-111111111111';
const M2 = '22222222-2222-4222-8222-222222222222';
const M3 = '33333333-3333-4333-8333-333333333333';
const M4 = '44444444-4444-4444-8444-444444444444';
const M5 = '55555555-5555-4555-8555-555555555555';

/** deps stub — findActiveForMember returns a cycle for every member EXCEPT
 *  those listed in `noCycle`. */
function makeDeps(noCycle: string[] = []) {
  return {
    cyclesRepo: {
      findActiveForMember: vi.fn(async (_t: string, memberId: string) =>
        noCycle.includes(memberId) ? null : { cycleId: `cycle-${memberId}` },
      ),
    },
  } as unknown as Parameters<typeof bulkSendRenewalReminder>[0];
}

const base = {
  tenantId: 'tenant-a',
  actorUserId: 'admin-1',
  correlationId: 'corr-1',
  requestId: 'req-1',
};

beforeEach(() => {
  mockSend.mockReset();
});

describe('bulkSendRenewalReminder', () => {
  it('skips a member with no active cycle without calling dispatch', async () => {
    const res = await bulkSendRenewalReminder(makeDeps([M1]), {
      ...base,
      memberIds: [M1],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.counts).toEqual({ sent: 0, skipped: 1, failed: 0 });
    expect(res.value.skipped[0]).toEqual({
      memberId: M1,
      reason: 'no_active_cycle',
    });
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('buckets a sent outcome into `sent`', async () => {
    mockSend.mockResolvedValueOnce(
      ok({
        kind: 'sent',
        reminderEventId: 'r1',
        deliveryId: 'd1',
        dispatchedAt: '2026-07-24T00:00:00Z',
      }),
    );
    const res = await bulkSendRenewalReminder(makeDeps(), {
      ...base,
      memberIds: [M1],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.sent).toEqual([M1]);
    expect(res.value.counts).toEqual({ sent: 1, skipped: 0, failed: 0 });
  });

  it('maps every outcome kind + error to the right bucket across a batch', async () => {
    mockSend
      .mockResolvedValueOnce(ok({ kind: 'skipped', reason: 'member_opted_out' }))
      .mockResolvedValueOnce(
        ok({ kind: 'task_created', taskId: 't', taskType: 'x', reminderEventId: 'r' }),
      )
      .mockResolvedValueOnce(
        ok({ kind: 'failed_permanent', reminderEventId: 'r', reason: 'boom' }),
      )
      .mockResolvedValueOnce(err({ kind: 'server_error', message: 'db down' }))
      .mockResolvedValueOnce(err({ kind: 'cycle_not_found' }));

    const res = await bulkSendRenewalReminder(makeDeps(), {
      ...base,
      memberIds: [M1, M2, M3, M4, M5],
    });
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // M1 opted out + M2 escalation-task + M5 raced-to-terminal → skipped.
    expect(res.value.skipped).toEqual([
      { memberId: M1, reason: 'member_opted_out' },
      { memberId: M2, reason: 'task_created' },
      { memberId: M5, reason: 'no_active_cycle' },
    ]);
    // M3 permanent-fail + M4 server_error → failed.
    expect(res.value.failed).toEqual([
      { memberId: M3, code: 'failed_permanent' },
      { memberId: M4, code: 'server_error' },
    ]);
    expect(res.value.sent).toEqual([]);
    expect(res.value.counts).toEqual({ sent: 0, skipped: 3, failed: 2 });
  });

  it('rejects invalid input (empty member list)', async () => {
    const res = await bulkSendRenewalReminder(makeDeps(), {
      ...base,
      memberIds: [],
    });
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.kind).toBe('invalid_input');
  });
});
