/**
 * F119 T045 (RED for T058) — two marketing users editing the same working
 * copy: the second save loses, clearly (FR-033, spec § Edge Cases "Two
 * marketing users").
 *
 * `PATCH /api/admin/broadcasts/[id]/version` over the REAL
 * `saveFormattedVersion` + the in-memory store. There is exactly one working
 * copy per E-Blast (the partial unique index), so both users edit the same
 * row and the optimistic-concurrency token decides who wins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import {
  harness,
  importVersionRoute,
  patchVersionRequest,
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

const IN_DESIGN = makeApprovalBroadcast({ status: 'in_design' });
const ID = IN_DESIGN.broadcastId as string;
const TOKEN = new Date('2026-09-24T08:30:00.000Z');
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const WORKING = makeApprovalVersion({ versionNo: 1, updatedAt: TOKEN });

const edit = (subject: string) => ({
  subject,
  bodyHtml: `<p>${subject}</p>`,
  bodySource: '{"type":"doc"}',
  noteToMember: null,
  expectedUpdatedAt: TOKEN.toISOString(),
});

beforeEach(() => {
  resetVersionHarness({ broadcasts: [IN_DESIGN], versions: [V0, WORKING] });
});

describe('PATCH /api/admin/broadcasts/[id]/version — optimistic concurrency', () => {
  it('two PATCHes with the same expectedUpdatedAt → the second is 409 version_changed with currentUpdatedAt and the current content', async () => {
    const { PATCH } = await importVersionRoute();
    const first = await PATCH(patchVersionRequest(ID, edit('Anna wins')), routeParams(ID));
    expect(first.status).toBe(200);
    const firstToken = (await first.json()).version.updatedAt as string;
    expect(firstToken).not.toBe(TOKEN.toISOString());

    harness.requireApiPermission.mockResolvedValue(staffCtx('marketing', '77777777-7777-4777-8777-777777777777'));
    const second = await PATCH(patchVersionRequest(ID, edit('Bo loses')), routeParams(ID));

    expect(second.status).toBe(409);
    const body = await second.json();
    expect(body.error.code).toBe('version_changed');
    expect(body.error.details).toEqual({
      currentUpdatedAt: firstToken,
      // T166 S-LOW — `body_source` is stored sanitised (the checked body), not the raw source the client sent.
      current: { subject: 'Anna wins', bodyHtml: '<p>Anna wins</p>', bodySource: '<p>Anna wins</p>', noteToMember: null },
    });
    // The loser overwrote nothing.
    expect(harness.store.versionsRepo.rows()[1]).toMatchObject({ subject: 'Anna wins', updatedAt: new Date(firstToken) });
  });

  it('the token moves on even when both saves land in the same millisecond', async () => {
    harness.store.now = TOKEN; // the clock has not advanced since the working copy was stamped
    const { PATCH } = await importVersionRoute();
    const first = await PATCH(patchVersionRequest(ID, edit('Anna wins')), routeParams(ID));
    expect(first.status).toBe(200);
    const second = await PATCH(patchVersionRequest(ID, edit('Bo loses')), routeParams(ID));
    expect(second.status).toBe(409);
  });

  it('the winner can keep saving with the token it was handed back', async () => {
    const { PATCH } = await importVersionRoute();
    const first = await (await PATCH(patchVersionRequest(ID, edit('Draft 1')), routeParams(ID))).json();
    const again = await PATCH(
      patchVersionRequest(ID, { ...edit('Draft 2'), expectedUpdatedAt: first.version.updatedAt }),
      routeParams(ID),
    );
    expect(again.status).toBe(200);
    expect(harness.store.versionsRepo.rows()[1]!.subject).toBe('Draft 2');
  });
});
