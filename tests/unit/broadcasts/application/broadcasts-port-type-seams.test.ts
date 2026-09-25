/**
 * #400 — type-level locks on the F7 / F119 port seams, in the pattern of
 * `f119-audit-payload-shapes.test.ts`: the `@ts-expect-error` lines are the
 * test. If a seam is loosened so the forbidden call compiles again, the
 * directive becomes unused and `pnpm typecheck` fails. The runtime assertions
 * are incidental, except where a section says otherwise.
 */
import { describe, expect, it } from 'vitest';
import { asTenantContext, type TenantSlug } from '@/modules/tenants';
import { asBroadcastId, asBroadcastVersionId, type Broadcast } from '@/modules/broadcasts/domain/broadcast';
import {
  TRANSITION_FIELDS,
  type BroadcastsRepo,
} from '@/modules/broadcasts/application/ports/broadcasts-repo';
import type { BroadcastVersionsRepo } from '@/modules/broadcasts/application/ports/broadcast-versions-repo';
import type { BroadcastDecisionsRepo } from '@/modules/broadcasts/application/ports/broadcast-decisions-repo';
import type { BroadcastApprovalScrubPort } from '@/modules/broadcasts/application/ports/broadcast-approval-scrub-port';
import type { MemberPortalRecipientPort } from '@/modules/broadcasts/application/ports/member-portal-recipient-port';
import type { BroadcastQueueReads } from '@/modules/broadcasts/application/ports/broadcast-queue-reads';
import type {
  EblastApprovalLifecycleKind,
  EblastNotificationEnqueue,
} from '@/modules/broadcasts/application/ports/eblast-notification-outbox-port';
import type { MemberDecisionKind } from '@/modules/broadcasts/domain/approval/member-decision';
import {
  EBLAST_LIFECYCLE_KINDS,
  EBLAST_MEMBER_DECIDED_KINDS,
  type EblastLifecycleKind,
  type EblastMemberDecidedKind,
} from '@/modules/broadcasts/infrastructure/email/broadcast-approval-emails';
import type { RecordMemberDecisionInput } from '@/modules/broadcasts/application/use-cases/approval/record-member-decision';
import type { GetMemberVersionThreadInput } from '@/modules/broadcasts/application/use-cases/approval/get-member-version-thread';
import type { ReadFormattingWarningsInput } from '@/modules/broadcasts/application/use-cases/approval/read-formatting-warnings';
import { makeApprovalBroadcast, makeFakeApprovalStore } from '../../../helpers/eblast-approval-fakes';

type TransitionFields = Parameters<BroadcastsRepo['applyTransition']>[4];

describe('#400 item 1 — applyTransition accepts only the fields the adapter writes', () => {
  it('accepts every listed field', () => {
    const fields: TransitionFields = {
      stageEnteredAt: new Date(),
      approvedVersionId: null,
      scheduledFor: null,
      subject: 'S',
    };
    expect(Object.keys(fields)).toHaveLength(4);
  });

  it('refuses a Broadcast field the adapter would silently drop', () => {
    // @ts-expect-error — not in TRANSITION_FIELDS: the Drizzle adapter would drop it
    const audience: TransitionFields = { resendAudienceId: 'aud-1' };
    // @ts-expect-error — not in TRANSITION_FIELDS: identity columns are never a transition write
    const owner: TransitionFields = { requestedByMemberId: 'mem-1' };
    expect([audience, owner]).toHaveLength(2);
  });

  it('refuses a VARIABLE typed wider than the allowlist (excess-property checks only cover literals — #400 T1)', () => {
    const repo = null as unknown as BroadcastsRepo;
    const id = asBroadcastId('11111111-1111-4111-8111-111111111111');
    // The `confirm-schedule` shape: a `let fields: Partial<Broadcast>` passed
    // on. As a variable its extra keys were never checked, so a non-listed
    // column would have compiled and been dropped by the adapter.
    const loose: Partial<Broadcast> = { scheduledFor: null };
    // @ts-expect-error — a Partial<Broadcast> variable may carry any column; the parameter refuses it
    const call = () => repo.applyTransition(null, 'test-tenant' as TenantSlug, id, 'approved', loose, 'member_approved');
    // @ts-expect-error — the same through an assignment
    const widened: TransitionFields = loose;
    expect([call, widened]).toHaveLength(2);
  });

  it('the tuple is the adapter allowlist: 26 distinct keys, as before #400 (runtime)', () => {
    // The adapter's inline list held 26 keys (17 F7 lifecycle + 5 F119
    // bookkeeping + proposedSendAt + the 3 promoted content columns); moving it
    // to the port must neither drop nor add one.
    expect(new Set(TRANSITION_FIELDS).size).toBe(TRANSITION_FIELDS.length);
    expect(TRANSITION_FIELDS).toHaveLength(26);
  });
});

describe('#400 item 2 — branded ids hold across the F119 seams', () => {
  const tenant = 'test-tenant' as TenantSlug;
  const broadcastId = asBroadcastId('11111111-1111-4111-8111-111111111111');
  const rawMember = '22222222-2222-4222-8222-222222222222';

  it('markSent and updateWorkingCopy take a BroadcastVersionId, never a BroadcastId', () => {
    const versions = null as unknown as BroadcastVersionsRepo;
    const versionId = asBroadcastVersionId('33333333-3333-4333-8333-333333333333');
    const ok = () => versions.markSent(tenant, versionId, new Date(), null);
    // @ts-expect-error — a BroadcastId in a version slot (the #400 `markSent(slug, broadcastId, …)` bug)
    const swapped = () => versions.markSent(tenant, broadcastId, new Date(), null);
    // @ts-expect-error — the same for the working-copy write
    const swappedWrite = () => versions.updateWorkingCopy(tenant, broadcastId, null as never, null);
    expect([ok, swapped, swappedWrite]).toHaveLength(3);
  });

  it('the member-side use-case inputs and ports take a MemberId, never a bare string', () => {
    // @ts-expect-error — the portal session's MemberId, never a bare string (feeds the cross-member check)
    const decide: Pick<RecordMemberDecisionInput, 'memberId'> = { memberId: rawMember };
    // @ts-expect-error — same for the version thread
    const thread: Pick<GetMemberVersionThreadInput, 'memberId'> = { memberId: rawMember };
    // @ts-expect-error — same for the formatting warnings
    const warnings: Pick<ReadFormattingWarningsInput, 'memberId'> = { memberId: rawMember };
    const portal = null as unknown as MemberPortalRecipientPort;
    // @ts-expect-error — the portal-recipient port is keyed on a MemberId
    const contacts = () => portal.listActivePortalContacts(asTenantContext('test-tenant'), rawMember, null);
    const scrub = null as unknown as BroadcastApprovalScrubPort;
    // @ts-expect-error — the erasure scrub is keyed on a MemberId
    const redact = () => scrub.redactVersionsForMemberInTx(null, tenant, rawMember);
    const decisions = null as unknown as BroadcastDecisionsRepo;
    // @ts-expect-error — the DSAR read is keyed on a MemberId
    const dsar = () => decisions.listByMember(tenant, rawMember, 10, null);
    expect([decide, thread, warnings, contacts, redact, dsar]).toHaveLength(6);
  });

  it('deliveryCountsFor takes BroadcastIds', () => {
    const reads = null as unknown as BroadcastQueueReads;
    const ok = () => reads.deliveryCountsFor(asTenantContext('test-tenant'), [broadcastId]);
    // @ts-expect-error — bare strings are not BroadcastIds
    const raw = () => reads.deliveryCountsFor(asTenantContext('test-tenant'), ['11111111-1111-4111-8111-111111111111']);
    expect([ok, raw]).toHaveLength(2);
  });
});

describe('#400 item 3 — an outbox enqueue carries exactly its type\'s context keys', () => {
  const to = { toEmail: 'someone@example.test', locale: 'en' } as const;
  const ids = { tenantId: 'test-tenant', broadcastId: '11111111-1111-4111-8111-111111111111' } as const;

  it('accepts the shape each of the six producers writes', () => {
    const rows: EblastNotificationEnqueue[] = [
      // submit-broadcast
      { ...to, type: 'eblast_submitted_marketing', contextData: { ...ids, recipientUserId: 'u-1' } },
      // record-member-decision
      {
        ...to,
        type: 'eblast_member_decided_marketing',
        contextData: { ...ids, versionId: 'v-1', round: 1, decision: 'approved', recipientUserId: 'u-1' },
      },
      // cancel-broadcast — the member's withdrawal: no version, and no round before the first one
      {
        ...to,
        type: 'eblast_member_decided_marketing',
        contextData: { ...ids, versionId: null, round: null, decision: 'withdrawn', recipientUserId: 'u-1' },
      },
      // send-version-to-member
      { ...to, type: 'eblast_version_sent_member', contextData: { ...ids, versionId: 'v-1', round: 1 } },
      // confirm-schedule — no round
      { ...to, type: 'eblast_schedule_confirmed_member', contextData: { ...ids, versionId: 'v-1' } },
      // expire-stale-member-approvals — the member row, and a staff row naming its recipient
      {
        ...to,
        type: 'eblast_approval_lifecycle',
        contextData: { ...ids, versionId: 'v-1', round: 1, kind: 'reminder_day3', audience: 'member' },
      },
      {
        ...to,
        type: 'eblast_approval_lifecycle',
        contextData: { ...ids, versionId: 'v-1', round: 1, kind: 'expired_day30', audience: 'staff', recipientUserId: 'u-1' },
      },
    ];
    expect(rows).toHaveLength(7);
  });

  it('refuses a producer that drops or mistypes a key the consumer reads', () => {
    const bad: EblastNotificationEnqueue[] = [
      // @ts-expect-error — round N is ready: `round` is missing
      { ...to, type: 'eblast_version_sent_member', contextData: { ...ids, versionId: 'v-1' } },
      // @ts-expect-error — a staff lifecycle row must name its recipient
      { ...to, type: 'eblast_approval_lifecycle', contextData: { ...ids, versionId: 'v-1', round: 1, kind: 'reminder_day7', audience: 'staff' } },
      // @ts-expect-error — a recorded decision names the version it decided on
      { ...to, type: 'eblast_member_decided_marketing', contextData: { ...ids, versionId: null, round: 1, decision: 'approved', recipientUserId: 'u-1' } },
      // @ts-expect-error — a submitted row carries no lifecycle context (every REQUIRED key is present, so only the excess keys can fail it)
      { ...to, type: 'eblast_submitted_marketing', contextData: { ...ids, recipientUserId: 'u-1', versionId: 'v-1', round: 1, kind: 'reminder_day3', audience: 'member' } },
      // @ts-expect-error — `kind` is one of the four lifecycle steps
      { ...to, type: 'eblast_approval_lifecycle', contextData: { ...ids, versionId: 'v-1', round: 1, kind: 'reminder_day5', audience: 'member' } },
    ];
    expect(bad).toHaveLength(5);
  });
});

/** `true` only when A and B are the same set — each direction is an `Exclude<…>` that must be `never`. */
type SameSet<A, B> = [Exclude<A, B>] extends [never] ? ([Exclude<B, A>] extends [never] ? true : false) : false;

describe('#400 T3 — the dispatcher\'s kind tuples are the port\'s kinds, both ways', () => {
  it('the member-decided kinds are exactly MemberDecisionKind | \'withdrawn\'', () => {
    const tied: SameSet<EblastMemberDecidedKind, MemberDecisionKind | 'withdrawn'> = true;
    expect(tied).toBe(true);
    expect(new Set(EBLAST_MEMBER_DECIDED_KINDS)).toEqual(new Set(['approved', 'changes_requested', 'approval_withdrawn', 'withdrawn']));
  });

  it('the lifecycle kinds are exactly EblastApprovalLifecycleKind', () => {
    const tied: SameSet<EblastLifecycleKind, EblastApprovalLifecycleKind> = true;
    expect(tied).toBe(true);
    expect(EBLAST_LIFECYCLE_KINDS).toHaveLength(4);
  });
});

/**
 * #400 T5 — the fake repo the approval suites run on writes what the Drizzle
 * adapter writes: `TRANSITION_FIELDS` only. It used to merge every key, so a
 * suite could pass on a field production silently drops.
 */
describe('#400 T5 — the approval fake applies only TRANSITION_FIELDS, like the adapter (runtime)', () => {
  it('drops a key the adapter would drop, and keeps a listed one', async () => {
    const row = makeApprovalBroadcast({ status: 'in_design' });
    const store = makeFakeApprovalStore({ broadcasts: [row] });
    const at = new Date('2026-09-25T00:00:00.000Z');
    // Cast past the port type on purpose — the point is what the FAKE does with it.
    const fields = { resendAudienceId: 'aud-1', stageEnteredAt: at } as unknown as TransitionFields;
    const next = await store.broadcastsRepo.applyTransition(null, 'test-tenant' as TenantSlug, row.broadcastId, 'in_design', fields, 'in_design');
    expect(next.resendAudienceId).toBeNull();
    expect(next.stageEnteredAt).toEqual(at);
  });
});
