/**
 * F119 T083 (research R17) — `listMemberBroadcastVersions`, the GDPR export's
 * read of the approval round of every E-Blast the member originated.
 *
 * The projection is the contract: the member's own E-Blasts only, the
 * versions they were SHOWN (never marketing's unsent working copy), the
 * author as `member` | `organisation` (never a staff id), decisions without
 * a decider — grouped per E-Blast, oldest first inside, newest E-Blast first.
 */
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@/modules/tenants';
import type { MemberId } from '@/modules/members';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { listMemberBroadcastVersions } from '@/modules/broadcasts/application/use-cases/list-member-broadcast-versions';
import { makeApprovalBroadcast, makeApprovalVersion, makeFakeApprovalStore } from '../../../helpers/eblast-approval-fakes';

const TENANT = { slug: 'test-tenant' } as unknown as TenantContext;
const MEMBER = '22222222-2222-4222-8222-222222222222';
const OLD = asBroadcastId('11111111-1111-4111-8111-111111111111');
const NEW = asBroadcastId('11111111-1111-4111-8111-222222222222');
const PEER = asBroadcastId('11111111-1111-4111-8111-333333333333');
const STAFF_USER = '44444444-4444-4444-8444-444444444444';
const at = (d: string) => new Date(`2026-09-${d}T08:00:00.000Z`);

function seed() {
  return makeFakeApprovalStore({
    broadcasts: [
      makeApprovalBroadcast({ broadcastId: OLD }),
      makeApprovalBroadcast({ broadcastId: NEW }),
      makeApprovalBroadcast({ broadcastId: PEER, requestedByMemberId: '77777777-7777-4777-8777-777777777777' }),
    ],
    versions: [
      makeApprovalVersion({ id: 'old-v0', broadcastId: OLD, versionNo: 0, authoredByRole: 'member_self_service', sentToMemberAt: at('01'), createdAt: at('01') }),
      makeApprovalVersion({ id: 'old-v1', broadcastId: OLD, versionNo: 1, noteToMember: 'Moved the date', sentToMemberAt: at('02'), createdAt: at('02') }),
      makeApprovalVersion({ id: 'new-v0', broadcastId: NEW, versionNo: 0, authoredByRole: 'admin_proxy', sentToMemberAt: at('10'), createdAt: at('10') }),
      // marketing's unsent working copy — never on a member path
      makeApprovalVersion({ id: 'new-v1', broadcastId: NEW, versionNo: 1, sentToMemberAt: null, createdAt: at('11') }),
      makeApprovalVersion({ id: 'peer-v0', broadcastId: PEER, versionNo: 0, sentToMemberAt: at('12'), createdAt: at('12') }),
    ],
    decisions: [
      {
        id: 'old-d1',
        tenantId: 'test-tenant',
        broadcastId: OLD,
        versionId: 'old-v1',
        round: 1,
        decision: 'changes_requested',
        reason: 'The date is wrong',
        decidedByUserId: '33333333-3333-4333-8333-333333333333',
        decidedByContactId: 'dddddddd-0000-4000-8000-000000000001',
        decidedAt: at('03'),
      },
    ],
  });
}

describe('listMemberBroadcastVersions (F119 T083)', () => {
  it('groups the member’s own rounds, newest E-Blast first, and projects them for the member', async () => {
    const store = seed();
    const out = await listMemberBroadcastVersions(
      { tenant: TENANT, broadcastsRepo: store.broadcastsRepo, versionsRepo: store.versionsRepo, decisionsRepo: store.decisionsRepo },
      { memberId: MEMBER as MemberId, limit: 1000 },
    );

    expect(out.truncated).toBe(false);
    expect(out.threads.map((t) => t.broadcastId)).toEqual([NEW, OLD]);
    const [newer, older] = out.threads;
    // The working copy is absent; a proxy original is the organisation's.
    expect(newer!.versions.map((v) => [v.id, v.authoredBy])).toEqual([['new-v0', 'organisation']]);
    expect(older!.versions).toEqual([
      expect.objectContaining({ id: 'old-v0', versionNo: 0, authoredBy: 'member', sentToMemberAt: null }),
      expect.objectContaining({ id: 'old-v1', versionNo: 1, authoredBy: 'organisation', noteToMember: 'Moved the date', sentToMemberAt: at('02') }),
    ]);
    expect(older!.decisions).toEqual([
      { id: 'old-d1', broadcastId: OLD, versionId: 'old-v1', round: 1, decision: 'changes_requested', reason: 'The date is wrong', decidedAt: at('03') },
    ]);
    // No staff identity, no decider, no peer's E-Blast.
    const text = JSON.stringify(out);
    expect(text).not.toContain(STAFF_USER);
    expect(text).not.toContain('decidedByUserId');
    expect(text).not.toContain(PEER);
  });

  it('reads one row past the cap and reports truncation, keeping the newest', async () => {
    const store = seed();
    const out = await listMemberBroadcastVersions(
      { tenant: TENANT, broadcastsRepo: store.broadcastsRepo, versionsRepo: store.versionsRepo, decisionsRepo: store.decisionsRepo },
      { memberId: MEMBER as MemberId, limit: 2 },
    );
    expect(store.versionsRepo.listSentByMember).toHaveBeenCalledWith('test-tenant', MEMBER, 3, 'fake-tx');
    expect(store.decisionsRepo.listByMember).toHaveBeenCalledWith('test-tenant', MEMBER, 3, 'fake-tx');
    expect(out.truncated).toBe(true);
    expect(out.threads.flatMap((t) => t.versions.map((v) => v.id))).toEqual(['new-v0', 'old-v1']);
  });
});
