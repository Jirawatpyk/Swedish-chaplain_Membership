/**
 * F114 — "Change requests" section on the member detail page (US4 AS1;
 * FR-026; T075). The member's requests, every state, newest first: per-field
 * outcomes through the shared read-only diff table, the reviewer's name with
 * the "deactivated" marker (staff accounts are disabled, never deleted —
 * FR-026), the reason as plain text, and a link to the review page.
 *
 * The list carries NO `aria-label`: the section's own `<h2>` names it, and a
 * second name was announced three times over (PR-1 review, UX M8).
 *
 * Server component, Suspense-wrapped at the call site (mirrors the invoices
 * / timeline sections). A FAILED read renders a DISTINCT "unavailable" state
 * (logged with errKind only) — never the empty state, which would tell the
 * admin "no requests" when the read errored. Rendered only while the
 * platform flag is on (FR-039: no request state shown while dark).
 */
import Link from 'next/link';
import { headers } from 'next/headers';
import { getLocale, getTranslations } from 'next-intl/server';
import { FileClockIcon } from 'lucide-react';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { InlineAlert } from '@/components/ui/inline-alert';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { logger } from '@/lib/logger';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { requestIdFromHeaders } from '@/lib/request-id';
import { buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import { serialiseField } from '@/lib/change-request-portal-view';
import { asMemberId, listMemberChangeRequests, type ChangeRequestQueueItem } from '@/modules/members';
import type { TenantContext } from '@/modules/tenants';
import { ChangeRequestDiffTable } from '@/components/members/change-requests/change-request-diff-table';
import { ChangeRequestStatusBadge } from '@/components/members/change-requests/change-request-status-badge';

const SECTION_LIMIT = 10;

interface Props {
  readonly tenant: TenantContext;
  readonly memberId: string;
}

export async function MemberChangeRequestsSection({ tenant, memberId }: Props) {
  const t = await getTranslations('admin.members.changeRequests');
  const tReview = await getTranslations('admin.changeRequests.review');
  const locale = await getLocale();
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

  const fmt = (d: Date) => formatLocalisedDate(d.toISOString(), locale, { dateStyle: 'medium', timeStyle: 'short' });

  return (
    <section aria-labelledby="member-change-requests-heading" data-testid="member-change-requests-section">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-2">
          <h2 id="member-change-requests-heading" className="font-heading text-base font-medium leading-snug">
            {t('title')}
          </h2>
          <Link href={`/admin/change-requests?memberId=${encodeURIComponent(memberId)}`} className={buttonVariants({ variant: 'outline' })}>
            <FileClockIcon className="size-4" aria-hidden="true" />
            {t('viewQueue')}
          </Link>
        </CardHeader>
        <CardContent>
          {loadFailed ? (
            // `status`, not `alert`: the page rendered, one section did not —
            // no interruption of whatever the admin is reading (UX I9)
            <InlineAlert tone="destructive" role="status" data-testid="member-change-requests-unavailable">
              <p className="text-sm">{t('loadFailed')}</p>
            </InlineAlert>
          ) : items.length === 0 ? (
            <div className="py-6 text-center">
              <p className="text-sm text-muted-foreground">{t('empty')}</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-4">
              {items.map(({ row }) => {
                const r = row.request;
                return (
                  <li key={r.id} className="rounded-md border p-3" data-testid="member-change-request" data-request-id={r.id}>
                    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1 text-sm">
                        <p className="font-medium">
                          {t('submittedBy', { name: row.submitter.displayName, role: tReview(`roles.${r.submitterRoleAtSubmission}`) })}
                        </p>
                        <p className="text-caption text-muted-foreground">
                          {t('submittedOn', { submittedAt: fmt(r.submittedAt) })}
                          {r.decidedAt && row.decidedBy
                            ? ` · ${tReview('decidedBy', { name: row.decidedBy.displayName || tReview('unknownReviewer'), decidedAt: fmt(r.decidedAt) })}${row.decidedBy.deactivated ? ` ${tReview('deactivated')}` : ''}`
                            : null}
                        </p>
                      </div>
                      <div className="flex items-center gap-2">
                        <ChangeRequestStatusBadge state={r.state} outcome={r.outcome} withdrawnReason={r.withdrawnReason} audience="staff" />
                        <Link href={`/admin/change-requests/${r.id}`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
                          {r.state === 'pending' ? t('review') : t('open')}
                        </Link>
                      </div>
                    </div>
                    <div className="mt-3">
                      <ChangeRequestDiffTable fields={r.fields.map(serialiseField)} showOutcome={r.state === 'decided'} />
                    </div>
                    {r.decisionReason ? (
                      <div className="mt-3 rounded-md bg-muted/40 p-3 text-sm">
                        <p className="font-medium">{tReview('decisionReason')}</p>
                        <p className="whitespace-pre-wrap break-words">{r.decisionReason}</p>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
        </CardContent>
      </Card>
    </section>
  );
}

/** Suspense fallback matching the section's card shape (CLS-stable). */
export function MemberChangeRequestsSkeleton() {
  return (
    <Card aria-hidden="true">
      <CardHeader className="flex flex-row items-center justify-between">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="h-9 w-28" />
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className="rounded-md border p-3">
              <Skeleton className="mb-2 h-4 w-1/2" />
              <Skeleton className="h-12 w-full" />
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
