/**
 * F114 — `/admin/change-requests` — the tenant-wide queue (US4 AS2; FR-027,
 * FR-033, FR-039; T074). Replaces the PR-1 pending-only list.
 *
 * `requirePagePermission('members.read')` — a manager reads the queue; the
 * review page gates deciding on `members.write`. Platform flag OFF → 404.
 *
 * Filters are a plain GET form (state / outcome / member / date range —
 * FR-027), so every view is a URL: `?state=decided&outcome=partially_approved`
 * finds "the partially approved ones", `?memberId=…` is the member record's
 * link, and the staff email's `?submitter=<userId>&state=pending` deep link
 * resolves server-side — exactly one pending request for that person →
 * redirect to its review page; none → "no pending request — decided by X at
 * T" (FR-011: the link points at the PERSON, never a request id). Pending
 * rows list oldest-first with the waiting time and an OVERDUE marker past
 * 3 days (icon + text, never colour alone); other states newest-first with
 * the reviewer (+ the "deactivated" marker). Paging is a server-rendered
 * "Next page" link carrying the opaque keyset cursor; a malformed cursor is a
 * 404, never page one silently. A repo failure THROWS to the segment error
 * boundary — never an empty state that says "no requests are waiting".
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { z } from 'zod';
import { AlertTriangleIcon, InboxIcon, ReceiptTextIcon, XIcon } from 'lucide-react';
import { env } from '@/lib/env';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { tenantDayEndUtc, tenantDayStartUtc } from '@/lib/tenant-day-range';
import { asMembersUserId, buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { logger } from '@/lib/logger';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  CHANGE_REQUEST_OUTCOMES,
  CHANGE_REQUEST_STATES,
  asMemberId,
  listChangeRequestQueue,
  type UserId,
} from '@/modules/members';
import { Badge } from '@/components/ui/badge';
import { Button, buttonVariants } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { InlineAlert } from '@/components/ui/inline-alert';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCaption, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/shell/empty-state';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ChangeRequestStatusBadge } from '@/components/members/change-requests/change-request-status-badge';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = 50;
const TENANT_TZ = 'Asia/Bangkok';
// a native select: the Input's focus ring, so keyboard focus is visible (UX)
const SELECT_CLASS = 'h-9 rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2';

const searchSchema = z.object({
  state: z.enum(CHANGE_REQUEST_STATES).optional(),
  outcome: z.enum(CHANGE_REQUEST_OUTCOMES).optional(),
  memberId: z.string().regex(UUID_RE).optional(),
  submitter: z.string().regex(UUID_RE).optional(),
  from: z.string().regex(YMD_RE).optional(),
  to: z.string().regex(YMD_RE).optional(),
  cursor: z.string().min(1).max(200).optional(),
});

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.changeRequests.queue');
  return { title: t('title') };
}

function one(v: string | string[] | undefined): string | undefined {
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === '' ? undefined : s;
}

/** Whole days / hours for the waiting column — the exact seconds are not what a reviewer scans for. */
function waitingParts(seconds: number): { days: number; hours: number } {
  return { days: Math.floor(seconds / 86_400), hours: Math.floor((seconds % 86_400) / 3600) };
}

export default async function ChangeRequestsQueuePage({ searchParams }: PageProps) {
  if (!env.features.memberChangeApproval) notFound();
  await requirePagePermission('members.read');
  const h = await headers();
  const tenant = resolveTenantFromHeaders(h);
  const requestId = requestIdFromHeaders(h);
  const deps = buildChangeRequestDeps(tenant);
  // A repo failure must reach the error boundary — never render as "no
  // change requests are awaiting a decision" (review: UX C3).
  // typed `never` on the BINDING (not only the arrow) so TS narrows after a
  // call and no `ok ? value : fallback` is needed — a fallback that renders
  // an empty page is the defect this helper exists to prevent (UX C3, REL-13)
  const fail: (arm: string, code: string) => never = (arm, code) => {
    logger.error({ errorId: `M114.admin.queue_page.${arm}`, requestId, tenantId: tenant.slug, err: code }, 'change-requests.queue page: read failed');
    throw new Error('change-requests.queue: load failed');
  };

  const sp = await searchParams;
  // an invalid filter value is a bad link, not a fault — drop it and show the default view
  const parsed = searchSchema.safeParse({
    state: one(sp.state),
    outcome: one(sp.outcome),
    memberId: one(sp.memberId),
    submitter: one(sp.submitter),
    from: one(sp.from),
    to: one(sp.to),
    cursor: one(sp.cursor),
  });
  const q = parsed.success ? parsed.data : {};
  const state = q.state ?? 'pending';
  // an outcome only means something on decided rows — anywhere else it is dropped, not applied silently
  const outcome = state === 'decided' ? q.outcome : undefined;
  const submitter = q.submitter ? asMembersUserId(q.submitter) : undefined;

  const t = await getTranslations('admin.changeRequests.queue');
  const tFilters = await getTranslations('admin.changeRequests.filters');
  const tReview = await getTranslations('admin.changeRequests.review');
  const locale = await getLocale();
  const fmt = (d: Date) => formatLocalisedDate(d.toISOString(), locale, { dateStyle: 'medium', timeStyle: 'short' });

  // The staff-email deep link (FR-011): the PERSON's current pending request —
  // through the queue use case (Principle III, REL-12; the member chip below
  // reads the member record through its repo, the member-page idiom).
  let deepLinkNotice: string | null = null;
  if (submitter && state === 'pending' && !q.cursor) {
    const pending = await listChangeRequestQueue(deps, { filter: { state: 'pending', submitterUserId: submitter as UserId }, cursor: null, limit: 2 });
    if (!pending.ok) fail('deep_link_pending_read_failed', pending.error.type === 'server_error' ? pending.error.message : pending.error.type);
    const rows = pending.value.items;
    if (rows.length === 1 && rows[0]) redirect(`/admin/change-requests/${rows[0].row.request.id}`);
    if (rows.length === 0) {
      const decided = await listChangeRequestQueue(deps, { filter: { state: 'decided', submitterUserId: submitter as UserId }, cursor: null, limit: 1 });
      if (!decided.ok) fail('deep_link_decided_read_failed', decided.error.type === 'server_error' ? decided.error.message : decided.error.type);
      const last = decided.value.items[0]?.row;
      deepLinkNotice =
        last && last.request.decidedAt
          ? t('noPendingForSubmitter', { name: last.decidedBy?.displayName || tReview('unknownReviewer'), decidedAt: fmt(last.request.decidedAt) })
          : t('noRequestForSubmitter');
    }
  }

  const result = await listChangeRequestQueue(deps, {
    filter: {
      state,
      ...(outcome ? { outcome } : {}),
      ...(q.memberId ? { memberId: asMemberId(q.memberId) } : {}),
      ...(submitter ? { submitterUserId: submitter as UserId } : {}),
      ...(q.from ? { from: new Date(tenantDayStartUtc(q.from, TENANT_TZ)) } : {}),
      ...(q.to ? { to: new Date(tenantDayEndUtc(q.to, TENANT_TZ)) } : {}),
    },
    cursor: q.cursor ?? null,
    limit: PAGE,
  });
  if (!result.ok) {
    if (result.error.type === 'invalid_cursor') notFound();
    fail('queue_read_failed', result.error.message);
  }
  const page = result.value;
  const filtered = Boolean(outcome || q.memberId || submitter || q.from || q.to || state !== 'pending');
  // the member chip names the COMPANY — resolved from the member record, so an
  // empty page never falls back to a raw uuid (review round 1, UX C1)
  let memberChip: string | null = null;
  if (q.memberId) {
    const member = await deps.memberRepo.findById(tenant, asMemberId(q.memberId));
    if (member.ok) memberChip = member.value.companyName;
    else if (member.error.code === 'repo.not_found') memberChip = tFilters('unknownMember');
    else fail('member_chip_read_failed', member.error.code);
  }
  const defaultView = !filtered && !q.cursor;

  // a chip's "show all" link keeps every OTHER filter (UX I3)
  const hrefWithout = (drop: 'memberId' | 'submitter') => {
    const params = new URLSearchParams();
    if (q.state) params.set('state', q.state);
    if (outcome) params.set('outcome', outcome);
    if (q.memberId && drop !== 'memberId') params.set('memberId', q.memberId);
    if (q.submitter && drop !== 'submitter') params.set('submitter', q.submitter);
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    const qs = params.toString();
    return qs ? `/admin/change-requests?${qs}` : '/admin/change-requests';
  };

  // the "Next page" link keeps every filter, swaps the cursor
  const nextHref = (() => {
    if (!page.nextCursor) return null;
    const params = new URLSearchParams();
    if (q.state) params.set('state', q.state);
    if (outcome) params.set('outcome', outcome);
    if (q.memberId) params.set('memberId', q.memberId);
    if (q.submitter) params.set('submitter', q.submitter);
    if (q.from) params.set('from', q.from);
    if (q.to) params.set('to', q.to);
    params.set('cursor', page.nextCursor);
    return `/admin/change-requests?${params.toString()}`;
  })();

  return (
    <TableContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          // the tenant's pending fact belongs to the DEFAULT view — on a
          // filtered page it reads as a count of what is shown (UX I8)
          defaultView && page.pendingCount > 0 ? (
            <p className="text-sm" data-testid="queue-pending-count">
              {t('pendingSummary', {
                count: page.pendingCount,
                oldestDays: page.oldestPendingAgeSeconds === null ? 0 : Math.floor(page.oldestPendingAgeSeconds / 86_400),
              })}
            </p>
          ) : undefined
        }
      />
      {deepLinkNotice ? (
        <InlineAlert tone="info" role="status" data-testid="deep-link-notice">
          {deepLinkNotice}
        </InlineAlert>
      ) : null}

      <form method="get" action="/admin/change-requests" className="grid gap-3 rounded-md border p-3 sm:grid-cols-2 lg:grid-cols-[repeat(4,minmax(0,1fr))_auto] lg:items-end" aria-label={tFilters('label')} data-testid="queue-filters">
        {q.memberId ? <input type="hidden" name="memberId" value={q.memberId} /> : null}
        {q.submitter ? <input type="hidden" name="submitter" value={q.submitter} /> : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cr-filter-state">{tFilters('state')}</Label>
          <select id="cr-filter-state" name="state" defaultValue={state} className={SELECT_CLASS}>
            {CHANGE_REQUEST_STATES.map((s) => (
              <option key={s} value={s}>
                {tReview(`state.${s}`)}
              </option>
            ))}
          </select>
        </div>
        {state === 'decided' ? (
          <div className="flex flex-col gap-1.5">
            <Label htmlFor="cr-filter-outcome">{tFilters('outcome')}</Label>
            <select id="cr-filter-outcome" name="outcome" defaultValue={outcome ?? ''} className={SELECT_CLASS}>
              <option value="">{tFilters('anyOutcome')}</option>
              {CHANGE_REQUEST_OUTCOMES.map((o) => (
                <option key={o} value={o}>
                  {tReview(`outcome.${o}`)}
                </option>
              ))}
            </select>
          </div>
        ) : null}
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cr-filter-from">{tFilters('from')}</Label>
          <Input id="cr-filter-from" name="from" type="date" defaultValue={q.from ?? ''} className="h-9" />
        </div>
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="cr-filter-to">{tFilters('to')}</Label>
          <Input id="cr-filter-to" name="to" type="date" defaultValue={q.to ?? ''} className="h-9" />
        </div>
        <div className="flex items-center gap-2">
          <Button type="submit" size="sm" className="h-9">
            {tFilters('apply')}
          </Button>
          {filtered ? (
            <Link href="/admin/change-requests" className={`${buttonVariants({ variant: 'ghost', size: 'sm' })} h-9`}>
              {tFilters('clear')}
            </Link>
          ) : null}
        </div>
        {q.memberId ? (
          <p className="text-sm sm:col-span-2 lg:col-span-5" data-testid="queue-member-chip">
            {tFilters('memberChip', { company: memberChip ?? '' })}{' '}
            <Link href={hrefWithout('memberId')} className="inline-flex items-center gap-1 text-primary underline underline-offset-4 hover:no-underline">
              <XIcon className="size-3" aria-hidden="true" />
              {tFilters('removeMember')}
            </Link>
          </p>
        ) : null}
        {q.submitter ? (
          <p className="text-sm sm:col-span-2 lg:col-span-5" data-testid="queue-submitter-chip">
            {tFilters('submitterChip')}{' '}
            <Link href={hrefWithout('submitter')} className="inline-flex items-center gap-1 text-primary underline underline-offset-4 hover:no-underline">
              <XIcon className="size-3" aria-hidden="true" />
              {tFilters('removeSubmitter')}
            </Link>
          </p>
        ) : null}
      </form>

      {page.items.length === 0 ? (
        deepLinkNotice ? null : (
          <div data-testid="queue-empty">
            <EmptyState icon={InboxIcon} title={filtered ? t('emptyFiltered') : t('empty')} {...(filtered ? {} : { description: t('emptyHint') })} bordered />
          </div>
        )
      ) : (
        <Table data-testid="queue-table">
          <TableCaption className="sr-only">{t('tableCaption')}</TableCaption>
          <TableHeader>
            <TableRow>
              <TableHead>{t('columns.member')}</TableHead>
              <TableHead>{t('columns.submitter')}</TableHead>
              <TableHead>{t('columns.fields')}</TableHead>
              <TableHead>{t('columns.submitted')}</TableHead>
              <TableHead>{t('columns.waiting')}</TableHead>
              <TableHead>{t('columns.status')}</TableHead>
              <TableHead>
                <span className="sr-only">{t('open')}</span>
              </TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.map((item) => {
              const r = item.row.request;
              const wait = waitingParts(item.waitingSeconds);
              const rowId = `cr-row-${r.id}`;
              return (
                <TableRow key={r.id} data-testid="queue-row" data-request-id={r.id} data-overdue={item.overdue ? 'true' : undefined}>
                  <TableCell>
                    <div className="font-medium">{item.row.member.companyName}</div>
                    <div className="text-caption text-muted-foreground">
                      #{item.row.member.memberNumber}
                      {item.row.member.archived ? ` · ${t('archivedMember')}` : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    <div>{item.row.submitter.displayName}</div>
                    <div className="text-caption text-muted-foreground">{tReview(`roles.${r.submitterRoleAtSubmission}`)}</div>
                  </TableCell>
                  <TableCell>
                    <div>{t('fieldCount', { count: r.fields.length })}</div>
                    {r.fields.some((f) => f.affectsTaxDocuments) ? (
                      <div className="flex items-center gap-1 text-caption text-muted-foreground">
                        <ReceiptTextIcon className="size-3" aria-hidden="true" />
                        {tReview('markers.taxAffecting')}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell>{fmt(r.submittedAt)}</TableCell>
                  <TableCell>
                    <span id={`${rowId}-waiting`}>{wait.days > 0 ? t('waitingDays', { count: wait.days }) : t('waitingHours', { count: wait.hours })}</span>
                    {item.overdue ? (
                      <Badge variant="destructive" className="ml-2" data-testid="overdue-badge">
                        <AlertTriangleIcon className="mr-1 size-3" aria-hidden="true" />
                        {t('overdue')}
                      </Badge>
                    ) : null}
                  </TableCell>
                  <TableCell>
                    <ChangeRequestStatusBadge state={r.state} outcome={r.outcome} withdrawnReason={r.withdrawnReason} audience="staff" />
                    {r.decidedAt && item.row.decidedBy ? (
                      <div className="mt-1 text-caption text-muted-foreground">
                        {tReview('decidedBy', { name: item.row.decidedBy.displayName || tReview('unknownReviewer'), decidedAt: fmt(r.decidedAt) })}
                        {item.row.decidedBy.deactivated ? ` ${tReview('deactivated')}` : null}
                      </div>
                    ) : null}
                  </TableCell>
                  <TableCell className="text-right">
                    <Link
                      href={`/admin/change-requests/${r.id}`}
                      className={`${buttonVariants({ variant: 'outline', size: 'sm' })} inline-flex h-9 items-center`}
                      aria-label={r.state === 'pending' ? t('reviewFor', { company: item.row.member.companyName }) : t('viewFor', { company: item.row.member.companyName })}
                      aria-describedby={`${rowId}-waiting`}
                    >
                      {r.state === 'pending' ? t('open') : t('view')}
                    </Link>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
      {nextHref ? (
        <div className="flex justify-center">
          <Link href={nextHref} className={buttonVariants({ variant: 'outline' })} data-testid="queue-next">
            {t('nextPage')}
          </Link>
        </div>
      ) : null}
    </TableContainer>
  );
}
