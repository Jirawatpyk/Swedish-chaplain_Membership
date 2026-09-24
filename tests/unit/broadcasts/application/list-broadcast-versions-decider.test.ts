/**
 * F119 UX review M7 (FR-032 — "who") — the STAFF thread names the member
 * user who recorded each decision, resolved through the same
 * `ActorNameDirectoryPort` call as the version authors (display name only,
 * never an email). The member projection never carries it (`_member-view.ts`).
 */
import { describe, expect, it } from 'vitest';
import type { TenantContext } from '@/modules/tenants';
import { asBroadcastId } from '@/modules/broadcasts/domain/broadcast';
import { listBroadcastVersions } from '@/modules/broadcasts/application/use-cases/approval/list-broadcast-versions';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeActorNameDirectory,
  makeFakeApprovalStore,
  makeRecordingF7Audit,
} from '../../../helpers/eblast-approval-fakes';

const TENANT = { slug: 'test-tenant' } as unknown as TenantContext;
const ID = asBroadcastId('11111111-1111-4111-8111-111111111111');
const DECIDER = '33333333-3333-4333-8333-333333333333';
const UNNAMED = '55555555-5555-4555-8555-555555555555';
const at = (d: string) => new Date(`2026-09-${d}T08:00:00.000Z`);

const decision = (id: string, decidedByUserId: string) => ({
  id,
  tenantId: 'test-tenant',
  broadcastId: ID,
  versionId: 'v1',
  round: 1,
  decision: 'changes_requested' as const,
  reason: 'The date is wrong',
  decidedByUserId,
  decidedByContactId: 'dddddddd-0000-4000-8000-000000000001',
  decidedAt: at('03'),
});

describe('listBroadcastVersions — who decided (M7)', () => {
  it('each decision carries the decider’s display name; an unknown or unnamed user is null', async () => {
    const store = makeFakeApprovalStore({
      broadcasts: [makeApprovalBroadcast({ broadcastId: ID, status: 'changes_requested', currentRound: 1 })],
      versions: [
        makeApprovalVersion({ id: 'v0', broadcastId: ID, versionNo: 0, authoredByRole: 'member_self_service', sentToMemberAt: at('01'), createdAt: at('01') }),
        makeApprovalVersion({ id: 'v1', broadcastId: ID, versionNo: 1, sentToMemberAt: at('02'), createdAt: at('02') }),
      ],
      decisions: [decision('d1', DECIDER), decision('d2', UNNAMED)],
    });
    const result = await listBroadcastVersions(
      {
        tenant: TENANT,
        broadcastsRepo: store.broadcastsRepo,
        versionsRepo: store.versionsRepo,
        decisionsRepo: store.decisionsRepo,
        names: makeFakeActorNameDirectory({ [DECIDER]: 'Anna Andersson', [UNNAMED]: null }),
        audit: makeRecordingF7Audit(),
      },
      { broadcastId: ID, actorUserId: 'staff-1', requestId: null },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.decisions.map((d) => [d.id, d.decidedByName])).toEqual([
      ['d1', 'Anna Andersson'],
      ['d2', null],
    ]);
  });
});
