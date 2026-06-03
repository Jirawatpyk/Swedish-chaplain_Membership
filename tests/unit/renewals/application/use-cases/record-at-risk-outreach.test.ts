/**
 * F8 Phase 6 Wave B · T156 spec — `recordAtRiskOutreach` use-case.
 *
 * Verifies admin/manager outreach insert + audit emit-in-tx atomicity
 * (Constitution Principle VIII). Covers FR-033 (manager outreach
 * exception) + FR-052a (manager exception is the only F8 mutating
 * endpoint manager can invoke) + migration 0090 channel-template
 * discriminant CHECK mirror.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { recordAtRiskOutreach } from '@/modules/renewals/application/use-cases/record-at-risk-outreach';
import type { RenewalsDeps } from '@/modules/renewals/infrastructure/renewals-deps';

// W0-09: capture atRiskOutreachRecorded calls.
// vi.hoisted required because vi.mock is hoisted to top of file.
const atRiskOutreachRecordedMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/metrics', () => ({
  renewalsMetrics: {
    atRiskOutreachRecorded: atRiskOutreachRecordedMock,
  },
}));

const TENANT_ID = 'tenantA';
const MEMBER_UUID = '00000000-0000-0000-0000-00000000a156';
const OUTREACH_UUID = '00000000-0000-0000-0000-00000000bb01';
const CREATED_AT_ISO = '2026-05-08T10:30:00.000Z';

vi.mock('@/lib/db', () => ({
  runInTenant: async <T>(_ctx: unknown, fn: (tx: unknown) => Promise<T>) =>
    fn({} as unknown),
}));

function fakeDeps(opts?: {
  insertImpl?: () => Promise<{ outreachId: string; createdAt: string }>;
  emitImpl?: () => Promise<void>;
}): {
  deps: RenewalsDeps;
  insertMock: ReturnType<typeof vi.fn>;
  emitInTxMock: ReturnType<typeof vi.fn>;
} {
  const insertMock = vi.fn(
    opts?.insertImpl ??
      (async () => ({
        outreachId: OUTREACH_UUID,
        createdAt: CREATED_AT_ISO,
      })),
  );
  const emitInTxMock = vi.fn(opts?.emitImpl ?? (async () => {}));
  const deps = {
    tenant: { slug: TENANT_ID } as RenewalsDeps['tenant'],
    atRiskOutreachWriteRepo: {
      insertOutreachInTx: insertMock,
    },
    auditEmitter: {
      emit: vi.fn(async () => {}),
      emitInTx: emitInTxMock,
    },
  } as unknown as RenewalsDeps;
  return { deps, insertMock, emitInTxMock };
}

const baseInput = {
  tenantId: TENANT_ID,
  memberId: MEMBER_UUID,
  channel: 'email' as const,
  templateId: 'at_risk.outreach.event_drought',
  outcomeNote: 'Sent personalised re-engagement email.',
  actorUserId: 'admin-1',
  actorRole: 'admin' as const,
  correlationId: 'corr-1',
};

describe('recordAtRiskOutreach (T156)', () => {
  beforeEach(() => {
    atRiskOutreachRecordedMock.mockReset();
  });

  it('happy path — admin email outreach inserts + emits audit', async () => {
    const { deps, insertMock, emitInTxMock } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, baseInput);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.outreachId).toBe(OUTREACH_UUID);
      expect(r.value.createdAt).toBe(CREATED_AT_ISO);
    }
    expect(insertMock).toHaveBeenCalledOnce();
    expect(insertMock.mock.calls[0]?.[2]).toMatchObject({
      memberId: MEMBER_UUID,
      channel: 'email',
      templateId: 'at_risk.outreach.event_drought',
      outcomeNote: 'Sent personalised re-engagement email.',
      actorUserId: 'admin-1',
    });
    expect(emitInTxMock).toHaveBeenCalledOnce();
    expect(emitInTxMock.mock.calls[0]?.[1]).toMatchObject({
      type: 'at_risk_outreach_recorded',
      payload: {
        member_id: MEMBER_UUID,
        outreach_id: OUTREACH_UUID,
        channel: 'email',
        template_id: 'at_risk.outreach.event_drought',
        actor_role: 'admin',
      },
    });
  });

  it('manager-role outreach allowed (FR-052a manager exception)', async () => {
    const { deps, emitInTxMock } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, {
      ...baseInput,
      channel: 'phone',
      templateId: undefined,
      outcomeNote: 'Called to confirm renewal intent.',
      actorRole: 'manager' as const,
    });
    expect(r.ok).toBe(true);
    expect(emitInTxMock.mock.calls[0]?.[1]?.payload?.actor_role).toBe(
      'manager',
    );
  });

  it('phone channel — templateId omitted (CHECK mirror)', async () => {
    const { deps, insertMock } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, {
      ...baseInput,
      channel: 'phone',
      templateId: undefined,
    });
    expect(r.ok).toBe(true);
    expect(insertMock.mock.calls[0]?.[2]).not.toHaveProperty('templateId');
  });

  it('meeting channel — templateId omitted', async () => {
    const { deps } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, {
      ...baseInput,
      channel: 'meeting',
      templateId: undefined,
      outcomeNote: 'Quarterly review meeting on premises.',
    });
    expect(r.ok).toBe(true);
  });

  it('rejects email channel without templateId (zod CHECK mirror)', async () => {
    const { deps, insertMock } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, {
      ...baseInput,
      channel: 'email',
      templateId: undefined,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects phone channel WITH templateId (zod CHECK mirror)', async () => {
    const { deps, insertMock } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, {
      ...baseInput,
      channel: 'phone',
      templateId: 'wrong.use',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('rejects outcomeNote >500 chars', async () => {
    const { deps } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, {
      ...baseInput,
      outcomeNote: 'x'.repeat(501),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('invalid_input');
  });

  it('repo throws (CHECK violation / FK violation) → server_error', async () => {
    const repoError = new Error('FK violation: member not found');
    const { deps } = fakeDeps({
      insertImpl: async () => {
        throw repoError;
      },
    });
    const r = await recordAtRiskOutreach(deps, baseInput);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.kind).toBe('server_error');
  });

  it('audit emit failure rolls back the INSERT (Principle VIII)', async () => {
    const auditError = new Error('audit_log: insert failed');
    const { deps } = fakeDeps({
      emitImpl: async () => {
        throw auditError;
      },
    });
    await expect(recordAtRiskOutreach(deps, baseInput)).rejects.toThrow(
      auditError,
    );
  });

  // W0-09: § 23.1.2 metric emission
  it('emits atRiskOutreachRecorded on success with tenantId + channel + templateId', async () => {
    const { deps } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, baseInput);
    expect(r.ok).toBe(true);
    expect(atRiskOutreachRecordedMock).toHaveBeenCalledOnce();
    expect(atRiskOutreachRecordedMock).toHaveBeenCalledWith(
      TENANT_ID,
      'email',
      'at_risk.outreach.event_drought',
    );
  });

  it('emits atRiskOutreachRecorded with undefined templateId for phone channel', async () => {
    const { deps } = fakeDeps();
    const r = await recordAtRiskOutreach(deps, {
      ...baseInput,
      channel: 'phone',
      templateId: undefined,
    });
    expect(r.ok).toBe(true);
    expect(atRiskOutreachRecordedMock).toHaveBeenCalledWith(
      TENANT_ID,
      'phone',
      undefined,
    );
  });

  it('does NOT emit atRiskOutreachRecorded when repo throws (server_error)', async () => {
    const { deps } = fakeDeps({
      insertImpl: async () => { throw new Error('FK violation'); },
    });
    const r = await recordAtRiskOutreach(deps, baseInput);
    expect(r.ok).toBe(false);
    expect(atRiskOutreachRecordedMock).not.toHaveBeenCalled();
  });

  it('does NOT emit atRiskOutreachRecorded when audit throws (tx rolled back)', async () => {
    const { deps } = fakeDeps({
      emitImpl: async () => { throw new Error('audit failed'); },
    });
    await expect(recordAtRiskOutreach(deps, baseInput)).rejects.toThrow();
    expect(atRiskOutreachRecordedMock).not.toHaveBeenCalled();
  });
});
