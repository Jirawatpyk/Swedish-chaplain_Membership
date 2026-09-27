import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent, CardDescription, CardHeader } from '@/components/ui/card';
import { InlineAlert, InlineAlertDescription, InlineAlertTitle } from '@/components/ui/inline-alert';
import { RelativeTime } from '@/components/shell/relative-time';
import { RefreshPageButton } from '@/components/shell/refresh-page-button';
import { StatusBadge } from '@/components/broadcast/admin/status-badge';
import { failureReasonToken } from '@/components/broadcast/admin/failure-reason';
import { ReviewActions } from '@/components/broadcast/admin/review-actions';
import { CancelBroadcastAction } from '@/components/broadcast/cancel-broadcast-action';
import { ManagerReadonlyBanner } from '@/components/broadcast/admin/manager-readonly-banner';
import { AuditTimeline } from '@/components/broadcast/admin/audit-timeline';
import { FormattedVersionWorkspace } from '@/components/broadcast/approval/formatted-version-workspace';
import { ScheduleConfirmAction } from '@/components/broadcast/approval/schedule-confirm-dialog';
import { StartFormattedVersionAction } from '@/components/broadcast/approval/start-formatted-version-action';
import { VersionThread, hasThreadHistory, staffThreadModel } from '@/components/broadcast/approval/version-thread';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';
import { PreviewSurface, type PreviewState } from '@/components/broadcast/use-preview-html';
import {
  canCancel,
  canTransition,
  isEblastMemberApprovalEnabled,
  isF71aUs2Enabled,
  listBroadcastVersions,
  makeGetBroadcastDeps,
  parseBroadcastId,
  readDispatchHold,
  readFormattingWarnings,
  stageOf,
  turnOf,
  type BroadcastStatus,
  type BroadcastVersion,
  type BroadcastVersionThread,
  type StaffThreadDecision,
  type FormattingWarnings,
} from '@/modules/broadcasts';
import {
  makeListBroadcastVersionsDeps,
  makeReadDispatchHoldDeps,
  makeReadFormattingWarningsDeps,
} from '@/lib/broadcast-approval-deps';
import { renderBroadcastDetailBody } from '@/lib/broadcast-detail-body';
import { runInTenant } from '@/lib/db';
import { logger } from '@/lib/logger';
import { canPerform, requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { getDateFormatLocale } from '@/lib/format-date-localised';
import { asMemberId } from '@/modules/members';

/** `CardTitle`'s type on a real `<h2>` — the shadcn `CardTitle` is a `<div>`, outside the heading tree. */
const CARD_HEADING = 'font-heading text-base leading-snug font-medium';

/** Stages whose E-Blast carries version rows (or is about to) — the thread is read only for these. */
const VERSIONED_STATUSES: ReadonlySet<BroadcastStatus> = new Set([
  'in_design',
  'awaiting_member_approval',
  'changes_requested',
  'member_approved',
]);

/** Stages where marketing's next hand-off is blocked by a missing portal user (409 `no_portal_user`). */
const PORTAL_USER_STATUSES: ReadonlySet<BroadcastStatus> = new Set(['submitted', 'in_design', 'changes_requested']);

/**
 * F119 PR-A R6.7 — the two send-time STANDING refusals: decisions about the
 * member, shown as a warning. Every other `failed_to_dispatch` token is a
 * delivery failure, shown as destructive.
 */
const STANDING_FAILURE_TOKENS: ReadonlySet<string> = new Set(['member_halted', 'member_not_in_good_standing']);

/** Stages whose next hand-off re-checks the images (the send, or the promotion). */
const IMAGE_CHECK_STATUSES: ReadonlySet<BroadcastStatus> = new Set([
  'submitted',
  'in_design',
  'changes_requested',
  'member_approved',
]);

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.review');
  return { title: t('title') };
}

export default async function AdminBroadcastDetailPage({
  params,
}: {
  readonly params: Promise<{ id: string }>;
}): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.review');
  const tActor = await getTranslations('admin.broadcasts.queue.actorRole');
  const tSegment = await getTranslations('admin.broadcasts.review.segmentType');
  const tHeader = await getTranslations('admin.broadcasts.approval.header');
  const tWarnings = await getTranslations('admin.broadcasts.approval.warnings');
  const tContent = await getTranslations('admin.broadcasts.approval.content');
  const tFeedback = await getTranslations('admin.broadcasts.approval.feedback');
  const tThread = await getTranslations('admin.broadcasts.approval.thread');
  const tButtons = await getTranslations('buttons');
  const session = await requirePagePermission('broadcasts.read');
  // 016 re-review D — evaluator-derived, never ROLE_BUNDLES: a `manager` holds
  // `broadcasts.read` only, so every action control below is ABSENT for them
  // (not disabled). `broadcasts.send` is the schedule route's key.
  const canWrite = canPerform(session.user.role, 'broadcasts.write');
  const canSend = canPerform(session.user.role, 'broadcasts.send');
  const isReadOnlyManager = !canWrite;

  const { id } = await params;
  const parsedId = parseBroadcastId(id);
  if (!parsedId.ok) {
    notFound();
  }

  const tenant = resolveTenantFromRequest();
  const deps = makeGetBroadcastDeps(tenant.slug);
  const broadcast = await deps.broadcastsRepo.findById(tenant.slug, parsedId.value);
  if (broadcast === null) {
    notFound();
  }
  const broadcastId = broadcast.broadcastId as string;
  const status = broadcast.status;
  const round = broadcast.currentRound;

  // Member display name
  const memberRows = (await runInTenant(tenant, async (tx) =>
    tx.execute(sql`
      SELECT company_name FROM members
      WHERE tenant_id = ${tenant.slug}
        AND member_id = ${broadcast.requestedByMemberId}
      LIMIT 1
    `),
  )) as unknown as Array<{ company_name: string }>;
  const memberDisplayName =
    memberRows[0]?.company_name ?? broadcast.requestedByMemberId;

  const locale = await getLocale();
  // H2 UX hardening — pin `timeZone: 'Asia/Bangkok'` so admin sees
  // Bangkok wall-time regardless of the server / browser TZ.
  const fmt = new Intl.DateTimeFormat(
    getDateFormatLocale(locale),
    { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' },
  );
  const notSet = <EmptyValue label={tHeader('notSet')} />;
  const formatDate = (d: Date | null): React.ReactNode => (d !== null ? fmt.format(d) : notSet);

  // ROUND-3 #2 — the approver reads the DOCUMENT THAT SHIPS: every body on
  // this page goes through `renderBroadcastDetailBody` (the shared renderer
  // behind the preview, the test copy and the dispatch) into the sandboxed
  // `PreviewSurface`, never `dangerouslySetInnerHTML`. A render that fails
  // shows an explicit warning panel and BLOCKS Approve (IMP-3).
  const render = (subject: string, bodyHtml: string): Promise<PreviewState> =>
    renderBroadcastDetailBody({ tenantSlug: tenant.slug, broadcastId, subject, bodyHtml, locale });
  const previewState = await render(broadcast.subject, broadcast.bodyHtml);
  const bodyRenderFailed = previewState.status === 'error';

  // F119 T063 — the version thread (T061's use case, the same read the GET
  // route serves) for every stage that carries versions: this page needs the
  // member's original, the working copy and the version that was sent /
  // approved, and T085's history list renders the rest — including, for an
  // E-Blast approved as submitted (no version row at all), its single
  // "approved as submitted" entry (FR-007), hence the `approvedAt` arm.
  const readsThread = VERSIONED_STATUSES.has(status) || round >= 1 || broadcast.approvedAt !== null;
  const thread = readsThread ? await readThread(tenant.slug, broadcast.broadcastId, session.user.id) : null;
  const original = thread?.memberOriginal?.version ?? null;
  const workingCopy = status === 'in_design' ? (thread?.workingCopy?.version ?? null) : null;
  const shownVersion = workingCopy ?? latestRelevantVersion(thread);

  // The member's original is the record's own content until the approved
  // version is promoted into it (`member_approved → approved`, FR-012a), so
  // the record's render is reused unless the two differ.
  const originalPreview =
    original === null
      ? null
      : original.subject === broadcast.subject && original.bodyHtml === broadcast.bodyHtml
        ? previewState
        : await render(original.subject, original.bodyHtml);

  // T152 — read once, per request. It gates only the `submitted → in_design`
  // edge, so it only changes what this page offers on `submitted`.
  const memberApprovalOn = isEblastMemberApprovalEnabled();

  // Standing warnings (contract § Page contracts). A read, not a gate: the
  // send and the promotion re-check both under their row lock. On
  // `submitted` they concern a formatting round only the flag opens, so while
  // it is off the page reads nothing and shows nothing new (FR-034 — "behave
  // as today"); in-flight stages keep them in both flag states.
  const warnings =
    status === 'submitted' && !memberApprovalOn
      ? null
      : await readWarnings(tenant.slug, broadcastId, status, broadcast.requestedByMemberId, (shownVersion ?? broadcast).bodyHtml);
  // A thread that was read and could not be: say so, rather than falling back
  // to the record body (or an empty history) as if nothing were wrong. Keyed
  // on the SAME condition as the read (PR #392 review C2) — a closed or
  // approved E-Blast that ran a round reads its history too.
  const threadUnavailable = readsThread && thread === null;
  const showNoPortalUser = warnings !== null && !warnings.hasPortalUser && PORTAL_USER_STATUSES.has(status);
  const unsafeImages = warnings !== null && IMAGE_CHECK_STATUSES.has(status) ? warnings.unsafeImages : [];

  // ---- Affordances (the SERVER decides which controls exist) ---------------
  //
  // T152 — the flag gates the `submitted → in_design` edge in the use case;
  // hiding the button is a UI affordance only, never the gate. From
  // `changes_requested`, and from `member_approved`/`approved` once a round
  // has run, the route answers 201 in both flag states (FR-034 — an in-flight
  // E-Blast stays completable), so the control follows the route, not the flag.
  const voidsApproval = (status === 'member_approved' || status === 'approved') && round >= 1;
  const showStart =
    canWrite && ((status === 'submitted' && memberApprovalOn) || status === 'changes_requested' || voidsApproval);
  const showWorkspace = canWrite && workingCopy !== null && original !== null;
  // Rendered only when it is shown read-only (the workspace previews its own).
  const shownPreview =
    shownVersion === null || showWorkspace ? null : await render(shownVersion.subject, shownVersion.bodyHtml);
  const showSchedule = canSend && (status === 'member_approved' || (status === 'approved' && round >= 1));
  // M3 — what starting a version costs from this stage, so the island asks
  // (or not) before it posts: from `submitted` it ends approve-as-submitted.
  const startConfirm = status === 'submitted' ? 'leaves_submitted' : voidsApproval ? 'voids_approval' : 'none';
  // F119 T051 — Cancel reads the Domain cut-off (`canCancel`), the same policy
  // the `/cancel` use case enforces. B1 — Approve is approve-AS-SUBMITTED, so
  // it stays `submitted`-only (and refuses content the server could not
  // render, IMP-3); Reject follows the Domain edge T081 widened
  // (`canTransition(status, 'rejected')` — every pre-send stage but
  // `approved`), which is what the `/reject` use case enforces.
  const isCancellable = canCancel(status);
  const showApprove = canWrite && status === 'submitted' && !bodyRenderFailed;
  const showReject = canWrite && canTransition(status, 'rejected');
  const showReview = showApprove || showReject;
  const showActionRow = canWrite && (isCancellable || showReview || showStart || showSchedule);

  // F119 PR-A — why a `failed_to_dispatch` E-Blast was not sent. The stored
  // reason is a lookup hint (`failureReasonToken`), never display text; a token
  // with no sentence in the catalogue reads the generic one (`t.has`).
  const failureToken = status === 'failed_to_dispatch' ? failureReasonToken(broadcast.failureReason) : null;
  const failureKey = failureToken === null ? null : `failureReason.${failureToken}`;
  const failureReasonText =
    failureKey !== null && t.has(failureKey) ? t(failureKey) : t('failureReason.generic');
  // R6.7 — a standing refusal is a decision about the member (warning); any
  // other token is a delivery failure (destructive).
  const failureTone = failureToken !== null && STANDING_FAILURE_TOKENS.has(failureToken) ? 'warning' : 'destructive';

  // F119 PR-A R1 — a due `approved` E-Blast the cron is HOLDING because the
  // member's membership is awaiting payment (the same decision the cron makes;
  // the use case answers `false` without a read for any row that is not due).
  const dispatchHeld = await readHeld(tenant.slug, broadcastId, {
    status,
    scheduledFor: broadcast.scheduledFor,
    memberId: broadcast.requestedByMemberId,
  });

  const turn = turnOf(status);
  // M2 — the Round row speaks only where a round exists or can still start:
  // with the flag off, `submitted` has no formatting round (FR-034 — "behave
  // as today"). At round 0, "not sent to the member yet" is true only while
  // a version can still be sent (`submitted`, `in_design`); an E-Blast
  // approved as submitted, rejected or cancelled at round 0 had no round.
  const showRoundRow = !(status === 'submitted' && !memberApprovalOn);
  const roundValue: React.ReactNode =
    round >= 1
      ? String(round)
      : status === 'submitted' || status === 'in_design'
        ? tHeader('roundNone')
        : <EmptyValue label={tHeader('roundNoRound')} />;
  // F119 T085 (FR-011, FR-032) — the history: every version sent to the
  // member and every decision with its reason, attached to the version it
  // concerns. It sits BELOW the workspace (UX review M6), so a long thread
  // never pushes the editor below the fold. The unsent working copy is not
  // part of it (it is the workspace).
  const threadModel = thread === null ? null : staffThreadModel(thread, (d) => fmt.format(d));
  // FR-011 + UX review M6 — marketing formats the next version with the
  // member's LATEST request in view, above the workspace. Only a request for
  // changes or a withdrawn approval carries one; an approval leaves nothing
  // to act on.
  const memberFeedback =
    status === 'changes_requested' || status === 'in_design' ? latestChangeRequest(thread) : null;
  const feedbackVersion =
    memberFeedback === null
      ? null
      : (thread?.sentVersions.find((e) => e.version.id === memberFeedback.versionId)?.version.versionNo ??
        memberFeedback.round);
  // Who asked (FR-032), where the name is known; "the member" otherwise.
  const feedbackWithdrawn = memberFeedback?.decision === 'approval_withdrawn';
  const feedbackName = memberFeedback?.decidedByName ?? null;
  const feedbackTitle =
    memberFeedback === null || feedbackVersion === null
      ? null
      : feedbackName !== null
        ? tThread(feedbackWithdrawn ? 'withdrawnBy' : 'changesRequestedBy', { version: feedbackVersion, name: feedbackName })
        : tFeedback(feedbackWithdrawn ? 'withdrawnTitle' : 'changesRequestedTitle', { version: feedbackVersion });

  return (
    <DetailContainer>
      {/* B3 UX hardening — the status badge sits in `role="status"` so AT
          announces the new stage when an action refreshes the page. */}
      <PageHeader
        title={broadcast.subject}
        subtitle={`${memberDisplayName} · ${t('subtitle')}`}
        badge={
          <span role="status" aria-live="polite" className="inline-flex max-w-full min-w-0">
            <StatusBadge status={status} />
          </span>
        }
      />
      {isReadOnlyManager ? <ManagerReadonlyBanner /> : null}

      {/* F119 PR-A — "marketing sees why it is blocked": the stored reason,
          translated (never the raw value, which can be provider free text),
          under the status it explains. A note, not a live region: it is page
          content, not an event. Body text, not the muted empty-sentinel tone. */}
      {status === 'failed_to_dispatch' ? (
        <InlineAlert tone={failureTone} role="note" data-testid="eblast-failure-reason">
          <InlineAlertTitle>{t('failureReasonTitle')}</InlineAlertTitle>
          <InlineAlertDescription>
            <span className="block break-words leading-relaxed text-foreground">{failureReasonText}</span>
          </InlineAlertDescription>
        </InlineAlert>
      ) : null}
      {/* F119 PR-A R1 — held, not failed: it sends by itself once the member
          pays, or fails if the membership ends. Info, not warning: nothing is
          wrong with the E-Blast and staff have nothing to fix. */}
      {dispatchHeld ? (
        <InlineAlert tone="info" role="note" data-testid="eblast-dispatch-held">
          <InlineAlertTitle>{t('dispatchHeldTitle')}</InlineAlertTitle>
          <InlineAlertDescription>
            <span className="block break-words leading-relaxed text-foreground">{t('dispatchHeldBody')}</span>
          </InlineAlertDescription>
        </InlineAlert>
      ) : null}

      {threadUnavailable ? (
        <InlineAlert tone="destructive" data-testid="eblast-thread-unavailable">
          <InlineAlertTitle>{tContent('threadUnavailableTitle')}</InlineAlertTitle>
          <InlineAlertDescription>
            {/* PR #392 review D7 — the working copy / original / formatting
                claim holds only on a versioned stage; elsewhere (approved,
                sent, closed) only the history is missing. */}
            <span className="block">
              {VERSIONED_STATUSES.has(status)
                ? tContent('threadUnavailableBody')
                : tContent('threadUnavailableHistoryBody')}
            </span>
            <span className="mt-2 block">
              <RefreshPageButton label={tButtons('retry')} />
            </span>
          </InlineAlertDescription>
        </InlineAlert>
      ) : null}
      {showNoPortalUser ? (
        <InlineAlert tone="warning" role="note" data-testid="eblast-warning-no-portal-user">
          <InlineAlertTitle>{tWarnings('noPortalUserTitle')}</InlineAlertTitle>
          <InlineAlertDescription>
            {tWarnings('noPortalUserBody', { company: memberDisplayName })}
          </InlineAlertDescription>
        </InlineAlert>
      ) : null}
      {unsafeImages.length > 0 ? (
        <InlineAlert tone="warning" role="note" data-testid="eblast-warning-unsafe-images">
          <InlineAlertTitle>{tWarnings('unsafeImagesTitle')}</InlineAlertTitle>
          <InlineAlertDescription>
            <span className="block">{tWarnings('unsafeImagesBody')}</span>
            <ul className="mt-1 list-disc space-y-1 pl-5">
              {unsafeImages.map((image) => (
                <li key={image.src} className="break-all">
                  <code className="text-xs">{image.src}</code>
                  {' — '}
                  {tWarnings(`reason.${image.reason}`)}
                </li>
              ))}
            </ul>
          </InlineAlertDescription>
        </InlineAlert>
      ) : null}

      {/* F119 T063 — the stage header (contract § Page contracts; FR-026):
          whose turn, time in the stage, the round, and the member's proposed
          time beside the confirmed one (FR-016 — both, separately). The
          stage itself is the header badge above. */}
      <section aria-labelledby="eblast-stage-title" data-stage={stageOf(status)}>
        <Card>
          <CardHeader>
            <h2 id="eblast-stage-title" className={CARD_HEADING}>
              {tHeader('title')}
            </h2>
          </CardHeader>
          <CardContent>
            <dl className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Field
                label={tHeader('turn')}
                value={turn === null ? <EmptyValue label={tHeader('turnValue.none')} /> : tHeader(`turnValue.${turn}`)}
                testId="eblast-whose-turn"
              />
              <div>
                <dt className="text-xs uppercase tracking-wide text-muted-foreground">
                  {tHeader('timeInStage')}
                </dt>
                <dd className="mt-1 text-sm">
                  <RelativeTime iso={broadcast.stageEnteredAt.toISOString()} title={fmt.format(broadcast.stageEnteredAt)} />
                </dd>
              </div>
              {showRoundRow ? <Field label={tHeader('round')} value={roundValue} testId="eblast-round" /> : null}
              <Field label={tHeader('proposedSendAt')} value={formatDate(broadcast.proposedSendAt)} />
              <Field label={t('fields.scheduledFor')} value={formatDate(broadcast.scheduledFor)} />
            </dl>
          </CardContent>
        </Card>
      </section>

      <section aria-labelledby="eblast-details-title">
        <Card>
          <CardHeader>
            <h2 id="eblast-details-title" className={CARD_HEADING}>
              {tHeader('detailsTitle')}
            </h2>
          </CardHeader>
          <CardContent>
            {/* B1 UX hardening — `<dl>/<dt>/<dd>` so each label↔value pair is
                announced as a unit (WCAG 1.3.1). */}
            <dl className="grid gap-3 sm:grid-cols-2">
              <Field label={t('fields.submittedBy')} value={memberDisplayName} />
              <Field label={t('fields.actorRole')} value={tActor(broadcast.actorRole)} />
              <Field label={t('fields.submittedAt')} value={formatDate(broadcast.submittedAt)} />
              <Field
                label={t('fields.segment')}
                value={tSegment(broadcast.segmentType as Parameters<typeof tSegment>[0])}
              />
              <Field label={t('fields.recipientCount')} value={String(broadcast.estimatedRecipientCount)} />
            </dl>
          </CardContent>
        </Card>
      </section>

      {memberFeedback !== null && feedbackTitle !== null ? (
        <InlineAlert tone="info" role="note" data-testid="eblast-member-feedback">
          <InlineAlertTitle>{feedbackTitle}</InlineAlertTitle>
          <InlineAlertDescription>
            <span className="block whitespace-pre-line break-words text-foreground">{memberFeedback.reason}</span>
          </InlineAlertDescription>
        </InlineAlert>
      ) : null}

      {showWorkspace && workingCopy !== null && original !== null && originalPreview !== null ? (
        // The writing tool, with the member's original beside it read-only.
        // Keyed on the concurrency token so a refresh after a conflict
        // remounts it from the server's current copy.
        <FormattedVersionWorkspace
          key={workingCopy.updatedAt.toISOString()}
          broadcastId={broadcastId}
          workingCopy={{
            id: workingCopy.id,
            versionNo: workingCopy.versionNo,
            subject: workingCopy.subject,
            bodyHtml: workingCopy.bodyHtml,
            noteToMember: workingCopy.noteToMember,
            updatedAt: workingCopy.updatedAt.toISOString(),
          }}
          original={{ subject: original.subject, preview: originalPreview }}
          imagesEnabled={isF71aUs2Enabled()}
        />
      ) : shownVersion !== null && shownPreview !== null && original !== null && originalPreview !== null ? (
        // Read-only comparison: the version marketing is on (or sent, or the
        // member approved) beside the member's original — the manager's view
        // of `in_design`, and everyone's view after a version was sent.
        <div className="grid gap-6 lg:grid-cols-2" data-testid="eblast-version-comparison">
          <ContentCard
            id="eblast-shown-version-title"
            title={
              workingCopy !== null
                ? tContent('workingCopyTitle', { version: shownVersion.versionNo })
                : tContent('sentVersionTitle', { version: shownVersion.versionNo })
            }
            subject={shownVersion.subject}
            preview={shownPreview}
            note={shownVersion.noteToMember}
            noteLabel={tContent('noteLabel')}
          />
          <ContentCard
            id="eblast-original-title"
            title={tContent('originalTitle')}
            description={tContent('originalHint')}
            subject={original.subject}
            preview={originalPreview}
          />
        </div>
      ) : (
        <section aria-labelledby="eblast-body-title">
          <Card>
            <CardHeader>
              <h2 id="eblast-body-title" className={CARD_HEADING}>
                {t('fields.body')}
              </h2>
            </CardHeader>
            <CardContent>
              {bodyRenderFailed ? (
                <div role="alert" className="rounded-md border border-destructive/40 bg-destructive-surface p-3 text-sm text-destructive">
                  <p className="font-medium">{t('bodyRenderFailedTitle')}</p>
                  <p className="text-xs">{t('bodyRenderFailedHint')}</p>
                </div>
              ) : (
                <PreviewSurface state={previewState} height={DETAIL_PREVIEW_FRAME_HEIGHT} />
              )}
            </CardContent>
          </Card>
        </section>
      )}

      {threadModel !== null && hasThreadHistory(threadModel) ? (
        <VersionThread audience="staff" model={threadModel} />
      ) : null}

      <AuditTimeline tenantId={tenant.slug} broadcastId={broadcastId} />

      {/* One right-aligned action row for the stage's staff actions. Every
          control here is ABSENT for a `manager` (read-only), never disabled.
          "Send to member" lives with the working copy it sends. */}
      {showActionRow ? (
        <div className="flex flex-wrap items-center justify-end gap-2" data-testid="eblast-action-row">
          {isCancellable ? (
            <CancelBroadcastAction broadcastId={broadcastId} surface="admin" subject={broadcast.subject} />
          ) : null}
          {showStart ? (
            <StartFormattedVersionAction broadcastId={broadcastId} confirm={startConfirm} round={round} />
          ) : null}
          {showSchedule ? (
            <ScheduleConfirmAction
              broadcastId={broadcastId}
              status={status === 'approved' ? 'approved' : 'member_approved'}
              proposedSendAt={broadcast.proposedSendAt?.toISOString() ?? null}
              scheduledFor={broadcast.scheduledFor?.toISOString() ?? null}
            />
          ) : null}
          {showReview ? (
            <ReviewActions broadcastId={broadcastId} showApprove={showApprove} showReject={showReject} />
          ) : null}
        </div>
      ) : null}
    </DetailContainer>
  );
}

async function readThread(
  tenantSlug: string,
  broadcastId: Parameters<typeof listBroadcastVersions>[1]['broadcastId'],
  actorUserId: string,
): Promise<BroadcastVersionThread | null> {
  const result = await listBroadcastVersions(makeListBroadcastVersionsDeps(tenantSlug), {
    broadcastId,
    actorUserId,
    requestId: null,
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
      errorId: 'M119.admin.detail.thread',
    },
    'broadcasts.detail_page.thread_read_failed',
  );
  return null;
}

/**
 * F119 PR-A R1 — whether the cron is holding this due E-Blast for the member's
 * payment. A failed read shows no note (logged, so it is not silent): the note
 * is information, and the cron re-decides every tick regardless.
 */
async function readHeld(
  tenantSlug: string,
  broadcastId: string,
  input: Parameters<typeof readDispatchHold>[1],
): Promise<boolean> {
  const result = await readDispatchHold(makeReadDispatchHoldDeps(tenantSlug), input);
  if (result.ok) return result.value;
  logger.warn(
    { tenantId: tenantSlug, broadcastId, err: result.error.errClass, errorId: 'M119.admin.detail.dispatch_hold' },
    'broadcasts.detail_page.dispatch_hold_read_failed',
  );
  return false;
}

/** The member's latest decision when it asked for changes (or withdrew an approval) with a reason. */
function latestChangeRequest(thread: BroadcastVersionThread | null): StaffThreadDecision | null {
  const latest = thread?.decisions.at(-1) ?? null;
  if (latest === null || latest.decision === 'approved' || latest.reason === null) return null;
  return latest;
}

/** The version the member approved, else the latest one sent to them. */
function latestRelevantVersion(thread: BroadcastVersionThread | null): BroadcastVersion | null {
  if (thread === null) return null;
  const approved = thread.sentVersions.find((e) => e.version.id === thread.approvedVersionId);
  return approved?.version ?? thread.sentVersions.at(-1)?.version ?? null;
}

async function readWarnings(
  tenantSlug: string,
  broadcastId: string,
  status: BroadcastStatus,
  memberId: string,
  bodyHtml: string,
): Promise<FormattingWarnings | null> {
  if (!PORTAL_USER_STATUSES.has(status) && !IMAGE_CHECK_STATUSES.has(status)) return null;
  const result = await readFormattingWarnings(makeReadFormattingWarningsDeps(tenantSlug), { memberId: asMemberId(memberId), bodyHtml });
  if (result.ok) return result.value;
  // A failed read shows no warning (logged, so it is not silent); the send
  // and the promotion still refuse under their row lock.
  logger.warn(
    { tenantId: tenantSlug, broadcastId, err: result.error.errKind, errorId: 'M119.admin.detail.warnings' },
    'broadcasts.detail_page.warnings_read_failed',
  );
  return null;
}

function ContentCard({
  id,
  title,
  description,
  subject,
  preview,
  note,
  noteLabel,
}: {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  readonly subject: string;
  readonly preview: PreviewState;
  readonly note?: string | null;
  readonly noteLabel?: string;
}): React.ReactElement {
  return (
    <section aria-labelledby={id} className="min-w-0">
      <Card className="h-full">
        <CardHeader>
          <h2 id={id} className={CARD_HEADING}>
            {title}
          </h2>
          {description !== undefined ? <CardDescription>{description}</CardDescription> : null}
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-sm font-medium break-words">{subject}</p>
          {note !== undefined && note !== null && noteLabel !== undefined ? (
            <p className="rounded-md bg-muted/50 px-3 py-2 text-sm">
              <span className="block text-xs uppercase tracking-wide text-muted-foreground">{noteLabel}</span>
              <span className="whitespace-pre-line">{note}</span>
            </p>
          ) : null}
          <PreviewSurface state={preview} height={DETAIL_PREVIEW_FRAME_HEIGHT} />
        </CardContent>
      </Card>
    </section>
  );
}

/** An empty value: a muted dash for sight (the empty sentinel), a word for AT. */
function EmptyValue({ label }: { readonly label: string }): React.ReactElement {
  return (
    <>
      <span aria-hidden="true" className="text-muted-foreground">—</span>
      <span className="sr-only">{label}</span>
    </>
  );
}

function Field({
  label,
  value,
  testId,
}: {
  readonly label: string;
  readonly value: React.ReactNode;
  readonly testId?: string;
}): React.ReactElement {
  // B1 UX hardening — `<dl>` parent, so each Field is a `<div>` wrapping
  // a `<dt>`/`<dd>` pair.
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="mt-1 text-sm" data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
