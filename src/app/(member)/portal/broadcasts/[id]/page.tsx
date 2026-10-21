/**
 * F7 US3 T133 — Member broadcast detail page.
 *
 * Spec authority: spec.md US3 AS3 (delivery breakdown — delivered /
 * bounced / complained counts) + AS5 (cross-member probe → 404 + audit).
 *
 * Layout: `DetailContainer`. Read-only post-submit view. Uses the
 * `getMemberBroadcast` use-case which:
 *   - Returns ok if the requesting member owns the broadcast
 *   - Emits `broadcast_cross_member_probe` audit + returns
 *     `broadcast.not_found` if a different member owns it
 *   - Returns `broadcast.not_found` if the broadcast doesn't exist
 *
 * In all "not found" paths the route surfaces 404 (Next.js `notFound()`)
 * — anti-enumeration; the route does NOT distinguish between absent
 * row and cross-member probe.
 *
 * F119 T086 (FR-008, FR-009, FR-010, FR-015a, FR-032) — the member's
 * SIGN-OFF view. The approval round is read once through
 * `getMemberVersionThread` (the same member projection as
 * `GET …/[id]/versions`, so marketing's unsent working copy is never here):
 *
 *   - a stage banner — the page's ONE live region (`role="status"`) — names
 *     the stage, whose turn it is and, while awaiting the member, the expiry
 *     date; after a decision the page refreshes and the banner announces the
 *     new stage;
 *   - once a version was sent, the compare view: the latest SENT version
 *     (marketing's note above it) FIRST and the member's original after it,
 *     in one `lg:grid-cols-2` grid — side by side on a wide screen, stacked
 *     formatted-then-original on a phone, both on this page;
 *   - the decision controls the stage allows (`MemberSignOffActions`), then
 *     the version thread (`VersionThread`, "you" / "the chamber" only).
 *
 * Membership standing does not gate this page: reading and deciding are not
 * benefit actions, and `lapsed-portal-scope.ts` exempts this exact path so a
 * lapsed member can still sign off or withdraw (spec § Edge Cases). It is
 * read once, for the Back link only: a terminated member's benefits page is
 * blocked, so their Back leads to the dashboard instead (UX review M5).
 */
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { memberThreadModel } from '@/components/broadcast/approval/version-thread';
import type { PreviewState } from '@/components/broadcast/use-preview-html';
import { makeGetMemberVersionThreadDeps } from '@/lib/broadcast-approval-deps';
import { renderBroadcastDetailBody } from '@/lib/broadcast-detail-body';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  canCancel,
  getMemberBroadcast,
  getMemberVersionThread,
  makeGetMemberBroadcastDeps,
  parseBroadcastId,
  type BroadcastStatus,
  type MemberVersionThread,
  type MemberVisibleVersion,
} from '@/modules/broadcasts';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { env } from '@/lib/env';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  PortalBroadcastDetailView,
  type PortalBroadcastDetailViewProps,
} from './_components/portal-broadcast-detail-view';
import { randomUUID } from 'node:crypto';
import { portalBroadcastBack } from './_lib/portal-broadcast-back';

/**
 * UX review L7 — the statuses at which a send has begun, so the delivery
 * breakdown means something. Before them it is all zeros (awaiting the
 * member, in design, scheduled …) and is not shown.
 */
const DELIVERY_STATUSES: ReadonlySet<BroadcastStatus> = new Set<BroadcastStatus>([
  'sending',
  'sent',
  'partially_sent',
  'partial_delivery_accepted',
  'failed_to_dispatch',
]);

/* The detail page is per-(tenant, member, broadcastId) — caching across
 * users doesn't apply, and the route depends on the member-scoped
 * `runInTenant` lookup. Force dynamic rendering so `notFound()` returns
 * a true HTTP 404 (Next.js 16 sets static-cache responses to 200 even
 * when the rendered body is the not-found UI; AS5 spec mandates 404). */
export const dynamic = 'force-dynamic';

/**
 * F119 T141 — the read-back frame is taller than the compose pane's 420 px:
 * this screen has the full 72 rem column to itself and the member is reading,
 * not typing beside it. Fixed, so the frame scrolls internally instead of
 * growing the page.
 *
 * T155 finding U1 — the number lives in `preview-frame-heights.ts` so
 * `loading.tsx` reserves exactly this, not a copy of it.
 */

/**
 * F119 T141 (US6-AS2, FR-049) — the body the member reads back is the REAL
 * email, produced by `renderBroadcastDetailBody` and shown in the shared
 * sandboxed `PreviewSurface`. ROUND-3 #2 moved that helper to
 * `src/lib/broadcast-detail-body.ts` so the STAFF detail page reads the same
 * document: it was rendering the raw sanitised body instead, which is not
 * what ships.
 *
 * PR-1 rendered the broadcast RECORD's own content. Since F119 T086 that is
 * what shows only until a version is sent; after that the compare view shows
 * the latest SENT version beside the member's original (T141a's "latest sent
 * version while awaiting the member", on the screen).
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.broadcasts.detail');
  return { title: t('title') };
}

export default async function BroadcastDetailPage(props: {
  params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const { id } = await props.params;
  const session = await requireSession('member');
  const tenant = resolveTenantFromRequest();

  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(tenant, session.user.id);
  if (!memberLookup.ok) {
    // 404 covers both "user has no member row" (legitimate) and "DB
    // outage" (incident). Discriminate via the error code so a real
    // outage is logged rather than masked as a routine not-found —
    // anti-enumeration response stays the same either way.
    if (memberLookup.error.code !== 'repo.not_found') {
      logger.error(
        {
          err: memberLookup.error,
          tenantId: tenant.slug,
          userId: session.user.id,
        },
        'broadcasts.detail_page.member_lookup_unexpected_error',
      );
    }
    return notFound();
  }
  const memberId = memberLookup.value.memberId;

  // Validate ID shape early — invalid UUID = not found (no audit
  // emission; we cannot probe a non-existent row by an invalid id).
  // Log at debug so a bot probing malformed IDs is observable in
  // dashboards as a `bad_id_shape` probe-rate (correlates with the
  // `not_found` enumeration log emitted by the use-case).
  const parsed = parseBroadcastId(id);
  if (!parsed.ok) {
    logger.debug(
      {
        tenantId: tenant.slug,
        memberId,
        rawId: id,
        userId: session.user.id,
      },
      'broadcasts.detail_page.invalid_id_shape',
    );
    return notFound();
  }

  const requestId = randomUUID();
  const result = await getMemberBroadcast(makeGetMemberBroadcastDeps(tenant.slug), {
    memberId,
    broadcastId: parsed.value,
    actorUserId: session.user.id,
    requestId,
  });
  if (!result.ok) return notFound();

  const { broadcast, delivery } = result.value;
  const status = broadcast.status;

  // UX review M5 — a terminated member cannot open the E-Blast list, so their
  // Back leads to the dashboard (shared with the not-found state).
  const back = await portalBroadcastBack(tenant.slug, memberId);

  // F119 T086 — the approval round, from the member projection (sent
  // versions only). Owner already proven above, so this read cannot probe.
  const thread = await readMemberThread(tenant.slug, parsed.value, memberId, session.user.id, requestId);
  const summary = thread?.summary ?? null;
  const original = thread?.versions.find((v) => v.versionNo === 0) ?? null;
  const latestSent = thread === null ? null : latestSentVersion(thread.versions);
  // PR #392 review D3 — awaiting the member with no version SENT to them. The
  // record's own content is the member's ORIGINAL, never what they are asked
  // to sign off, so none is shown (the route's `readMemberEblastView` refuses
  // the same state). With the thread read it is an invariant breach — the
  // send stamps the version and moves the stage in one tx — so it is logged
  // (ids only) and the page fails closed behind the history alert; with the
  // thread unread, that alert is already up.
  const awaitingWithoutSent = status === 'awaiting_member_approval' && latestSent === null;
  const missingSent = awaitingWithoutSent && thread !== null;
  if (missingSent) {
    logger.error(
      {
        tenantId: tenant.slug,
        broadcastId: broadcast.broadcastId as string,
        round: broadcast.currentRound,
        errorId: 'M119.portal.detail.missing_sent_version',
      },
      'broadcasts.detail_page.missing_sent_version',
    );
  }

  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    // Tenant-TZ pin (#315 follow-up, server-UTC display class) — matches
    // the admin broadcast detail's H2 Bangkok pin; canonical tenant TZ.
    timeZone: env.tenant.timezone,
  });
  const format = (d: Date | string | null): string | null => (d === null ? null : dateFormatter.format(new Date(d)));

  const render = (subject: string, bodyHtml: string): Promise<PreviewState> =>
    renderBroadcastDetailBody({
      tenantSlug: tenant.slug,
      broadcastId: broadcast.broadcastId as string,
      subject,
      bodyHtml,
      locale,
    });
  // FR-008 — once a version was sent, the latest SENT one beside the
  // member's original; before that, the record's own content alone.
  const compare =
    latestSent !== null && original !== null
      ? {
          formatted: {
            versionNo: latestSent.versionNo,
            noteToMember: latestSent.noteToMember,
            subject: latestSent.subject,
            preview: await render(latestSent.subject, latestSent.bodyHtml),
          },
          original: { subject: original.subject, preview: await render(original.subject, original.bodyHtml) },
        }
      : null;
  const body =
    compare === null && !awaitingWithoutSent ? await render(broadcast.subject, broadcast.bodyHtml) : null;

  // ---- Which decisions exist (the SERVER decides; the island performs) ----
  // Approve / Request changes: the member's turn, on a sent version.
  // Withdraw approval: an approval in force — `member_approved` / `approved`
  // with `approvedVersionId` set, which only a member approval in a round
  // writes (approve-as-submitted leaves it null: nothing to withdraw).
  // Withdraw E-Blast: the Domain cut-off, the one `/cancel` enforces.
  const canDecide = summary?.whoseTurn === 'member' && latestSent !== null;
  const canWithdrawApproval =
    (status === 'member_approved' || status === 'approved') &&
    summary !== null &&
    summary.approvedVersionId !== null &&
    latestSent !== null;
  const canWithdrawEblast = canCancel(status);

  const turn: PortalBroadcastDetailViewProps['turn'] =
    summary === null || summary.whoseTurn === null
      ? null
      : summary.whoseTurn === 'marketing'
        ? { kind: 'marketing' }
        : latestSent !== null
          ? { kind: 'member', version: latestSent.versionNo }
          : null;

  return PortalBroadcastDetailView({
    back,
    status,
    turn,
    expiresAt: summary !== null && summary.whoseTurn !== null ? format(summary.expiresAt) : null,
    threadUnavailable: thread === null || missingSent,
    subject: broadcast.subject,
    fields: {
      recipients: broadcast.estimatedRecipientCount,
      submittedAt: format(broadcast.submittedAt),
      sentAt: format(broadcast.sentAt),
      sendTimes:
        summary === null
          ? null
          : { proposed: format(summary.proposedSendAt), confirmed: format(summary.confirmedSendAt) },
    },
    compare,
    body,
    signOff:
      canDecide || canWithdrawApproval || canWithdrawEblast
        ? {
            broadcastId: broadcast.broadcastId as string,
            subject: broadcast.subject,
            version: latestSent === null ? null : { id: latestSent.id, versionNo: latestSent.versionNo },
            canDecide,
            canWithdrawApproval,
            canWithdrawEblast,
          }
        : null,
    thread: thread === null ? null : memberThreadModel(thread, (d) => dateFormatter.format(d)),
    delivery: DELIVERY_STATUSES.has(status) ? delivery : null,
  });
}

/**
 * The member's approval-round thread. A failed read is logged and answers
 * null: the page still shows the record, and says the history is missing,
 * rather than offering decisions on a version it could not name.
 */
async function readMemberThread(
  tenantSlug: string,
  broadcastId: Parameters<typeof getMemberVersionThread>[1]['broadcastId'],
  memberId: Parameters<typeof getMemberVersionThread>[1]['memberId'],
  actorUserId: string,
  requestId: string,
): Promise<MemberVersionThread | null> {
  const result = await getMemberVersionThread(makeGetMemberVersionThreadDeps(tenantSlug), {
    broadcastId,
    memberId,
    actorUserId,
    requestId,
  });
  if (result.ok) return result.value;
  logger.warn(
    {
      tenantId: tenantSlug,
      broadcastId,
      reason: result.error.kind,
      // Round-4 B10 — a server_error carries its error class; log it, as
      // `readWarnings` does (pino drops the undefined of a not_found).
      err: result.error.kind === 'server_error' ? result.error.errKind : undefined,
      errorId: 'M119.portal.detail.thread',
    },
    'broadcasts.detail_page.thread_read_failed',
  );
  return null;
}

/** The highest-numbered version SENT to the member — what awaits (or carried) their decision. */
function latestSentVersion(versions: readonly MemberVisibleVersion[]): MemberVisibleVersion | null {
  return versions.reduce<MemberVisibleVersion | null>(
    (latest, v) =>
      v.versionNo >= 1 && v.sentToMemberAt !== null && (latest === null || v.versionNo > latest.versionNo) ? v : latest,
    null,
  );
}
