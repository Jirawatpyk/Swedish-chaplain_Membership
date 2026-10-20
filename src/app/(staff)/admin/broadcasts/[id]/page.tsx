import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { failureReasonToken } from '@/components/broadcast/admin/failure-reason';
import { AuditTimeline } from '@/components/broadcast/admin/audit-timeline';
import { staffThreadModel } from '@/components/broadcast/approval/version-thread';
import { type PreviewState } from '@/components/broadcast/use-preview-html';
import { BroadcastDetailView } from './_components/broadcast-detail-view';
import { detailActions } from './_components/detail-actions';
import {
  isEblastMemberApprovalEnabled,
  isF71aUs2Enabled,
  listBroadcastVersions,
  makeGetBroadcastDeps,
  parseBroadcastId,
  readDispatchHold,
  readFormattingWarnings,
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
/**
 * The statuses at which a send has begun, so the delivery breakdown means
 * something (the member's detail page uses the same set).
 */
const DELIVERY_STATUSES: ReadonlySet<BroadcastStatus> = new Set<BroadcastStatus>([
  'sending',
  'sent',
  'partially_sent',
  'partial_delivery_accepted',
  'failed_to_dispatch',
]);
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
  const tFeedback = await getTranslations('admin.broadcasts.approval.feedback');
  const tThread = await getTranslations('admin.broadcasts.approval.thread');
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
  // One function for the page and the preview harness (`detail-actions.ts`).
  const { showStart, startConfirm, showSchedule, isCancellable, showApprove, showReject, showActionRow } =
    detailActions({ status, round, canWrite, canSend, memberApprovalOn, bodyRenderFailed });
  const showWorkspace = canWrite && workingCopy !== null && original !== null;
  // Rendered only when it is shown read-only (the workspace previews its own).
  const shownPreview =
    shownVersion === null || showWorkspace ? null : await render(shownVersion.subject, shownVersion.bodyHtml);

  // Board `Admin-broadcast-sent` — the delivery breakdown, once sending has
  // begun (before it every count is zero). The same tenant-bound read the
  // member's detail uses; a manager (`broadcasts.read`) sees it too.
  // The caption counts every recipient row, handed over included, so it is the
  // sum of the figures above it plus those still awaiting an outcome.
  const counts = DELIVERY_STATUSES.has(status)
    ? await deps.broadcastsRepo.aggregateDeliveryCountsForBroadcast(tenant.slug, broadcast.broadcastId)
    : null;
  const delivery =
    counts === null
      ? null
      : {
          delivered: counts.delivered,
          bounced: counts.bounced,
          softBounced: counts.softBounced,
          complained: counts.complained,
          recipients: counts.delivered + counts.bounced + counts.softBounced + counts.complained + counts.sent,
        };

  // F119 PR-A — why a `failed_to_dispatch` E-Blast was not sent. The stored
  // reason is a lookup hint (`failureReasonToken`), never display text; a token
  // with no sentence in the catalogue reads the generic one (`t.has`).
  const failureToken = status === 'failed_to_dispatch' ? failureReasonToken(broadcast.failureReason) : null;
  const failureKey = failureToken === null ? null : `failureReason.${failureToken}`;
  const failureReasonText =
    failureKey !== null && t.has(failureKey) ? t(failureKey) : t('failureReason.generic');
  // R6.7 — a standing refusal is a decision about the member (warning); any
  // other token is a delivery failure (destructive).
  const failureTone = failureToken !== null && STANDING_FAILURE_TOKENS.has(failureToken) ? 'warning' : 'danger';

  // F119 PR-A R1 — a due `approved` E-Blast the cron is HOLDING because the
  // member's membership is awaiting payment (the same decision the cron makes;
  // the use case answers `false` without a read for any row that is not due).
  const dispatchHeld = await readHeld(tenant.slug, broadcastId, {
    status,
    scheduledFor: broadcast.scheduledFor,
    memberId: broadcast.requestedByMemberId,
  });

  const turn = turnOf(status);
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

  // Called, not rendered as `<BroadcastDetailView/>`: the view is async, and
  // this page's own tests render it with `renderToStaticMarkup`.
  return BroadcastDetailView({
    broadcastId,
    broadcast,
    status,
    round,
    memberDisplayName,
    fmt,
    isReadOnlyManager,
    failure: status === 'failed_to_dispatch' ? { tone: failureTone, text: failureReasonText } : null,
    dispatchHeld,
    threadUnavailable,
    versionedStage: VERSIONED_STATUSES.has(status),
    showNoPortalUser,
    unsafeImages,
    turn,
    memberApprovalOn,
    memberFeedback: memberFeedback !== null && feedbackTitle !== null ? { title: feedbackTitle, reason: memberFeedback.reason ?? '' } : null,
    showWorkspace,
    workingCopy,
    original,
    originalPreview,
    shownVersion,
    shownPreview,
    previewState,
    bodyRenderFailed,
    delivery,
    imagesEnabled: isF71aUs2Enabled(),
    threadModel,
    audit: <AuditTimeline tenantId={tenant.slug} broadcastId={broadcastId} />,
    showActionRow,
    isCancellable,
    showStart,
    startConfirm,
    showSchedule,
    showApprove,
    showReject,
  });
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
