/**
 * F114 — "Change requests" section on the member detail page (US4 AS1;
 * FR-026; T075). The member's requests, newest first: pending ones with
 * Review, then the latest decided ones with the reviewer's name and the
 * "deactivated" marker (staff accounts are disabled, never deleted —
 * FR-026). Each request's diff and reason are on its review page, one
 * click away (layout B, maintainer 22 Oct).
 *
 * The lists carry NO `aria-label`: the section's own `<h2>` names it, and a
 * second name was announced three times over (PR-1 review, UX M8).
 *
 * Server component, Suspense-wrapped at the call site (mirrors the invoices
 * / timeline sections). A FAILED read renders a DISTINCT "unavailable" state
 * (logged with errKind only) — never the empty state, which would tell the
 * admin "no requests" when the read errored. Rendered only while the
 * platform flag is on (FR-039: no request state shown while dark).
 */
import { cache } from 'react';
import Link from 'next/link';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { ArrowRightIcon } from 'lucide-react';
import { Alert, Card, EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';
import { logger } from '@/lib/logger';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { requestIdFromHeaders } from '@/lib/request-id';
import { buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import type { ChangeRequestFieldView } from '@/lib/change-request-portal-view';
import { asMemberId, listMemberChangeRequests, type ChangeRequestQueueItem } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import { ChangeRequestStatusBadge, changeRequestStatusOf, type ChangeRequestStatus } from '@/components/members/change-requests/change-request-status-badge';
import { SectionCardSkeleton } from './section-card-skeleton';

const SECTION_LIMIT = 10;

interface Props {
  readonly tenant: TenantContext;
  readonly memberId: string;
}

/**
 * One read per render, shared by the pending alert above the figures and the
 * section below (React `cache`).
 */
const loadMemberChangeRequests = cache(async (tenant: TenantContext, memberId: string) => {
  const h = await headers();
  const requestId = requestIdFromHeaders(h);
  let items: readonly ChangeRequestQueueItem[] = [];
  let loadFailed = false;
  try {
    const result = await listMemberChangeRequests(buildChangeRequestDeps(tenant), { memberId: asMemberId(memberId), cursor: null, limit: SECTION_LIMIT });
    if (result.ok) items = result.value.items;
    else {
      loadFailed = true;
      logger.error({ errorId: 'M114.admin.member_section.list_failed', requestId, tenantId: tenant.slug, memberId, err: result.error.type }, 'member change-requests section: list failed');
    }
  } catch (e) {
    loadFailed = true;
    logger.error({ errorId: 'M114.admin.member_section.threw', requestId, tenantId: tenant.slug, memberId, err: e instanceof Error ? e.name : String(e) }, 'member change-requests section: threw');
  }
  return { items, loadFailed };
});

/**
 * Spec 122 US5b-1 (board `Admin-member-detail-mobile`, UX review M9) — a
 * request awaiting review, flagged above the figures with "Review". Nothing
 * when none is pending or the read failed (the section says that). It looks
 * only at the newest SECTION_LIMIT requests the section shows: a pending one
 * older than those is not flagged here, and the change-request queue still
 * lists it.
 */
export async function MemberPendingChangeRequestAlert({ tenant, memberId }: Props) {
  const { items } = await loadMemberChangeRequests(tenant, memberId);
  const pending = items.find(({ row }) => row.request.state === 'pending');
  if (!pending) return null;
  const tReview = await getTranslations('admin.changeRequests.review');
  return (
    <PendingChangeRequestAlert
      requestId={pending.row.request.id}
      submitterName={pending.row.submitter.displayName}
      submitterRole={tReview(`roles.${pending.row.request.submitterRoleAtSubmission}`)}
    />
  );
}

/** The alert itself — presentation only, so the no-DB preview renders it too. */
export async function PendingChangeRequestAlert({
  requestId,
  submitterName,
  submitterRole,
}: {
  readonly requestId: string;
  readonly submitterName: string;
  readonly submitterRole: string;
}) {
  const t = await getTranslations('admin.members.changeRequests');
  return (
    <Alert
      tone="info"
      role="status"
      title={t('pendingAlert')}
      action={
        <Link href={`/admin/change-requests/${requestId}`} className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}>
          {t('review')}
        </Link>
      }
    >
      {`${t('submittedBy', { name: submitterName, role: submitterRole })}.`}
    </Alert>
  );
}

export async function MemberChangeRequestsSection({ tenant, memberId }: Props) {
  const tReview = await getTranslations('admin.changeRequests.review');
  const { items, loadFailed } = await loadMemberChangeRequests(tenant, memberId);
  const rows: MemberChangeRequestRow[] = items.map(({ row }) => {
    const r = row.request;
    return {
      id: r.id,
      status: changeRequestStatusOf(r),
      fieldKeys: r.fields.map((f) => f.key),
      submitterName: row.submitter.displayName,
      submitterRole: tReview(`roles.${r.submitterRoleAtSubmission}`),
      submittedAtIso: r.submittedAt.toISOString(),
      decidedByName:
        r.decidedAt && row.decidedBy
          ? `${row.decidedBy.displayName || tReview('unknownReviewer')}${row.decidedBy.deactivated ? ` ${tReview('deactivated')}` : ''}`
          : null,
      decidedAtIso: r.decidedAt?.toISOString() ?? null,
    };
  });
  return <MemberChangeRequestsCard memberId={memberId} rows={rows} loadFailed={loadFailed} />;
}

/** One request as the card shows it — plain values, so the no-DB preview renders the card too. */
export interface MemberChangeRequestRow {
  readonly id: string;
  readonly status: ChangeRequestStatus;
  readonly fieldKeys: readonly ChangeRequestFieldView['key'][];
  readonly submitterName: string;
  readonly submitterRole: string;
  readonly submittedAtIso: string;
  /** The reviewer's name (with the "deactivated" marker), once decided. */
  readonly decidedByName: string | null;
  readonly decidedAtIso: string | null;
}

/** Decided or withdrawn requests the card shows; the queue has the rest. */
export const CHANGE_REQUEST_HISTORY_ROWS = 3;

/**
 * Layout B (maintainer, 22 Oct; board `Admin-member-detail`) — the card in
 * the page's main column: every pending request with Review, then up to
 * three decided or withdrawn ones on one line each (the fields · status ·
 * who decided · when), and "View all" to the queue filtered to this member,
 * where each request's diff and reason are. A failed read renders a DISTINCT
 * "unavailable" state, never "none yet".
 */
export async function MemberChangeRequestsCard({
  memberId,
  rows,
  loadFailed,
}: {
  readonly memberId: string;
  readonly rows: readonly MemberChangeRequestRow[];
  readonly loadFailed: boolean;
}) {
  const t = await getTranslations('admin.members.changeRequests');
  const tReview = await getTranslations('admin.changeRequests.review');
  const tField = await getTranslations('portal.changeRequests.diff.labels');
  const locale = await getLocale();
  const fmt = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium' });
  // The hidden part of a row's link name: with the time, so two requests on
  // the same day still read apart (UX review M7).
  const fmtFull = (iso: string) => formatLocalisedDate(iso, locale, { dateStyle: 'medium', timeStyle: 'short' });
  const fields = (keys: readonly string[]) => keys.map((k) => tField(k as never)).join(', ');

  const pending = rows.filter((r) => r.status.state === 'pending');
  const history = rows.filter((r) => r.status.state !== 'pending').slice(0, CHANGE_REQUEST_HISTORY_ROWS);
  const viewAllHref = `/admin/change-requests?memberId=${encodeURIComponent(memberId)}`;

  return (
    <Card
      as="section"
      data-testid="member-change-requests-section"
      title={t('title')}
      titleId="member-change-requests-heading"
      headingLevel={2}
      // The queue is its own read: offered even when this card failed to
      // load, as the Timeline card offers its page.
      actions={
        rows.length > 0 || loadFailed ? (
          <Link href={viewAllHref} className={buttonClass({ variant: 'ghost', size: 'sm', touchHeight: true })}>
            {t('viewAll')}
            <ArrowRightIcon className="size-4" aria-hidden="true" />
          </Link>
        ) : undefined
      }
    >
      {loadFailed ? (
        // `status`, not `alert`: the page rendered, one section did not —
        // no interruption of whatever the admin is reading (UX I9)
        <Alert tone="danger" role="status" data-testid="member-change-requests-unavailable">
          {t('loadFailed')}
        </Alert>
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={t('empty')} />
      ) : (
        <div className="flex flex-col">
          {pending.length > 0 && (
            <ul className="flex flex-col divide-y divide-[var(--aura-border-default)]">
              {pending.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-col gap-2 py-3 first:pt-0 sm:flex-row sm:items-center sm:justify-between"
                  data-testid="member-change-request-pending"
                  data-request-id={r.id}
                >
                  <div className="min-w-0 space-y-1 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{fields(r.fieldKeys)}</span>
                      <ChangeRequestStatusBadge status={r.status} audience="staff" />
                    </div>
                    <p className="text-xs text-[var(--aura-fg-secondary)]">
                      {`${t('submittedBy', { name: r.submitterName, role: r.submitterRole })} · ${fmt(r.submittedAtIso)}`}
                    </p>
                  </div>
                  <Link
                    href={`/admin/change-requests/${r.id}`}
                    className={buttonClass({ size: 'sm', touchHeight: true })}
                  >
                    {t('review')}
                    {/* Each row has one: the date tells them apart (UX review M7). */}
                    <span className="sr-only">{`, ${t('submittedOn', { submittedAt: fmtFull(r.submittedAtIso) })}`}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          {history.length > 0 && (
            <ul
              className={`flex flex-col divide-y divide-[var(--aura-border-default)] ${pending.length > 0 ? 'border-t border-[var(--aura-border-default)]' : ''}`}
            >
              {history.map((r) => {
                const when =
                  r.decidedByName && r.decidedAtIso
                    ? tReview('decidedBy', { name: r.decidedByName, decidedAt: fmt(r.decidedAtIso) })
                    : t('submittedOn', { submittedAt: fmt(r.submittedAtIso) });
                return (
                  // The whole row is the link's target (a stretched link,
                  // 44px+ on a phone); its ring follows the row.
                  <li
                    key={r.id}
                    className={`relative flex flex-wrap items-start justify-between gap-x-3 gap-y-1 py-3 ${pending.length > 0 ? '' : 'first:pt-0'}`}
                    data-testid="member-change-request-history"
                    data-request-id={r.id}
                  >
                    <div className="min-w-0 flex-1 space-y-1 text-sm">
                      <Link
                        href={`/admin/change-requests/${r.id}`}
                        className="font-medium text-[var(--aura-fg-accent)] [overflow-wrap:anywhere] underline-offset-4 outline-none after:absolute after:inset-0 after:rounded-[var(--aura-radius-md)] hover:underline focus-visible:after:outline-2 focus-visible:after:outline-[var(--aura-focus-ring)]"
                      >
                        {fields(r.fieldKeys)}
                        <span className="sr-only">{`, ${when}`}</span>
                      </Link>
                      <p className="text-xs text-[var(--aura-fg-secondary)]" aria-hidden="true">
                        {when}
                      </p>
                    </div>
                    <ChangeRequestStatusBadge status={r.status} audience="staff" className="shrink-0" />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}

/** Suspense fallback matching the section's card shape (CLS-stable). */
export function MemberChangeRequestsSkeleton() {
  return <SectionCardSkeleton rows={2} action />;
}
