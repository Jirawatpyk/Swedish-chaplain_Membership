/**
 * FR-021 / AS2 — `enqueueDispatchFailureNotification`, driven directly.
 *
 * Spec 140 s4 deleted the legacy dispatch suite, which drove the arm where the
 * transactional enqueue itself throws (CI coverage on PR #756 read 88.23 %
 * branch against its 90 % pin). That arm and the locale chain are pinned here
 * on the helper; the import tick's suites cover its other callers' paths. Best
 * effort: no arm throws, because the terminal transition is already committed.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { logger } from '@/lib/logger';
import { asTenantContext } from '@/modules/tenants';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { enqueueDispatchFailureNotification } from '@/modules/broadcasts/application/use-cases/_enqueue-dispatch-failure-notification';

const tenant = asTenantContext('test-tenant');
const NOW = new Date('2026-11-06T03:00:00.000Z');
const BROADCAST = {
  broadcastId: '88888888-8888-4888-8888-888888888888',
  requestedByMemberId: 'member-1',
  subject: 'Autumn update',
  scheduledFor: null,
} as unknown as Broadcast;

function deps(opts: { send?: () => Promise<void>; preferred?: () => Promise<'en' | 'th' | 'sv' | null> } = {}) {
  const sendMemberEmail = vi.fn(opts.send ?? (async () => undefined));
  return {
    deps: {
      tenant,
      membersBridge: {
        getMemberPrimaryContact: async () => 'member@example.com',
        getMemberPreferredLocale: opts.preferred ?? (async () => null),
      },
      emailTransactional: { sendMemberEmail },
      audit: { emit: vi.fn(async () => undefined) },
      tenantDisplayName: 'Test Chamber',
      locale: 'th' as const,
    } as never,
    sendMemberEmail,
  };
}

afterEach(() => vi.restoreAllMocks());

describe('enqueueDispatchFailureNotification', () => {
  it('a send-now row: the email carries now as scheduledFor and the tenant locale when the member has none', async () => {
    const d = deps();
    await enqueueDispatchFailureNotification({ deps: d.deps, broadcast: BROADCAST, reason: 'retry_budget_exhausted', now: NOW });
    expect(d.sendMemberEmail).toHaveBeenCalledTimes(1);
    const [, message, tx] = d.sendMemberEmail.mock.calls[0]! as unknown as [unknown, { to: string; templateKey: string; locale: string; payload: Record<string, unknown> }, unknown];
    expect(message).toMatchObject({ to: 'member@example.com', templateKey: 'broadcast_failed_to_dispatch', locale: 'th' });
    expect(message.payload).toMatchObject({ scheduledFor: NOW.toISOString(), reason: 'retry_budget_exhausted' });
    expect(message.payload).not.toHaveProperty('memberStanding');
    expect(tx).toBeNull();
  });

  it('the member’s own locale wins, and a held row says so in the payload', async () => {
    const d = deps({ preferred: async () => 'sv' });
    await enqueueDispatchFailureNotification({
      deps: d.deps,
      broadcast: BROADCAST,
      reason: 'membership_suspended',
      now: NOW,
      memberStanding: 'held',
    });
    const [, message] = d.sendMemberEmail.mock.calls[0]! as unknown as [unknown, { locale: string; payload: Record<string, unknown> }];
    expect(message.locale).toBe('sv');
    expect(message.payload).toMatchObject({ memberStanding: 'held' });
  });

  it('a transactional enqueue that throws is logged by class and does not throw', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as never);
    const d = deps({
      send: async () => {
        throw new Error('outbox insert failed for member@example.com');
      },
    });
    await expect(
      enqueueDispatchFailureNotification({ deps: d.deps, broadcast: BROADCAST, reason: 'retry_budget_exhausted', now: NOW }),
    ).resolves.toBeUndefined();
    const call = error.mock.calls.find((c) => c[1] === 'broadcasts.dispatch_failure_email.enqueue_failed');
    expect(call?.[0]).toMatchObject({ tenantId: 'test-tenant', broadcastId: BROADCAST.broadcastId });
    expect(JSON.stringify(call?.[0])).not.toContain('example.com');
  });
});
