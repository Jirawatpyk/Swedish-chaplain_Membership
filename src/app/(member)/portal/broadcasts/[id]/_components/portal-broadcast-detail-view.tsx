/**
 * Spec 122 US12c-2 (T1241) — the member's E-Blast detail on AURA, as boards
 * `Portal-broadcast-detail`, `Portal-eblast-approval`, `-approved`,
 * `-scheduled` and `-expired` draw it. The page computes every value (guards,
 * the approval round, which decisions exist, formatted dates); this view only
 * lays them out, so the preview harness renders the same markup from fixtures.
 *
 * Async server component — uses next-intl/server.
 *
 * Order: header, Back, the stage banner (the page's ONE live region), the
 * thread-unavailable alert, the subject card, then the compare view (the
 * latest SENT version first, the member's original after it) or the record's
 * own content, the decision card, the version history and — once sending has
 * begun — the delivery counts.
 */
import { getTranslations } from 'next-intl/server';
import { Alert, Card, StatusPill } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { BackLink } from '@/components/portal/back-link';
import { keepTermTogether } from '@/components/broadcast/keep-term-together';
import { RefreshPageButton } from '@/components/shell/refresh-page-button';
import { getBroadcastStatusTone } from '@/components/broadcast/status-badge-mapping';
import { DETAIL_PREVIEW_FRAME_HEIGHT } from '@/components/broadcast/preview-frame-heights';
import { EmailFrame } from '@/components/broadcast/email-frame';
import { PreviewSurface, type PreviewState } from '@/components/broadcast/use-preview-html';
import {
  MemberSignOffActions,
  type MemberSignOffActionsProps,
} from '@/components/broadcast/approval/member-sign-off-actions';
import {
  VersionThread,
  hasThreadHistory,
  type VersionThreadModel,
} from '@/components/broadcast/approval/version-thread';
import { cn } from '@/lib/utils';
import type { BroadcastStatus } from '@/modules/broadcasts';

/** The counts the provider reported once sending began (`getMemberBroadcast`'s `delivery`). */
export interface PortalDeliveryCounts {
  readonly delivered: number;
  readonly bounced: number;
  readonly softBounced: number;
  readonly complained: number;
  readonly sent: number;
  readonly total: number;
}

export interface PortalBroadcastDetailViewProps {
  readonly back: { readonly href: string; readonly toDashboard: boolean };
  readonly status: BroadcastStatus;
  /** Whose turn it is, when a round is open; the member's line names the version they decide on. */
  readonly turn: { readonly kind: 'marketing' } | { readonly kind: 'member'; readonly version: number } | null;
  /** The request's expiry, formatted; null when nothing awaits the member. */
  readonly expiresAt: string | null;
  /** The approval round could not be read, or no version was sent while awaiting the member. */
  readonly threadUnavailable: boolean;
  readonly subject: string;
  readonly fields: {
    readonly recipients: number;
    readonly submittedAt: string | null;
    readonly sentAt: string | null;
    /** The round's send times — present once the approval round was read. */
    readonly sendTimes: { readonly proposed: string | null; readonly confirmed: string | null } | null;
  };
  readonly compare: {
    readonly formatted: {
      readonly versionNo: number;
      readonly noteToMember: string | null;
      readonly subject: string;
      readonly preview: PreviewState;
    };
    readonly original: { readonly subject: string; readonly preview: PreviewState };
  } | null;
  /** The record's own content, before any version was sent; null with a compare view or nothing to show. */
  readonly body: PreviewState | null;
  /** The decisions the stage allows; null when it allows none. */
  readonly signOff: MemberSignOffActionsProps | null;
  readonly thread: VersionThreadModel | null;
  /** Once sending has begun; null before (every count would be 0). */
  readonly delivery: PortalDeliveryCounts | null;
}

/** A count takes its tone only when there is something to report (as on the staff detail). */
const TONE = {
  positive: 'text-[var(--aura-fg-positive)]',
  danger: 'text-[var(--aura-fg-danger)]',
} as const;

const OVERLINE = 'aura-text-caption uppercase tracking-wide text-[var(--aura-fg-secondary)]';

export async function PortalBroadcastDetailView({
  back,
  status,
  turn,
  expiresAt,
  threadUnavailable,
  subject,
  fields,
  compare,
  body,
  signOff,
  thread,
  delivery,
}: PortalBroadcastDetailViewProps): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.detail');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const tApproval = await getTranslations('portal.broadcasts.approval');

  // Guard the i18n lookup; fall back to the raw status so a future enum
  // value degrades gracefully.
  const statusKey = status as Parameters<typeof tStatus>[0];
  const statusLabel = tStatus.has(statusKey) ? tStatus(statusKey) : status;
  const value = (v: string | null): React.ReactNode =>
    v !== null ? (
      v
    ) : (
      // L6 — muted is the empty sentinel's colour only; a real value is not.
      <span className="text-[var(--aura-fg-secondary)]">
        <span aria-hidden="true">—</span>
        <span className="sr-only">{tApproval('fields.notSet')}</span>
      </span>
    );

  return (
    <DetailContainer>
      <PageHeader title={keepTermTogether(t('title'))} subtitle={t('subtitle')} />

      <BackLink href={back.href}>{back.toDashboard ? t('backToDashboard') : t('back')}</BackLink>

      {/* F119 T086 — the stage banner: the page's ONE live region. It names
          the stage, whose turn it is and — while awaiting the member — the
          expiry date. It stays mounted across a decision's refresh, so the new
          stage is announced from here, not from a second region. The pill
          wraps inside itself: the longest stage (SV `member_approved`) is
          wider than the banner at 320 px (UX review H3). */}
      <Alert
        tone="info"
        role="status"
        data-testid="eblast-stage-banner"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <span>{t('fields.status')}</span>
            <StatusPill tone={getBroadcastStatusTone(status)} wrap className="max-w-full">
              {statusLabel}
            </StatusPill>
          </span>
        }
      >
        {turn !== null || expiresAt !== null ? (
          <>
            {turn?.kind === 'marketing' ? (
              <span className="block">{tApproval('banner.turn.marketing')}</span>
            ) : turn?.kind === 'member' ? (
              <span className="block">{tApproval('banner.turn.member', { version: turn.version })}</span>
            ) : null}
            {expiresAt !== null ? (
              <span className="block">{tApproval('banner.expires', { date: expiresAt })}</span>
            ) : null}
          </>
        ) : null}
      </Alert>

      {threadUnavailable ? (
        <Alert tone="danger" data-testid="eblast-thread-unavailable" title={tApproval('threadUnavailable.title')}>
          <span className="block">{tApproval('threadUnavailable.body')}</span>
          <span className="mt-[var(--aura-space-2)] block">
            <RefreshPageButton label={tApproval('threadUnavailable.refresh')} />
          </span>
        </Alert>
      ) : null}

      {/* The subject is the card's heading (and its region's name); "Subject"
          is a small overline above it (UX R2-I3). The round's send times stay
          beside the record's dates throughout (FR-016). */}
      <Card
        aria-labelledby="broadcast-detail-fields-heading"
        header={
          <>
            <p className={OVERLINE}>{t('fields.subject')}</p>
            {/* AURA's card-title type on the inner text: preflight resets a heading's font. */}
            <h2 id="broadcast-detail-fields-heading">
              <span className="aura-text-h3 block break-words">{subject}</span>
            </h2>
          </>
        }
      >
        <dl className="grid grid-cols-2 gap-x-6 gap-y-4 lg:grid-cols-5">
          <Field label={t('fields.recipients')}>
            <span className="tabular-nums">{fields.recipients}</span>
          </Field>
          <Field label={t('fields.submittedAt')}>{value(fields.submittedAt)}</Field>
          <Field label={t('fields.sentAt')}>{value(fields.sentAt)}</Field>
          {fields.sendTimes !== null ? (
            <>
              <Field label={tApproval('fields.proposedSendAt')} testId="eblast-proposed-send-at">
                {value(fields.sendTimes.proposed)}
              </Field>
              <Field label={tApproval('fields.confirmedSendAt')}>{value(fields.sendTimes.confirmed)}</Field>
            </>
          ) : null}
        </dl>
      </Card>

      {compare !== null ? (
        // FR-008 — DOM order is the layout: the formatted version FIRST, the
        // original after it. One grid, so a phone stacks them (formatted on
        // top, the original below on this same page) and ≥ lg sets them side
        // by side, each card ending at its own e-mail.
        <div className="grid gap-6 lg:grid-cols-2 lg:items-start" data-testid="eblast-compare">
          <Card
            as="section"
            className="min-w-0"
            data-testid="eblast-formatted-version"
            titleId="eblast-formatted-title"
            headingLevel={2}
            title={tApproval('compare.formattedTitle', { version: compare.formatted.versionNo })}
            description={tApproval('compare.formattedHint')}
          >
            <div className="flex flex-col gap-[var(--aura-space-3)]">
              {compare.formatted.noteToMember !== null ? (
                <p className="rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] px-3 py-2 aura-text-body">
                  <span className={cn('block', OVERLINE)}>{tApproval('compare.noteLabel')}</span>
                  <span className="whitespace-pre-line break-words">{compare.formatted.noteToMember}</span>
                </p>
              ) : null}
              <p className="aura-text-body font-medium break-words">{compare.formatted.subject}</p>
              <EmailFrame>
                <PreviewSurface state={compare.formatted.preview} height={DETAIL_PREVIEW_FRAME_HEIGHT} fit />
              </EmailFrame>
            </div>
          </Card>
          <Card
            as="section"
            className="min-w-0"
            data-testid="eblast-member-original"
            titleId="eblast-original-title"
            headingLevel={2}
            title={tApproval('compare.originalTitle')}
            description={tApproval('compare.originalHint')}
          >
            <div className="flex flex-col gap-[var(--aura-space-3)]">
              <p className="aura-text-body font-medium break-words">{compare.original.subject}</p>
              <EmailFrame>
                <PreviewSurface state={compare.original.preview} height={DETAIL_PREVIEW_FRAME_HEIGHT} fit />
              </EmailFrame>
            </div>
          </Card>
        </div>
      ) : body !== null ? (
        // F119 T141 (US6-AS2, FR-049) — the content itself, as the recipient
        // sees it, in the shared sandboxed frame.
        <Card titleId="broadcast-detail-body-heading" headingLevel={2} title={t('fields.content')}>
          <EmailFrame>
            <PreviewSurface state={body} height={DETAIL_PREVIEW_FRAME_HEIGHT} fit />
          </EmailFrame>
        </Card>
      ) : null}

      {/* F119 T084 — the decisions this stage allows, right under what they
          decide on; every POST is re-guarded by its use case. */}
      {signOff !== null ? <MemberSignOffActions {...signOff} /> : null}

      {thread !== null && hasThreadHistory(thread) ? <VersionThread audience="member" model={thread} /> : null}

      {/* AS3 — the delivery counts, once a send has begun (UX review L7).
          Each count is its own <dl> so a screen reader reads "Delivered: 128"
          as a unit; the visible h2 names the region. */}
      {delivery !== null ? (
        <Card
          data-testid="delivery-breakdown"
          titleId="delivery-breakdown-heading"
          headingLevel={2}
          title={t('delivery.title')}
        >
          <div className="grid grid-cols-2 gap-[var(--aura-space-2)] sm:grid-cols-3 lg:grid-cols-6 lg:gap-[var(--aura-space-3)]">
            <DeliveryStat label={t('delivery.delivered')} value={delivery.delivered} tone="positive" testId="delivery-delivered-count" />
            <DeliveryStat label={t('delivery.bounced')} value={delivery.bounced} tone="danger" testId="delivery-bounced-count" />
            <DeliveryStat label={t('delivery.softBounced')} value={delivery.softBounced} testId="delivery-soft-bounced-count" />
            <DeliveryStat label={t('delivery.complained')} value={delivery.complained} tone="danger" testId="delivery-complained-count" />
            <DeliveryStat label={t('delivery.sent')} value={delivery.sent} testId="delivery-sent-count" />
            <DeliveryStat label={t('delivery.total')} value={delivery.total} testId="delivery-total-count" />
          </div>
        </Card>
      ) : null}
    </DetailContainer>
  );
}

function Field({
  label,
  testId,
  children,
}: {
  readonly label: string;
  readonly testId?: string;
  readonly children: React.ReactNode;
}): React.ReactElement {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="aura-text-caption text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd className="m-0 aura-text-body break-words" {...(testId !== undefined && { 'data-testid': testId })}>
        {children}
      </dd>
    </div>
  );
}

function DeliveryStat({
  label,
  value,
  tone,
  testId,
}: {
  readonly label: string;
  readonly value: number;
  readonly tone?: keyof typeof TONE;
  readonly testId: string;
}): React.ReactElement {
  return (
    <dl
      data-testid={testId}
      className="m-0 flex min-w-0 flex-col gap-1 rounded-[var(--aura-radius-md)] bg-[var(--aura-bg-surface-hover)] p-3 lg:p-4"
    >
      <dt className="aura-text-caption text-[var(--aura-fg-secondary)] [overflow-wrap:anywhere]">{label}</dt>
      <dd className={cn('m-0 text-2xl font-semibold tabular-nums', tone !== undefined && value > 0 && TONE[tone])}>
        {value}
      </dd>
    </dl>
  );
}
