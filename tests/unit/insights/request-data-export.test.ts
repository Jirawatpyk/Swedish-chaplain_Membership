/**
 * F9 US6 (T089) — `requestDataExport` use-case unit tests.
 *
 * RBAC (own-only / admin-on-behalf, FR-031/032), idempotent enqueue with the
 * subject member + requester locale captured (FR-029), and the
 * `data_export_requested` audit emitted on a fresh job only.
 */
import { describe, expect, it, vi } from 'vitest';
import { requestDataExport } from '@/modules/insights/application/use-cases/request-data-export';
import type { TenantContext } from '@/modules/tenants';
import type {
  CreateExportJobInput,
  ExportJobRecord,
} from '@/modules/insights/application/ports/export-job-repo';

const ctx = { slug: 'test-tenant', id: 't1', name: 'Test', locale: 'en' } as unknown as TenantContext;
const MEMBER = '22222222-2222-2222-2222-222222222222';
const OTHER_MEMBER = '33333333-3333-3333-3333-333333333333';
const ADMIN_USER = '44444444-4444-4444-4444-444444444444';
const MEMBER_USER = '55555555-5555-5555-5555-555555555555';

function fakeJob(input: CreateExportJobInput, created: boolean): { job: ExportJobRecord; created: boolean } {
  return {
    created,
    job: {
      id: 'job-1',
      tenantId: ctx.slug,
      kind: input.kind,
      subjectMemberId: input.subjectMemberId,
      requestedBy: input.requestedBy,
      requestedForPeriod: input.requestedForPeriod,
      requesterLocale: input.requesterLocale,
      status: 'requested',
      idempotencyKey: input.idempotencyKey,
      blobKey: null,
      downloadTokenHash: null,
      expiresAt: null,
      errorCode: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    },
  };
}

function makeDeps(created = true) {
  const createOrGetInTx = vi.fn(async (_tx: unknown, input: CreateExportJobInput) =>
    fakeJob(input, created),
  );
  const recordInTx = vi.fn(async (_tx: unknown, _event: unknown) => {});
  return {
    deps: {
      exportJobRepo: { createOrGetInTx } as never,
      audit: { recordInTx, record: vi.fn() } as never,
      clock: { now: () => new Date('2026-05-29T08:30:15.000Z') },
    },
    createOrGetInTx,
    recordInTx,
  };
}

// runInTenant is mocked to invoke the callback with a dummy tx.
vi.mock('@/lib/db', () => ({
  runInTenant: (_ctx: unknown, fn: (tx: unknown) => unknown) => fn({}),
}));

describe('requestDataExport — RBAC', () => {
  it('member may export their OWN data (on_behalf=false)', async () => {
    const { deps, createOrGetInTx, recordInTx } = makeDeps();
    const r = await requestDataExport(
      { subjectMemberId: MEMBER },
      { actorUserId: MEMBER_USER, actorRole: 'member', actorMemberId: MEMBER, requesterLocale: 'th', requestId: 'r1' },
      ctx,
      deps,
    );
    expect(r.ok).toBe(true);
    const input = createOrGetInTx.mock.calls[0]![1] as CreateExportJobInput;
    expect(input.kind).toBe('gdpr_member_archive');
    expect(input.subjectMemberId).toBe(MEMBER);
    expect(input.requesterLocale).toBe('th');
    // Audit payload on_behalf=false for a self-service request.
    expect(recordInTx).toHaveBeenCalledTimes(1);
    const event = recordInTx.mock.calls[0]![1] as { eventType: string; payload: { on_behalf: boolean } };
    expect(event.eventType).toBe('data_export_requested');
    expect(event.payload.on_behalf).toBe(false);
  });

  it('member may NOT export another member’s data', async () => {
    const { deps, createOrGetInTx } = makeDeps();
    const r = await requestDataExport(
      { subjectMemberId: OTHER_MEMBER },
      { actorUserId: MEMBER_USER, actorRole: 'member', actorMemberId: MEMBER, requesterLocale: 'en', requestId: 'r2' },
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
    expect(createOrGetInTx).not.toHaveBeenCalled();
  });

  it('admin may export on a member’s behalf (on_behalf=true, attributed to admin)', async () => {
    const { deps, createOrGetInTx, recordInTx } = makeDeps();
    const r = await requestDataExport(
      { subjectMemberId: MEMBER },
      { actorUserId: ADMIN_USER, actorRole: 'admin', actorMemberId: null, requesterLocale: 'sv', requestId: 'r3' },
      ctx,
      deps,
    );
    expect(r.ok).toBe(true);
    const input = createOrGetInTx.mock.calls[0]![1] as CreateExportJobInput;
    expect(input.requestedBy).toBe(ADMIN_USER);
    expect(input.requesterLocale).toBe('sv');
    const event = recordInTx.mock.calls[0]![1] as { actorUserId: string; payload: { on_behalf: boolean } };
    expect(event.payload.on_behalf).toBe(true);
    expect(event.actorUserId).toBe(ADMIN_USER);
  });

  it('manager is forbidden (GDPR export is an admin/DPO action)', async () => {
    const { deps } = makeDeps();
    const r = await requestDataExport(
      { subjectMemberId: MEMBER },
      { actorUserId: ADMIN_USER, actorRole: 'manager', actorMemberId: null, requesterLocale: 'en', requestId: 'r4' },
      ctx,
      deps,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toBe('forbidden');
  });
});

describe('requestDataExport — idempotency', () => {
  it('does NOT re-emit the audit when an existing job is returned', async () => {
    const { deps, recordInTx } = makeDeps(false); // createOrGet returns existing
    const r = await requestDataExport(
      { subjectMemberId: MEMBER },
      { actorUserId: MEMBER_USER, actorRole: 'member', actorMemberId: MEMBER, requesterLocale: 'en', requestId: 'r5' },
      ctx,
      deps,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.created).toBe(false);
    expect(recordInTx).not.toHaveBeenCalled();
  });

  it('uses a per-minute idempotency window (same minute → same key)', async () => {
    const { deps, createOrGetInTx } = makeDeps();
    const meta = { actorUserId: MEMBER_USER, actorRole: 'member' as const, actorMemberId: MEMBER, requesterLocale: 'en' as const, requestId: 'r6' };
    await requestDataExport({ subjectMemberId: MEMBER }, meta, ctx, deps);
    const input = createOrGetInTx.mock.calls[0]![1] as CreateExportJobInput;
    // clock = 2026-05-29T08:30:15Z → minute bucket 2026-05-29T08:30
    expect(input.requestedForPeriod).toBe('2026-05-29T08:30');
  });
});
