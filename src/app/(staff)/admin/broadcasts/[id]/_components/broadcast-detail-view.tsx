/**
 * Spec 122 US12c-1 (T1228) — the staff E-Blast approval-round detail's RENDER,
 * split from `page.tsx` so the AURA preview harness can draw every stage from
 * fixtures (the events-list and dashboard views set the pattern). The page
 * keeps every read, guard and affordance decision and hands this view the
 * results; nothing here reads the database or decides what a user may do.
 * The audit timeline reads the database itself, so it arrives as a slot.
 */
import { getFormatter, getLocale, getTranslations } from 'next-intl/server';
import { Alert, Card, Stat } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { RelativeTime } from '@/components/shell/relative-time';
import { RefreshPageButton } from '@/components/shell/refresh-page-button';
import { StatusBadge } from '@/components/broadcast/admin/status-badge';
import { ReviewActions } from '@/components/broadcast/admin/review-actions';
import { DetailActionBar } from '@/components/broadcast/admin/detail-action-bar';
import { formatStageDuration } from '@/components/broadcast/admin/stage-duration';
import { OriginalDisclosure } from '@/components/broadcast/admin/original-disclosure';
import { CancelBroadcastAction } from '@/components/broadcast/cancel-broadcast-action';
import { ManagerReadonlyBanner } from '@/components/broadcast/admin/manager-readonly-banner';
import { FormattedVersionWorkspace } from '@/components/broadcast/approval/formatted-version-workspace';
import { ScheduleConfirmAction } from '@/components/broadcast/approval/schedule-confirm-dialog';
import {
  StartFormattedVersionAction,
  type StartConfirm,
} from '@/components/broadcast/approval/start-formatted-version-action';
import { VersionThread, hasThreadHistory, type VersionThreadModel } from '@/components/broadcast/approval/version-thread';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';
import { EmailFrame } from '@/components/broadcast/email-frame';
import { PreviewSurface, type PreviewState } from '@/components/broadcast/use-preview-html';
import { stageOf, type BroadcastStatus, type BroadcastVersion } from '@/modules/broadcasts';

/** A field's label and value on AURA's type (the label in the secondary tone, never the empty-sentinel dash). */
const FIELD_LABEL = 'aura-text-caption text-[var(--aura-fg-secondary)]';
const FIELD_VALUE = 'mt-1 text-sm break-words';

/** Board `Admin-broadcast-sent` — the delivery events the provider reported, by outcome. */
export interface DeliveryCounts {
  readonly delivered: number;
  readonly bounced: number;
  readonly softBounced: number;
  readonly complained: number;
  /** Every recipient row, handed over included (`sent`) — the caption's count. */
  readonly recipients: number;
}

/** A tile's label wraps inside the tile at 200% text on a phone (WCAG 1.4.4). */
const STAT_WRAP = 'min-w-0 [overflow-wrap:anywhere]';

/** A count takes its tone only when there is something to report. */
function toned(n: number, tone: 'positive' | 'danger'): string {
  return n > 0 ? `text-[var(--aura-fg-${tone})] tabular-nums` : 'tabular-nums';
}

export interface BroadcastDetailViewProps {
  readonly broadcastId: string;
  readonly broadcast: {
    readonly subject: string;
    readonly stageEnteredAt: Date;
    readonly proposedSendAt: Date | null;
    readonly scheduledFor: Date | null;
    readonly submittedAt: Date | null;
    readonly actorRole: string;
    readonly segmentType: string;
    readonly estimatedRecipientCount: number;
  };
  readonly status: BroadcastStatus;
  readonly round: number;
  readonly memberDisplayName: string;
  /** Bangkok wall time, the page's formatter. */
  readonly fmt: Intl.DateTimeFormat;
  readonly isReadOnlyManager: boolean;
  /** Why a `failed_to_dispatch` E-Blast was not sent — already translated. */
  readonly failure: { readonly tone: 'warning' | 'danger'; readonly text: string } | null;
  readonly dispatchHeld: boolean;
  readonly threadUnavailable: boolean;
  /** Whether the stage carries version rows (the thread-unavailable note says more then). */
  readonly versionedStage: boolean;
  readonly showNoPortalUser: boolean;
  readonly unsafeImages: ReadonlyArray<{ readonly src: string; readonly reason: string }>;
  readonly turn: 'marketing' | 'member' | null;
  readonly memberApprovalOn: boolean;
  /** The member's latest request for changes — its title already translated. */
  readonly memberFeedback: { readonly title: string; readonly reason: string } | null;
  readonly showWorkspace: boolean;
  readonly workingCopy: BroadcastVersion | null;
  readonly original: BroadcastVersion | null;
  readonly originalPreview: PreviewState | null;
  readonly shownVersion: BroadcastVersion | null;
  readonly shownPreview: PreviewState | null;
  readonly previewState: PreviewState;
  readonly bodyRenderFailed: boolean;
  /** The delivery counts once sending has begun (`sending` onward); null before. */
  readonly delivery: DeliveryCounts | null;
  readonly imagesEnabled: boolean;
  readonly threadModel: VersionThreadModel | null;
  /** The audit timeline (it reads the database itself). */
  readonly audit: React.ReactNode;
  readonly showActionRow: boolean;
  readonly isCancellable: boolean;
  readonly showStart: boolean;
  readonly startConfirm: StartConfirm;
  readonly showSchedule: boolean;
  readonly showApprove: boolean;
  readonly showReject: boolean;
}

export async function BroadcastDetailView({
  broadcastId,
  broadcast,
  status,
  round,
  memberDisplayName,
  fmt,
  isReadOnlyManager,
  failure,
  dispatchHeld,
  threadUnavailable,
  versionedStage,
  showNoPortalUser,
  unsafeImages,
  turn,
  memberApprovalOn,
  memberFeedback,
  showWorkspace,
  workingCopy,
  original,
  originalPreview,
  shownVersion,
  shownPreview,
  previewState,
  bodyRenderFailed,
  delivery,
  imagesEnabled,
  threadModel,
  audit,
  showActionRow,
  isCancellable,
  showStart,
  startConfirm,
  showSchedule,
  showApprove,
  showReject,
}: BroadcastDetailViewProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.review');
  const tActor = await getTranslations('admin.broadcasts.queue.actorRole');
  const tSegment = await getTranslations('admin.broadcasts.review.segmentType');
  const tHeader = await getTranslations('admin.broadcasts.approval.header');
  const tWarnings = await getTranslations('admin.broadcasts.approval.warnings');
  const tContent = await getTranslations('admin.broadcasts.approval.content');
  const tButtons = await getTranslations('buttons');
  const format = await getFormatter();

  const notSet = <EmptyValue label={tHeader('notSet')} />;
  const formatDate = (d: Date | null): React.ReactNode => (d !== null ? fmt.format(d) : notSet);
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

  // The phone bar's status line (board `Admin-broadcast-review-mobile`, parity
  // comment 20 Oct): recipients · audience · time in stage. Hidden from 640px.
  const barStatus = (
    <span data-bar-status>
      {t('barStatus', {
        recipients: broadcast.estimatedRecipientCount,
        audience: tSegment(broadcast.segmentType as Parameters<typeof tSegment>[0]),
        time: formatStageDuration(broadcast.stageEnteredAt, new Date(), await getLocale()),
      })}
    </span>
  );

  // Parity comment, 20 Oct (board `Admin-eblast-design-mobile`): while marketing
  // is writing, a phone shows the editor first and the round's facts after it.
  // Visual order only below 640px; neither card holds a focusable control.
  const afterEditorOnPhone = showWorkspace ? 'max-sm:order-2' : undefined;
  const tailOnPhone = showWorkspace ? 'max-sm:order-3' : undefined;

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
      {failure !== null ? (
        <Alert tone={failure.tone} role="note" title={t('failureReasonTitle')} data-testid="eblast-failure-reason">
          <span className="block break-words leading-relaxed">{failure.text}</span>
        </Alert>
      ) : null}
      {/* F119 PR-A R1 — held, not failed: it sends by itself once the member
          pays, or fails if the membership ends. Info, not warning: nothing is
          wrong with the E-Blast and staff have nothing to fix. */}
      {dispatchHeld ? (
        <Alert tone="info" role="note" title={t('dispatchHeldTitle')} data-testid="eblast-dispatch-held">
          <span className="block break-words leading-relaxed">{t('dispatchHeldBody')}</span>
        </Alert>
      ) : null}

      {threadUnavailable ? (
        <Alert
          tone="danger"
          title={tContent('threadUnavailableTitle')}
          action={<RefreshPageButton label={tButtons('retry')} />}
          data-testid="eblast-thread-unavailable"
        >
          {/* PR #392 review D7 — the working copy / original / formatting
              claim holds only on a versioned stage; elsewhere (approved,
              sent, closed) only the history is missing. */}
          {versionedStage
            ? tContent('threadUnavailableBody')
            : tContent('threadUnavailableHistoryBody')}
        </Alert>
      ) : null}
      {showNoPortalUser ? (
        <Alert tone="warning" role="note" title={tWarnings('noPortalUserTitle')} data-testid="eblast-warning-no-portal-user">
          {tWarnings('noPortalUserBody', { company: memberDisplayName })}
        </Alert>
      ) : null}
      {unsafeImages.length > 0 ? (
        <Alert tone="warning" role="note" title={tWarnings('unsafeImagesTitle')} data-testid="eblast-warning-unsafe-images">
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
        </Alert>
      ) : null}

      {/* F119 T063 — the stage header (contract § Page contracts; FR-026):
          whose turn, time in the stage, the round, and the member's proposed
          time beside the confirmed one (FR-016 — both, separately). The
          stage itself is the header badge above. */}
      <Card
        titleId="eblast-stage-title"
        title={tHeader('title')}
        headingLevel={2}
        data-stage={stageOf(status)}
        className={afterEditorOnPhone}
      >
        {/* Two columns on a phone too (board `Admin-broadcast-review-mobile`). */}
        <dl className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              <Field
                label={tHeader('turn')}
                value={turn === null ? <EmptyValue label={tHeader('turnValue.none')} /> : tHeader(`turnValue.${turn}`)}
                testId="eblast-whose-turn"
              />
              <div>
                <dt className={FIELD_LABEL}>
                  {tHeader('timeInStage')}
                </dt>
                <dd className={FIELD_VALUE}>
                  <RelativeTime iso={broadcast.stageEnteredAt.toISOString()} title={fmt.format(broadcast.stageEnteredAt)} />
                </dd>
              </div>
              {showRoundRow ? <Field label={tHeader('round')} value={roundValue} testId="eblast-round" /> : null}
              <Field label={tHeader('proposedSendAt')} value={formatDate(broadcast.proposedSendAt)} />
              <Field label={t('fields.scheduledFor')} value={formatDate(broadcast.scheduledFor)} />
        </dl>
      </Card>

      <Card titleId="eblast-details-title" title={tHeader('detailsTitle')} headingLevel={2} className={afterEditorOnPhone}>
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
      </Card>

      {delivery !== null ? (
        // Board `Admin-broadcast-sent` — the provider's delivery events by
        // outcome, once sending has begun (the same read the member's page uses).
        <Card titleId="eblast-delivery-title" title={t('delivery.title')} headingLevel={2} data-testid="eblast-delivery">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,9rem),1fr))] gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Stat
              className={STAT_WRAP}
              label={t('delivery.delivered')}
              value={<span className={toned(delivery.delivered, 'positive')}>{format.number(delivery.delivered)}</span>}
            />
            <Stat
              className={STAT_WRAP}
              label={t('delivery.bounced')}
              value={<span className={toned(delivery.bounced, 'danger')}>{format.number(delivery.bounced)}</span>}
            />
            <Stat
              className={STAT_WRAP}
              label={t('delivery.softBounced')}
              value={<span className="tabular-nums">{format.number(delivery.softBounced)}</span>}
            />
            <Stat
              className={STAT_WRAP}
              label={t('delivery.complained')}
              value={<span className={toned(delivery.complained, 'danger')}>{format.number(delivery.complained)}</span>}
            />
          </div>
          <p className="mt-[var(--aura-space-3)] aura-text-caption text-[var(--aura-fg-secondary)]">
            {t('delivery.caption', { recipients: delivery.recipients })}
          </p>
        </Card>
      ) : null}

      {memberFeedback !== null ? (
        <Alert tone="info" role="note" title={memberFeedback.title} data-testid="eblast-member-feedback">
          <span className="block whitespace-pre-line break-words">{memberFeedback.reason}</span>
        </Alert>
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
          imagesEnabled={imagesEnabled}
        />
      ) : shownVersion !== null && shownPreview !== null && original !== null && originalPreview !== null ? (
        // Read-only comparison: the version marketing is on (or sent, or the
        // member approved) beside the member's original — the manager's view
        // of `in_design`, and everyone's view after a version was sent.
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start" data-testid="eblast-version-comparison">
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
          {/* Spec 122 US12c-1 — folded under its own title where the cards stack. */}
          <OriginalDisclosure summary={tContent('originalTitle')}>
            <ContentCard
              id="eblast-original-title"
              title={tContent('originalTitle')}
              description={tContent('originalHint')}
              subject={original.subject}
              preview={originalPreview}
            />
          </OriginalDisclosure>
        </div>
      ) : (
        <Card titleId="eblast-body-title" title={t('fields.body')} headingLevel={2}>
          {bodyRenderFailed ? (
            <Alert tone="danger" role="alert" title={t('bodyRenderFailedTitle')}>
              {t('bodyRenderFailedHint')}
            </Alert>
          ) : (
            <EmailFrame>
              <PreviewSurface state={previewState} height={DETAIL_PREVIEW_FRAME_HEIGHT} fit />
            </EmailFrame>
          )}
        </Card>
      )}

      {threadModel !== null && hasThreadHistory(threadModel) ? (
        <div className={tailOnPhone}>
          <VersionThread audience="staff" model={threadModel} />
        </div>
      ) : null}

      {audit ? <div className={tailOnPhone}>{audit}</div> : null}

      {/* Spec 122 US12c-1 — the stage's staff actions, as the board groups
          them: the destructive ones (Cancel, Reject) at the start, the next
          step at the end; pinned to the bottom of the screen on a phone.
          Every control here is ABSENT for a `manager` (read-only), never
          disabled. "Send to member" lives with the working copy it sends. */}
      {showActionRow ? (
        <DetailActionBar
          moreLabel={t('moreActions')}
          status={barStatus}
          className={tailOnPhone}
          start={
            isCancellable || showReject ? (
              <>
                {isCancellable ? (
                  <CancelBroadcastAction broadcastId={broadcastId} surface="admin" subject={broadcast.subject} />
                ) : null}
                {showReject ? <ReviewActions broadcastId={broadcastId} showApprove={false} showReject /> : null}
              </>
            ) : undefined
          }
        >
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
          {showApprove ? <ReviewActions broadcastId={broadcastId} showApprove showReject={false} /> : null}
        </DetailActionBar>
      ) : null}
    </DetailContainer>
  );
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
    <Card titleId={id} title={title} headingLevel={2} description={description} className="min-w-0">
      {/* Board `Admin-eblast-awaiting-member`: the note to the member, the
          subject, then the e-mail in its own frame. */}
      <div className="space-y-3">
        {note !== undefined && note !== null && noteLabel !== undefined ? (
          <p data-version-note className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-canvas)] px-3 py-2 text-sm">
            <span className={`block ${FIELD_LABEL}`}>{noteLabel}</span>
            <span className="whitespace-pre-line">{note}</span>
          </p>
        ) : null}
        <p data-version-subject className="text-sm font-medium break-words">
          {subject}
        </p>
        <EmailFrame>
          <PreviewSurface state={preview} height={DETAIL_PREVIEW_FRAME_HEIGHT} fit />
        </EmailFrame>
      </div>
    </Card>
  );
}

/** An empty value: a muted dash for sight (the empty sentinel), a word for AT. */
function EmptyValue({ label }: { readonly label: string }): React.ReactElement {
  return (
    <>
      <span aria-hidden="true" className="text-[var(--aura-fg-secondary)]">—</span>
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
      <dt className={FIELD_LABEL}>
        {label}
      </dt>
      <dd className={FIELD_VALUE} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}
