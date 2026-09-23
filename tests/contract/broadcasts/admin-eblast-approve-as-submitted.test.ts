/**
 * F119 T041 (RED for T061) — approve-as-submitted still behaves exactly as
 * today: no version rows, no sign-off round, and the history carries
 * `approvedAsSubmitted { at, byUserId, byUserName }` instead of an empty
 * thread (US1-AS7, FR-007, SC-006).
 *
 * The approval runs through the UNCHANGED `approveBroadcast` use case over the
 * same in-memory store the version route reads, so "no version row" is a
 * statement about the real approve path, not about a mock. `approveBroadcast`
 * has no versions port at all (asserted structurally below), which is why the
 * approve-as-submitted path stays at zero new rows by construction (R2).
 */
import { beforeEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { approveBroadcast, type ApproveBroadcastDeps } from '@/modules/broadcasts/application/use-cases/approve-broadcast';
import type { BroadcastsRepo } from '@/modules/broadcasts/application/ports/broadcasts-repo';
import { asTenantContext } from '@/modules/tenants';
import { makeApprovalBroadcast } from '../../helpers/eblast-approval-fakes';
import {
  ADMIN_USER_ID,
  getVersionRequest,
  harness,
  importVersionRoute,
  resetVersionHarness,
  routeParams,
  staffCtx,
} from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/rbac', async () => (await import('../../helpers/eblast-version-route-harness')).rbacMock());
vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);

const SUBMITTED = makeApprovalBroadcast();
const ID = SUBMITTED.broadcastId as string;
const SCHEDULE = new Date('2026-10-02T03:00:00.000Z');

function approveDeps(): ApproveBroadcastDeps {
  return {
    tenant: asTenantContext('test-tenant'),
    broadcastsRepo: harness.store.broadcastsRepo as unknown as BroadcastsRepo,
    audit: harness.audit,
    clock: { now: () => harness.store.now },
  };
}

beforeEach(() => {
  resetVersionHarness({ broadcasts: [SUBMITTED] });
});

describe('approve as submitted (FR-007) — the thread without a formatting round', () => {
  it('no broadcast_versions row is written and the thread returns approvedAsSubmitted', async () => {
    const approved = await approveBroadcast(approveDeps(), {
      broadcastId: SUBMITTED.broadcastId,
      actorUserId: ADMIN_USER_ID,
      decision: { mode: 'schedule', scheduledFor: SCHEDULE },
      requestId: 'req-approve',
    });
    expect(approved.ok).toBe(true);
    expect(harness.store.versionsRepo.rows()).toHaveLength(0);

    harness.names = { [ADMIN_USER_ID]: 'Anna Admin' };
    harness.requireApiPermission.mockResolvedValue(staffCtx('manager', '66666666-6666-4666-8666-666666666666'));
    const { GET } = await importVersionRoute();
    const res = await GET(getVersionRequest(ID), routeParams(ID));

    expect(res.status).toBe(200);
    const thread = await res.json();
    expect(thread).toMatchObject({
      status: 'approved',
      stage: 'scheduled',
      round: 0,
      memberOriginal: null,
      sentVersions: [],
      workingCopy: null,
      decisions: [],
      approvedAsSubmitted: { at: harness.store.now.toISOString(), byUserId: ADMIN_USER_ID, byUserName: 'Anna Admin' },
    });
  });

  it('the approve use case has no versions port — the path cannot write a version by construction', () => {
    // Checked by `tsc` (pnpm typecheck): a versions/decisions port added to
    // `ApproveBroadcastDeps` changes this key set and fails the build.
    expectTypeOf<keyof ApproveBroadcastDeps>().toEqualTypeOf<
      'tenant' | 'broadcastsRepo' | 'audit' | 'clock' | 'emailTransactional' | 'membersBridge'
    >();
  });

  it('a submitted E-Blast nobody has approved yet carries no approvedAsSubmitted (and no versions)', async () => {
    const { GET } = await importVersionRoute();
    const thread = await (await GET(getVersionRequest(ID), routeParams(ID))).json();
    expect(thread).toMatchObject({ status: 'submitted', approvedAsSubmitted: null, memberOriginal: null, sentVersions: [] });
  });
});
