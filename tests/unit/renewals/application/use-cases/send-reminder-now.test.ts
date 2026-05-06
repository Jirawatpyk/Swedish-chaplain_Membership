/**
 * F8 Phase 4 Wave I2c · T089 spec — `sendReminderNow` use-case.
 *
 * Admin-triggered single-cycle dispatch. Tests:
 *   - Input validation (zod boundary)
 *   - cycle_not_found when findOne returns null
 *   - dispatchOneCycle outcomes propagate to caller (sent / skipped /
 *     failed)
 *   - actor_user_id + actor_role='admin' threading
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { assertOk } from '../../_helpers/assert-result';
import { buildDispatchCandidate } from '../../_helpers/build-cycle';
import { sendReminderNow } from '@/modules/renewals/application/use-cases/send-reminder-now';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { DispatchCandidate } from '@/modules/renewals/application/ports/dispatch-candidate-repo';
import { asCycleId } from '@/modules/renewals/domain/renewal-cycle';

const TENANT_ID = 'tenantA';
const CYCLE_ID = '00000000-0000-0000-0000-000000000c01';
const ACTOR_USER_ID = 'admin-1';
const NOW_ISO = '2026-05-15T00:00:00.000Z';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

vi.mock('@/lib/env', () => ({
  env: {
    features: { f8Renewals: true },
    flags: { readOnlyMode: false },
    log: { level: 'silent' },
    isProduction: false,
    isDevelopment: false,
    isTest: true,
    nodeEnv: 'test' as const,
  },
}));

vi.mock(
  '@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle',
  async () => {
    const actual = await vi.importActual<
      typeof import('@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle')
    >('@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle');
    return {
      ...actual,
      dispatchOneCycle: vi.fn(),
    };
  },
);

import { dispatchOneCycle } from '@/modules/renewals/application/use-cases/_lib/dispatch-one-cycle';

function buildCandidate(): DispatchCandidate {
  return buildDispatchCandidate({
    cycle: {
      tenantId: TENANT_ID,
      cycleId: asCycleId(CYCLE_ID),
      status: 'upcoming' as const,
      periodFrom: '2026-05-15T00:00:00.000Z',
      periodTo: '2027-05-15T00:00:00.000Z',
      expiresAt: '2026-06-14T00:00:00.000Z',
    },
  });
}

function fakeDeps(candidate: DispatchCandidate | null): RenewalsDeps {
  return {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    dispatchCandidateRepo: {
      list: vi.fn(),
      findOne: vi.fn(async () => candidate),
    } as unknown as RenewalsDeps['dispatchCandidateRepo'],
  } as unknown as RenewalsDeps;
}

const VALID_INPUT = {
  tenantId: TENANT_ID,
  cycleId: CYCLE_ID,
  actorUserId: ACTOR_USER_ID,
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
  nowIso: NOW_ISO,
};

describe('sendReminderNow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: candidate found, dispatchOneCycle returns sent → ok', async () => {
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        kind: 'sent',
        reminderEventId: 'r1',
        deliveryId: 'd1',
        dispatchedAt: NOW_ISO,
      }),
    );
    const result = await sendReminderNow(fakeDeps(buildCandidate()), VALID_INPUT);
    assertOk(result);
    expect(result.value.kind).toBe('sent');
  });

  it('cycle_not_found: returns typed error (no probe audit)', async () => {
    const result = await sendReminderNow(fakeDeps(null), VALID_INPUT);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('cycle_not_found');
  });

  it('idempotency replay: returns skipped already_sent (caller maps to 409)', async () => {
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => ({
        kind: 'skipped',
        reason: 'already_sent',
        metadata: { existing_reminder_event_id: 'r1', existing_dispatched_at: '2026-05-14T10:00:00Z' },
      }),
    );
    const result = await sendReminderNow(fakeDeps(buildCandidate()), VALID_INPUT);
    assertOk(result);
    expect(result.value.kind).toBe('skipped');
    if (result.value.kind !== 'skipped') return;
    expect(result.value.reason).toBe('already_sent');
  });

  it('threads actor_user_id + admin role into dispatchOneCycle ctx', async () => {
    const oneCycleMock = dispatchOneCycle as unknown as ReturnType<typeof vi.fn>;
    oneCycleMock.mockImplementation(async () => ({
      kind: 'sent',
      reminderEventId: 'r1',
      deliveryId: 'd1',
      dispatchedAt: NOW_ISO,
    }));
    await sendReminderNow(fakeDeps(buildCandidate()), VALID_INPUT);
    const ctx = oneCycleMock.mock.calls[0]![2];
    expect(ctx.actorUserId).toBe(ACTOR_USER_ID);
    expect(ctx.actorRole).toBe('admin');
  });

  it('rejects non-UUID cycleId with invalid_input', async () => {
    const result = await sendReminderNow(fakeDeps(buildCandidate()), {
      ...VALID_INPUT,
      cycleId: 'not-a-uuid',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects empty actorUserId with invalid_input', async () => {
    const result = await sendReminderNow(fakeDeps(buildCandidate()), {
      ...VALID_INPUT,
      actorUserId: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects non-admin actorRole with invalid_input', async () => {
    const result = await sendReminderNow(fakeDeps(buildCandidate()), {
      ...VALID_INPUT,
      actorRole: 'manager' as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('unexpected dispatchOneCycle exception propagates (does not swallow)', async () => {
    (dispatchOneCycle as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async () => {
        throw new Error('db: connection lost');
      },
    );
    await expect(
      sendReminderNow(fakeDeps(buildCandidate()), VALID_INPUT),
    ).rejects.toThrow(/connection lost/);
  });
});
