/**
 * F119 T141a — the PR-2 half of the FR-049 widening of `GET /api/broadcasts/[id]`
 * (contracts/portal-eblast-approval-api.md § `GET /api/broadcasts/[id]`,
 * plan Amendment 5): `stage`, `whoseTurn`, `round`, `proposedSendAt`,
 * `confirmedSendAt`, `expiresAt`, and the body rule — while the E-Blast is
 * awaiting the member, the content is the latest version SENT to them (what
 * they are signing off); otherwise it is the record's own content.
 *
 * The route runs the REAL `readMemberEblastView` over the in-memory approval
 * store; its own read and tenant gate are served from the same store.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import type { Broadcast } from '@/modules/broadcasts/domain/broadcast';
import { makeApprovalBroadcast, makeApprovalVersion } from '../../helpers/eblast-approval-fakes';
import { resetVersionHarness, routeParams } from '../../helpers/eblast-version-route-harness';

vi.mock('@/lib/tenant-context', async () => (await import('../../helpers/eblast-version-route-harness')).tenantContextMock());
vi.mock('@/lib/logger', async () => (await import('../../helpers/eblast-version-route-harness')).loggerMock());
vi.mock('@/lib/auth-session', async () => (await import('../../helpers/eblast-version-route-harness')).authSessionMock());
vi.mock('@/lib/member-context', async () => (await import('../../helpers/eblast-version-route-harness')).memberContextMock());
vi.mock('@/lib/broadcast-approval-deps', async () =>
  (await import('../../helpers/eblast-version-route-harness')).approvalDepsMock(),
);
vi.mock('@/modules/broadcasts', async () =>
  (await import('../../helpers/eblast-version-route-harness')).broadcastsBarrelMock(),
);

const ID = makeApprovalBroadcast().broadcastId as string;
const SENT_1 = new Date('2026-09-21T08:00:00.000Z');
const SENT_2 = new Date('2026-09-23T08:00:00.000Z');
const V0 = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000000', versionNo: 0, sentToMemberAt: new Date('2026-09-20T08:00:00Z') });
const V1 = makeApprovalVersion({ versionNo: 1, subject: 'Round 1 subject', bodyHtml: '<p>Round 1 body</p>', sentToMemberAt: SENT_1 });
const V2 = makeApprovalVersion({
  id: 'aaaaaaaa-0000-4000-8000-000000000002',
  versionNo: 2,
  subject: 'Round 2 subject',
  bodyHtml: '<p>Round 2 body</p>',
  bodySource: '{"round":2}',
  sentToMemberAt: SENT_2,
});

const get = async () => {
  const { GET } = await import('@/app/api/broadcasts/[id]/route');
  return GET(new NextRequest(`http://localhost/api/broadcasts/${ID}`, { method: 'GET' }), routeParams(ID));
};
const seed = (broadcast: Broadcast, versions = [V0, V1, V2]) => resetVersionHarness({ broadcasts: [broadcast], versions });

beforeEach(() => {
  seed(makeApprovalBroadcast());
});

describe('GET /api/broadcasts/[id] — the workflow fields (T141a, FR-049)', () => {
  it('awaiting the member → the body is the latest sent version and whoseTurn is member', async () => {
    seed(makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 2, stageEnteredAt: SENT_2 }));
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      status: 'awaiting_member_approval',
      stage: 'awaiting_member_approval',
      whoseTurn: 'member',
      round: 2,
      proposedSendAt: '2026-10-01T03:00:00.000Z',
      confirmedSendAt: null,
      expiresAt: '2026-10-23T08:00:00.000Z',
      subject: 'Round 2 subject',
      bodyHtml: '<p>Round 2 body</p>',
      bodySource: '{"round":2}',
    });
  });

  it.each([
    ['draft', makeApprovalBroadcast({ status: 'draft', submittedAt: null })],
    [
      'sent',
      makeApprovalBroadcast({
        status: 'sent',
        currentRound: 2,
        approvedVersionId: V2.id,
        scheduledFor: new Date('2026-10-02T05:30:00.000Z'),
        sentAt: new Date('2026-10-02T05:31:00.000Z'),
      }),
    ],
  ] as const)('in %s → the body is the record\'s own content and whoseTurn is null', async (status, broadcast) => {
    seed(broadcast);
    const body = await (await get()).json();
    expect(body).toMatchObject({
      status,
      whoseTurn: null,
      expiresAt: null,
      subject: 'Member original subject',
      bodyHtml: '<p>Member original body</p>',
    });
    expect(body.stage).toBe(status);
  });

  it('once scheduled, confirmedSendAt is the time marketing confirmed; before that it is null', async () => {
    const confirmed = new Date('2026-10-02T05:30:00.000Z');
    seed(makeApprovalBroadcast({ status: 'approved', currentRound: 1, approvedVersionId: V1.id, scheduledFor: confirmed }));
    const scheduled = await (await get()).json();
    expect(scheduled).toMatchObject({ stage: 'scheduled', whoseTurn: null, round: 1, confirmedSendAt: confirmed.toISOString() });

    // `submitted`: `scheduled_for` still holds the member's request — the proposal, not a confirmation.
    seed(makeApprovalBroadcast());
    const submitted = await (await get()).json();
    expect(submitted).toMatchObject({ stage: 'awaiting_marketing_review', whoseTurn: 'marketing', confirmedSendAt: null });
  });

  // F119 round-4 B9 — this state is an invariant breach (the send stamps the
  // version and moves the stage in ONE tx; the lifecycle cron treats it as
  // one). The read used to fall back to the record's own content — the
  // member's ORIGINAL, presented as what they are being asked to sign off.
  // It is now an error: logged under its own errorId (ids only), 500, and no
  // content to approve.
  it('awaiting the member with no version recorded as sent → 500, logged as missing_sent_version, no content to sign off', async () => {
    seed(makeApprovalBroadcast({ status: 'awaiting_member_approval', currentRound: 1, stageEnteredAt: SENT_1 }), [V0]);
    const { logger } = await import('@/lib/logger');
    vi.mocked(logger.error).mockClear();
    const res = await get();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toMatchObject({ error: { code: 'internal_error' } });
    expect(JSON.stringify(body)).not.toContain('Member original');
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ errorId: 'M119.portal.detail.missing_sent_version', broadcastId: ID, round: 1 }),
      'broadcasts.member_view.missing_sent_version',
    );
    // Ids only — never the subject or the body.
    expect(JSON.stringify(vi.mocked(logger.error).mock.calls)).not.toContain('Member original');
  });

  it('marketing\'s turn with an unsent working copy → the record\'s own content, never the working copy', async () => {
    const workingCopy = makeApprovalVersion({ id: 'aaaaaaaa-0000-4000-8000-000000000003', versionNo: 3, subject: 'WIP', sentToMemberAt: null });
    seed(makeApprovalBroadcast({ status: 'in_design', currentRound: 2 }), [V0, V1, V2, workingCopy]);
    const body = await (await get()).json();
    expect(body).toMatchObject({ stage: 'in_design', whoseTurn: 'marketing', subject: 'Member original subject' });
  });
});
