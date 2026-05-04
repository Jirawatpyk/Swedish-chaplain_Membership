/**
 * F8 Phase 4 Wave I1a · T082 spec — `updateSchedulePolicy` use-case.
 *
 * Target: 100% branch coverage (security-critical mutating path per
 * Constitution coverage table — admin schedule editor write path).
 *
 * runInTenant is stubbed via partial deps mock — the real
 * implementation wraps in a Drizzle tx; tests verify the use-case
 * invokes `upsertSteps` + `auditEmitter.emitInTx` regardless of tx
 * mechanics.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { updateSchedulePolicy } from '@/modules/renewals/application/use-cases/update-schedule-policy';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';
import type { TenantRenewalSchedulePolicy } from '@/modules/renewals/domain/tenant-renewal-schedule-policy';

const TENANT_ID = 'tenantA';
const ACTOR_USER_ID = 'admin-1';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function buildPriorPolicy(): TenantRenewalSchedulePolicy {
  return {
    tenantId: TENANT_ID,
    tierBucket: 'regular' as const,
    steps: [
      {
        stepId: 't-30.email',
        offsetDays: -30,
        channel: 'email' as const,
        templateId: 'renewal.t-30.regular',
      },
      {
        stepId: 't-7.email',
        offsetDays: -7,
        channel: 'email' as const,
        templateId: 'renewal.t-7.regular',
      },
    ],
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-04-01T00:00:00Z',
  };
}

function fakeDeps(prior: TenantRenewalSchedulePolicy | null = null): {
  deps: RenewalsDeps;
  upsertMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
  findByBucketMock: ReturnType<typeof vi.fn>;
} {
  const upsertMock = vi.fn(
    async (_tx, _t, _b, steps) =>
      ({
        tenantId: TENANT_ID,
        tierBucket: 'regular' as const,
        steps,
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: new Date().toISOString(),
      }) satisfies TenantRenewalSchedulePolicy,
  );
  const emitInTxMock = vi.fn(async () => {});
  const findByBucketMock = vi.fn(async () => prior);
  const deps: RenewalsDeps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    schedulePolicyRepo: {
      findByBucket: findByBucketMock,
      listAllForTenant: vi.fn(),
      upsertSteps: upsertMock,
    } as unknown as RenewalsDeps['schedulePolicyRepo'],
    auditEmitter: {
      emit: vi.fn(),
      emitInTx: emitInTxMock,
    } as unknown as RenewalsDeps['auditEmitter'],
  } as unknown as RenewalsDeps;
  return { deps, upsertMock, emitInTxMock, findByBucketMock };
}

const VALID_INPUT = {
  tenantId: TENANT_ID,
  tierBucket: 'regular' as const,
  steps: [
    {
      step_id: 't-30.email',
      offset_days: -30,
      channel: 'email' as const,
      template_id: 'renewal.t-30.regular',
    },
    {
      step_id: 't-14.email',
      offset_days: -14,
      channel: 'email' as const,
      template_id: 'renewal.t-14.regular',
    },
  ],
  actorUserId: ACTOR_USER_ID,
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('updateSchedulePolicy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('happy path: persists steps + emits renewal_schedule_policy_updated audit', async () => {
    const { deps, upsertMock, emitInTxMock } = fakeDeps(buildPriorPolicy());
    const result = await updateSchedulePolicy(deps, VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(emitInTxMock).toHaveBeenCalledTimes(1);
    const auditCall = emitInTxMock.mock.calls[0]!;
    expect(auditCall[1].type).toBe('renewal_schedule_policy_updated');
    expect(auditCall[1].payload.tier_bucket).toBe('regular');
  });

  it('computes change_diff against prior policy: added t-14, removed t-7, unchanged t-30', async () => {
    const { deps, emitInTxMock } = fakeDeps(buildPriorPolicy());
    const result = await updateSchedulePolicy(deps, VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changeDiff.added).toContain('t-14.email');
    expect(result.value.changeDiff.removed).toContain('t-7.email');
    expect(result.value.changeDiff.unchanged).toContain('t-30.email');
    const audit = emitInTxMock.mock.calls[0]![1];
    expect(audit.payload.change_diff.added).toContain('t-14.email');
    expect(audit.payload.change_diff.removed).toContain('t-7.email');
    expect(audit.payload.change_diff.unchanged_count).toBe(1);
  });

  it('handles fresh tenant (no prior policy): every step counts as added', async () => {
    const { deps, emitInTxMock } = fakeDeps(null);
    const result = await updateSchedulePolicy(deps, VALID_INPUT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.changeDiff.added).toEqual([
      't-30.email',
      't-14.email',
    ]);
    expect(result.value.changeDiff.removed).toEqual([]);
    const audit = emitInTxMock.mock.calls[0]![1];
    expect(audit.payload.step_count_before).toBe(0);
    expect(audit.payload.step_count_after).toBe(2);
  });

  it('rejects empty tenantId with invalid_input', async () => {
    const { deps } = fakeDeps();
    const result = await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      tenantId: '',
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects unknown tier_bucket with invalid_input (zod-level)', async () => {
    const { deps } = fakeDeps();
    const result = await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      tierBucket: 'gold' as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects empty steps array with invalid_input', async () => {
    const { deps } = fakeDeps();
    const result = await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      steps: [],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects manager actorRole at zod boundary (use-case is admin-only)', async () => {
    const { deps } = fakeDeps();
    const result = await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      actorRole: 'manager' as never,
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_input');
  });

  it('rejects email step missing template_id with invalid_steps (Domain-level)', async () => {
    const { deps } = fakeDeps();
    const result = await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      steps: [
        {
          step_id: 'broken',
          offset_days: -30,
          channel: 'email' as const,
          // template_id missing
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_steps');
    if (result.error.kind !== 'invalid_steps') return;
    expect(result.error.error.kind).toBe('step_parse_failed');
  });

  it('rejects task step with template_id present (channel-payload discriminant)', async () => {
    const { deps } = fakeDeps();
    const result = await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      steps: [
        {
          step_id: 'broken',
          offset_days: -30,
          channel: 'task' as const,
          task_type: 'phone_call',
          assignee_role: 'admin' as const,
          template_id: 'should-not-be-here',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_steps');
  });

  it('rejects duplicate step_id with invalid_steps', async () => {
    const { deps } = fakeDeps();
    const result = await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      steps: [
        {
          step_id: 'dup',
          offset_days: -30,
          channel: 'email' as const,
          template_id: 'a',
        },
        {
          step_id: 'dup',
          offset_days: -7,
          channel: 'email' as const,
          template_id: 'b',
        },
      ],
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe('invalid_steps');
    if (result.error.kind !== 'invalid_steps') return;
    expect(result.error.error.kind).toBe('duplicate_step_id');
  });

  it('does NOT call upsert when steps validation fails (atomic short-circuit)', async () => {
    const { deps, upsertMock, emitInTxMock } = fakeDeps();
    await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      steps: [
        {
          step_id: 'bad',
          offset_days: 9999,
          channel: 'email' as const,
          template_id: 'a',
        },
      ],
    });
    expect(upsertMock).not.toHaveBeenCalled();
    expect(emitInTxMock).not.toHaveBeenCalled();
  });

  it('audit summary includes diff counts in human-readable format', async () => {
    const { deps, emitInTxMock } = fakeDeps(buildPriorPolicy());
    await updateSchedulePolicy(deps, VALID_INPUT);
    const summary = emitInTxMock.mock.calls[0]![2].summary as string;
    expect(summary).toMatch(/Admin updated regular schedule policy/);
    expect(summary).toContain('+1');
    expect(summary).toContain('-1');
    expect(summary).toContain('=1');
  });

  it('propagates correlationId + actorUserId + actorRole to audit context', async () => {
    const { deps, emitInTxMock } = fakeDeps();
    await updateSchedulePolicy(deps, {
      ...VALID_INPUT,
      requestId: 'req-xyz',
    });
    const ctx = emitInTxMock.mock.calls[0]![2];
    expect(ctx.tenantId).toBe(TENANT_ID);
    expect(ctx.actorUserId).toBe(ACTOR_USER_ID);
    expect(ctx.actorRole).toBe('admin');
    expect(ctx.correlationId).toBe('corr-1');
    expect(ctx.requestId).toBe('req-xyz');
  });
});
