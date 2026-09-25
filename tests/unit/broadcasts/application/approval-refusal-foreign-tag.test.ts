/**
 * #400 item 5 — `ApprovalRefusal` carries the use case that raised it, and each
 * of the five approval-round catch sites maps ONLY its own.
 *
 * `ApprovalRefusal<E>` loses `E` at runtime, so the catch sites used to cast
 * `e.refusal as XError` on the strength of "every throw is local". A refusal
 * raised by some other use case (a shared helper, a nested call) would then be
 * read as this one's — a `kind` the route's `assertNever` does not know, i.e. a
 * 500 dressed up as a mapped refusal, or worse a wrong 4xx. The tag is checked
 * before the cast, and a foreign refusal is rethrown untouched.
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext } from '@/modules/tenants';
import { asMemberId } from '@/modules/members';
import { ApprovalRefusal, isOwnRefusal } from '@/modules/broadcasts/application/use-cases/approval/_approval-tx';
import {
  confirmSchedule,
  type ConfirmScheduleError,
} from '@/modules/broadcasts/application/use-cases/approval/confirm-schedule';
import { recordMemberDecision } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import {
  saveFormattedVersion,
  type SaveFormattedVersionError,
} from '@/modules/broadcasts/application/use-cases/approval/save-formatted-version';
import { sendVersionToMember } from '@/modules/broadcasts/application/use-cases/approval/send-version-to-member';
import { startFormattedVersion } from '@/modules/broadcasts/application/use-cases/approval/start-formatted-version';
import {
  makeApprovalBroadcast,
  makeApprovalVersion,
  makeFakeApprovalStore,
  makeFakeImageAllowlist,
  makeFakeMarketingDirectory,
  makeFakePortalRecipients,
  makeFakeSendStanding,
  makeRecordingF7Audit,
} from '../../../helpers/eblast-approval-fakes';

const ACTOR = '44444444-4444-4444-8444-444444444444';
const BROADCAST = makeApprovalBroadcast({ status: 'in_design' });
const passThrough = { sanitize: (html: string) => html };

function harness() {
  const store = makeFakeApprovalStore({ broadcasts: [BROADCAST], versions: [makeApprovalVersion({ versionNo: 0 })] });
  // A refusal raised by ANOTHER use case, surfacing inside this one's tx.
  // (Both halves cast: the tag is not one of the five, so no payload type fits it.)
  const foreign = new ApprovalRefusal('some-other-use-case' as never, { kind: 'not_found' } as never);
  store.broadcastsRepo.lockForUpdate.mockRejectedValueOnce(foreign);
  const common = {
    tenant: asTenantContext('test-tenant'),
    broadcastsRepo: store.broadcastsRepo,
    versionsRepo: store.versionsRepo,
    audit: makeRecordingF7Audit(),
    clock: { now: () => store.now },
  };
  return { store, foreign, common };
}

describe('ApprovalRefusal — a refusal from another use case is rethrown, never mapped (#400 item 5)', () => {
  it('startFormattedVersion', async () => {
    const { foreign, common } = harness();
    await expect(
      startFormattedVersion(
        { ...common, memberApprovalEnabled: true },
        { broadcastId: BROADCAST.broadcastId, actorUserId: ACTOR, actorRole: null, requestId: null },
      ),
    ).rejects.toBe(foreign);
  });

  it('saveFormattedVersion', async () => {
    const { foreign, common } = harness();
    await expect(
      saveFormattedVersion(
        { ...common, sanitizer: passThrough, imageAllowlist: makeFakeImageAllowlist() },
        {
          broadcastId: BROADCAST.broadcastId,
          actorUserId: ACTOR,
          requestId: null,
          subject: 'Subject',
          bodyHtml: '<p>Body</p>',
          bodySource: '{}',
          noteToMember: null,
          expectedUpdatedAt: new Date('2026-09-24T09:00:00.000Z'),
        },
      ),
    ).rejects.toBe(foreign);
  });

  it('sendVersionToMember', async () => {
    const { store, foreign, common } = harness();
    await expect(
      sendVersionToMember(
        {
          ...common,
          sanitizer: passThrough,
          imageAllowlist: makeFakeImageAllowlist(),
          portalRecipients: makeFakePortalRecipients(),
          outbox: store.outbox,
        },
        { broadcastId: BROADCAST.broadcastId, actorUserId: ACTOR, actorRole: null, requestId: null },
      ),
    ).rejects.toBe(foreign);
  });

  it('recordMemberDecision', async () => {
    const { store, foreign, common } = harness();
    await expect(
      recordMemberDecision(
        {
          ...common,
          decisionsRepo: store.decisionsRepo,
          marketingDirectory: makeFakeMarketingDirectory(),
          outbox: store.outbox,
        },
        {
          broadcastId: BROADCAST.broadcastId,
          memberId: asMemberId(BROADCAST.requestedByMemberId),
          actorUserId: ACTOR,
          actorRole: null,
          contactId: '55555555-5555-4555-8555-555555555555',
          versionId: makeApprovalVersion().id,
          decision: 'approved',
          reason: null,
          requestId: null,
        },
      ),
    ).rejects.toBe(foreign);
  });

  it('confirmSchedule', async () => {
    const { store, foreign, common } = harness();
    await expect(
      confirmSchedule(
        {
          ...common,
          imageAllowlist: makeFakeImageAllowlist(),
          portalRecipients: makeFakePortalRecipients(),
          outbox: store.outbox,
          sendStanding: makeFakeSendStanding(),
        },
        { broadcastId: BROADCAST.broadcastId, actorUserId: ACTOR, actorRole: null, requestId: null, mode: { mode: 'send_now' } },
      ),
    ).rejects.toBe(foreign);
  });
});

/**
 * #400 T2 — the tag and the payload are ONE type: `ApprovalRefusal<U>` carries
 * `RefusalByUseCase[U]`, so a use case can neither raise another's refusal
 * under its own tag nor need a cast to read its own. The `@ts-expect-error`
 * lines are the test (`pnpm typecheck` fails if a directive becomes unused).
 */
describe('ApprovalRefusal — the tag names the payload type (#400 T2)', () => {
  it('a payload must be the tagged use case\'s error', () => {
    const own = new ApprovalRefusal('confirm-schedule', { kind: 'round_zero' });
    // @ts-expect-error — `no_working_copy` is a save-formatted-version refusal, not a confirm-schedule one
    const mismatched = new ApprovalRefusal('confirm-schedule', { kind: 'no_working_copy' });
    expect([own.useCase, mismatched.useCase]).toEqual(['confirm-schedule', 'confirm-schedule']);
  });

  it('isOwnRefusal narrows the payload to the tagged error — no cast at the catch site', () => {
    const e: unknown = new ApprovalRefusal('save-formatted-version', { kind: 'no_working_copy' });
    if (!isOwnRefusal(e, 'save-formatted-version')) throw new Error('expected its own refusal');
    const refusal: SaveFormattedVersionError = e.refusal;
    // @ts-expect-error — narrowed to save-formatted-version's error, which is not confirm-schedule's
    const wrong: ConfirmScheduleError = e.refusal;
    expect([refusal.kind, wrong.kind]).toEqual(['no_working_copy', 'no_working_copy']);
  });
});
