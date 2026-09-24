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
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowLeft } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { InlineAlert, InlineAlertDescription, InlineAlertTitle } from '@/components/ui/inline-alert';
import { RefreshPageButton } from '@/components/shell/refresh-page-button';
import { getBroadcastStatusBadgeProps } from '@/components/broadcast/status-badge-mapping';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';
import { PreviewSurface, type PreviewState } from '@/components/broadcast/use-preview-html';
import { MemberSignOffActions } from '@/components/broadcast/approval/member-sign-off-actions';
import {
  VersionThread,
  hasThreadHistory,
  memberThreadModel,
} from '@/components/broadcast/approval/version-thread';
import { makeGetMemberVersionThreadDeps } from '@/lib/broadcast-approval-deps';
import { isPortalPathAllowed } from '@/lib/lapsed-portal-scope';
import { loadMembershipAccess } from '@/lib/load-membership-access';
import { renderBroadcastDetailBody } from '@/lib/broadcast-detail-body';
import { cn } from '@/lib/utils';
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
import { randomUUID } from 'node:crypto';

/** `CardTitle`'s type on a real `<h2>` — the shadcn `CardTitle` is a `<div>`, outside the heading tree. */
const CARD_HEADING = 'font-heading text-base font-medium leading-snug';

/** Where the E-Blast list lives (the benefits page's broadcasts tab). */
const BENEFITS_PATH = '/portal/benefits';

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

  // UX review M5 — the same request-cached, audit-free access read the
  // benefits page gates on; a terminated member cannot open the E-Blast list,
  // so their Back leads to the dashboard. Fails open to `full`.
  const access = await loadMembershipAccess(tenant.slug, memberId);
  const backToList = isPortalPathAllowed(access.access, BENEFITS_PATH);

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

  const t = await getTranslations('portal.broadcasts.detail');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const tApproval = await getTranslations('portal.broadcasts.approval');
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    // Tenant-TZ pin (#315 follow-up, server-UTC display class) — matches
    // the admin broadcast detail's H2 Bangkok pin; canonical tenant TZ.
    timeZone: env.tenant.timezone,
  });

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
          formatted: latestSent,
          formattedPreview: await render(latestSent.subject, latestSent.bodyHtml),
          original,
          originalPreview: await render(original.subject, original.bodyHtml),
        }
      : null;
  const previewState =
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
  const threadModel = thread === null ? null : memberThreadModel(thread, (d) => dateFormatter.format(d));

  const statusBadge = getBroadcastStatusBadgeProps(status);
  // Guard the i18n lookup; fall back to the raw status so a future enum
  // value degrades gracefully.
  const statusKey = status as Parameters<typeof tStatus>[0];
  const statusLabel = tStatus.has(statusKey) ? tStatus(statusKey) : status;
  // L6 — muted is the empty sentinel's colour only; a real value is not.
  const notSet = (
    <span className="text-muted-foreground">
      <span aria-hidden="true">—</span>
      <span className="sr-only">{tApproval('fields.notSet')}</span>
    </span>
  );

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <Link
        href={backToList ? `${BENEFITS_PATH}?tab=broadcasts` : '/portal'}
        className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'self-start')}
      >
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
        {backToList ? t('back') : t('backToDashboard')}
      </Link>

      {/* F119 T086 — the stage banner: the page's ONE live region. It names
          the stage, whose turn it is and — while awaiting the member — the
          expiry date. It stays mounted across a decision's refresh, so the new
          stage is announced from here, not from a second region. */}
      <InlineAlert tone="info" role="status" data-testid="eblast-stage-banner">
        <InlineAlertTitle className="flex flex-wrap items-center gap-2 text-foreground">
          <span>{t('fields.status')}</span>
          {/* F1 UX hardening — the shared `getBroadcastStatusBadgeProps` (H4)
              keeps the colour signal: rejected is destructive, sending pulses.
              UX review H3 — a Badge is `h-5 whitespace-nowrap` by default; the
              longest stage (SV `member_approved`, ~282 px) overflows the
              banner's ~246 px at 320 px, so here it may wrap. */}
          <Badge
            variant={statusBadge.variant}
            className={cn(statusBadge.className, 'h-auto max-w-full whitespace-normal text-left')}
          >
            {statusLabel}
          </Badge>
        </InlineAlertTitle>
        {summary !== null && summary.whoseTurn !== null ? (
          <InlineAlertDescription className="text-foreground">
            {summary.whoseTurn === 'marketing' ? (
              <span className="block">{tApproval('banner.turn.marketing')}</span>
            ) : latestSent !== null ? (
              <span className="block">{tApproval('banner.turn.member', { version: latestSent.versionNo })}</span>
            ) : null}
            {summary.expiresAt !== null ? (
              <span className="block">
                {tApproval('banner.expires', { date: dateFormatter.format(summary.expiresAt) })}
              </span>
            ) : null}
          </InlineAlertDescription>
        ) : null}
      </InlineAlert>

      {thread === null || missingSent ? (
        <InlineAlert tone="destructive" data-testid="eblast-thread-unavailable">
          <InlineAlertTitle>{tApproval('threadUnavailable.title')}</InlineAlertTitle>
          <InlineAlertDescription>
            <span className="block">{tApproval('threadUnavailable.body')}</span>
            <span className="mt-2 block">
              <RefreshPageButton label={tApproval('threadUnavailable.refresh')} />
            </span>
          </InlineAlertDescription>
        </InlineAlert>
      ) : null}

      <Card role="region" aria-labelledby="broadcast-detail-fields-heading">
        {/* The subject value is the card's title (and its accessible
            region name); "Subject" is a small overline label so the value
            reads as the dominant element rather than being subordinate to
            its own label (UX R2-I3 — the text-h4 label outweighed the 16px
            value).

            F119 T141 — the title moved into `CardHeader` and carries the
            portal's card-heading treatment: a REAL `<h2>` with the
            `CardTitle` font classes, never the shadcn `CardTitle` `<div>`,
            which would drop the subject out of the SR heading tree
            (`portal/account/page.tsx` HubCard, `portal/profile/page.tsx`
            SectionHeading — the same fix twice before this one). */}
        <CardHeader className="space-y-1">
          <p className="text-caption uppercase tracking-wide text-muted-foreground">
            {t('fields.subject')}
          </p>
          <h2 id="broadcast-detail-fields-heading" className={CARD_HEADING}>
            {broadcast.subject}
          </h2>
        </CardHeader>
        <CardContent className="space-y-3">
          {/* F119 T086 — the status moved into the stage banner above; the
              member's proposed send time stays visible beside the confirmed
              one throughout (FR-016), right above the compare view. */}
          <dl className="grid grid-cols-2 gap-3 text-sm">
            <div>
              <dt className="text-xs text-muted-foreground">{t('fields.recipients')}</dt>
              <dd className="mt-1 tabular-nums">{broadcast.estimatedRecipientCount}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('fields.submittedAt')}</dt>
              <dd className="mt-1">
                {broadcast.submittedAt !== null
                  ? dateFormatter.format(new Date(broadcast.submittedAt))
                  : notSet}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">{t('fields.sentAt')}</dt>
              <dd className="mt-1">
                {broadcast.sentAt !== null ? dateFormatter.format(new Date(broadcast.sentAt)) : notSet}
              </dd>
            </div>
            {summary !== null ? (
              <>
                <div>
                  <dt className="text-xs text-muted-foreground">{tApproval('fields.proposedSendAt')}</dt>
                  <dd className="mt-1" data-testid="eblast-proposed-send-at">
                    {summary.proposedSendAt !== null ? dateFormatter.format(summary.proposedSendAt) : notSet}
                  </dd>
                </div>
                <div>
                  <dt className="text-xs text-muted-foreground">{tApproval('fields.confirmedSendAt')}</dt>
                  <dd className="mt-1">
                    {summary.confirmedSendAt !== null ? dateFormatter.format(summary.confirmedSendAt) : notSet}
                  </dd>
                </div>
              </>
            ) : null}
          </dl>
        </CardContent>
      </Card>

      {compare !== null ? (
        // FR-008 — DOM order is the layout: the formatted version FIRST, the
        // original after it. One grid, so a phone stacks them (formatted on
        // top, the original below on this same page — never a link away, never
        // a tab that unmounts the decision controls) and ≥ lg sets them side
        // by side.
        <div className="grid gap-6 lg:grid-cols-2" data-testid="eblast-compare">
          <section
            aria-labelledby="eblast-formatted-title"
            data-testid="eblast-formatted-version"
            className="min-w-0"
          >
            <Card className="h-full">
              <CardHeader>
                <h2 id="eblast-formatted-title" className={CARD_HEADING}>
                  {tApproval('compare.formattedTitle', { version: compare.formatted.versionNo })}
                </h2>
                <CardDescription>{tApproval('compare.formattedHint')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                {compare.formatted.noteToMember !== null ? (
                  <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">
                    <span className="block text-xs uppercase tracking-wide text-muted-foreground">
                      {tApproval('compare.noteLabel')}
                    </span>
                    <span className="whitespace-pre-line break-words">{compare.formatted.noteToMember}</span>
                  </p>
                ) : null}
                <p className="text-sm font-medium break-words">{compare.formatted.subject}</p>
                <PreviewSurface state={compare.formattedPreview} height={DETAIL_PREVIEW_FRAME_HEIGHT} />
              </CardContent>
            </Card>
          </section>
          <section
            aria-labelledby="eblast-original-title"
            data-testid="eblast-member-original"
            className="min-w-0"
          >
            <Card className="h-full">
              <CardHeader>
                <h2 id="eblast-original-title" className={CARD_HEADING}>
                  {tApproval('compare.originalTitle')}
                </h2>
                <CardDescription>{tApproval('compare.originalHint')}</CardDescription>
              </CardHeader>
              <CardContent className="space-y-3">
                <p className="text-sm font-medium break-words">{compare.original.subject}</p>
                <PreviewSurface state={compare.originalPreview} height={DETAIL_PREVIEW_FRAME_HEIGHT} />
              </CardContent>
            </Card>
          </section>
        </div>
      ) : previewState !== null ? (
        // F119 T141 (US6-AS2, FR-049) — the content itself, rendered as the
        // recipient sees it. `PreviewSurface` owns the sandboxed frame and the
        // translated empty / error states; this page only decides WHICH
        // document goes in it.
        <Card role="region" aria-labelledby="broadcast-detail-body-heading">
          <CardHeader>
            <h2 id="broadcast-detail-body-heading" className={CARD_HEADING}>
              {t('fields.content')}
            </h2>
          </CardHeader>
          <CardContent>
            <PreviewSurface state={previewState} height={DETAIL_PREVIEW_FRAME_HEIGHT} />
          </CardContent>
        </Card>
      ) : null}

      {/* F119 T084 — the decisions this stage allows, right under what they
          decide on. DV-12's member Cancel ("Withdraw E-Blast") lives in the
          same island: `getMemberBroadcast` gates VISIBILITY (a cross-member
          probe 404s above) and every POST is re-guarded by its use case. */}
      {canDecide || canWithdrawApproval || canWithdrawEblast ? (
        <MemberSignOffActions
          broadcastId={broadcast.broadcastId as string}
          subject={broadcast.subject}
          version={latestSent === null ? null : { id: latestSent.id, versionNo: latestSent.versionNo }}
          canDecide={canDecide}
          canWithdrawApproval={canWithdrawApproval}
          canWithdrawEblast={canWithdrawEblast}
        />
      ) : null}

      {threadModel !== null && hasThreadHistory(threadModel) ? (
        <VersionThread audience="member" model={threadModel} />
      ) : null}

      {/* AS3 — Delivery breakdown (delivered / bounced / complained /
          soft-bounced / sent / total). Exposes testids for T129; uses
          aria-labelledby (not aria-label) so the visible h2 is the
          single accessible name (avoids SR double-announce — WCAG
          1.3.1 + 4.1.2). UX review L7 — shown once a send has begun
          (before it every count is zero), with its heading in the
          `CardHeader` in the page's card-heading type, like every other
          card here. */}
      {DELIVERY_STATUSES.has(status) ? (
        <Card
          role="region"
          data-testid="delivery-breakdown"
          aria-labelledby="delivery-breakdown-heading"
        >
          <CardHeader>
            <h2 id="delivery-breakdown-heading" className={CARD_HEADING}>
              {t('delivery.title')}
            </h2>
          </CardHeader>
          <CardContent className="grid grid-cols-2 gap-3 sm:grid-cols-3">
            <DeliveryStat
              label={t('delivery.delivered')}
              value={delivery.delivered}
              testId="delivery-delivered-count"
            />
            <DeliveryStat
              label={t('delivery.bounced')}
              value={delivery.bounced}
              testId="delivery-bounced-count"
            />
            <DeliveryStat
              label={t('delivery.complained')}
              value={delivery.complained}
              testId="delivery-complained-count"
            />
            <DeliveryStat
              label={t('delivery.softBounced')}
              value={delivery.softBounced}
              testId="delivery-soft-bounced-count"
            />
            <DeliveryStat
              label={t('delivery.sent')}
              value={delivery.sent}
              testId="delivery-sent-count"
            />
            <DeliveryStat
              label={t('delivery.total')}
              value={delivery.total}
              testId="delivery-total-count"
            />
          </CardContent>
        </Card>
      ) : null}
    </DetailContainer>
  );
}

/**
 * The member's approval-round thread. A failed read is logged and answers
 * null: the page still shows the record, and says the history is missing,
 * rather than offering decisions on a version it could not name.
 */
async function readMemberThread(
  tenantSlug: string,
  broadcastId: Parameters<typeof getMemberVersionThread>[1]['broadcastId'],
  memberId: string,
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

function DeliveryStat({
  label,
  value,
  testId,
}: {
  label: string;
  value: number;
  testId: string;
}): React.ReactElement {
  // `<dl>/<dt>/<dd>` carries the term/definition association at the
  // semantic level — screen readers announce "Delivered: 128" as a
  // unit (WCAG SC 1.3.2 meaningful sequence). Same pattern as the
  // sibling broadcast-detail-fields section above.
  return (
    <dl data-testid={testId} className="space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-2xl font-semibold tabular-nums">{value}</dd>
    </dl>
  );
}
