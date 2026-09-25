/**
 * F119 T141a — the workflow half of `GET /api/broadcasts/[id]` (FR-049 / US6,
 * plan Amendment 5; contracts/portal-eblast-approval-api.md
 * § `GET /api/broadcasts/[id]`).
 *
 * Given a broadcast the caller has ALREADY resolved and owner-checked (the
 * route's tenant + owning-member gate runs first), returns what the member's
 * detail shows:
 *
 *   - the workflow summary — `stage`, `whoseTurn`, `round`, the proposed and
 *     confirmed send times, `expiresAt` (`_member-view.ts`);
 *   - the content: while the E-Blast is AWAITING THE MEMBER, the latest
 *     version SENT to them — that is what they are being asked to sign off,
 *     not their original — otherwise the record's own content. "Content" is
 *     the FR-012 triple (subject, body, body source), taken together from one
 *     source so a subject can never be paired with another version's body.
 *
 * The versions are read only while awaiting the member: every other stage
 * shows the record, so no other stage pays for the read.
 *
 * Awaiting the member with NO version sent to them is an invariant breach
 * (the send stamps the version and moves the stage in one tx; the lifecycle
 * cron treats the same state as one). Round-4 B9: it is logged under
 * `M119.portal.detail.missing_sent_version` (ids only) and THROWS — never a
 * fallback to the record's own content, which is the member's ORIGINAL and
 * would be presented as what they are being asked to sign off.
 *
 * Throws on an infrastructure fault (the route answers 500). Pure
 * Application — no framework imports.
 */
import { logger } from '@/lib/logger';
import type { TenantContext } from '@/modules/tenants';
import type { Broadcast } from '../../../domain/broadcast';
import type { BroadcastVersionsRepo } from '../../ports/broadcast-versions-repo';
import type { ApprovalBroadcastsRepo } from './_approval-tx';
import { latestSentVersion, memberWorkflowSummary, type MemberWorkflowSummary } from './_member-view';

export interface ReadMemberEblastViewDeps {
  readonly tenant: TenantContext;
  readonly broadcastsRepo: Pick<ApprovalBroadcastsRepo, 'withTx'>;
  readonly versionsRepo: Pick<BroadcastVersionsRepo, 'listByBroadcast'>;
}

export interface MemberEblastView {
  readonly summary: MemberWorkflowSummary;
  readonly content: { readonly subject: string; readonly bodyHtml: string; readonly bodySource: string };
  /** The version the content came from; null when it is the record's own. */
  readonly shownVersionId: string | null;
}

export async function readMemberEblastView(deps: ReadMemberEblastViewDeps, broadcast: Broadcast): Promise<MemberEblastView> {
  const summary = memberWorkflowSummary(broadcast);
  const own = { subject: broadcast.subject, bodyHtml: broadcast.bodyHtml, bodySource: broadcast.bodySource };
  if (broadcast.status !== 'awaiting_member_approval') {
    return { summary, content: own, shownVersionId: null };
  }
  const versions = await deps.broadcastsRepo.withTx((tx) =>
    deps.versionsRepo.listByBroadcast(deps.tenant.slug, broadcast.broadcastId, tx),
  );
  const shown = latestSentVersion(versions);
  if (shown === null) {
    logger.error(
      {
        tenantId: deps.tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        round: broadcast.currentRound,
        errorId: 'M119.portal.detail.missing_sent_version',
      },
      'broadcasts.member_view.missing_sent_version',
    );
    throw new Error('awaiting_member_approval broadcast has no version sent to the member');
  }
  return {
    summary,
    content: { subject: shown.subject, bodyHtml: shown.bodyHtml, bodySource: shown.bodySource },
    shownVersionId: shown.id,
  };
}
