/**
 * F7 US3 T130 — Member benefits page: E-Blast quota + history.
 *
 * Spec authority: spec.md US3 AS1, AS2, AS4 + contracts/broadcasts-api.md
 * § 1.7 (`nextResetAt` + `tenantTimezone`).
 *
 * Layout: `DetailContainer` (72rem) per ux-standards.md container
 * selection guideline — this is a content-detail surface, not a
 * data table. Cache Components migration deferred to F7.1; this page
 * uses the segment-level `revalidate` option for a 60-second perf
 * staleness budget per plan.md § Cold-start, caching, & memoisation (CHK056).
 *
 * Pagination: server-driven `?page=N` URL parameter, OFFSET-based via
 * `BroadcastsRepo.listForMemberPaginated`. 10 rows per page.
 *
 * Plan-changed-mid-year explainer (AS2): derived from a small audit-log
 * lookup `member_plan_changed`-event timestamp. If the most recent
 * change falls within the current quota year, the explainer microcopy
 * renders; otherwise the row is suppressed.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Mail } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { QuotaDisplay } from '@/components/broadcast/quota-display';
import { ComposeButtonWithTooltip } from '@/components/broadcast/compose-button-with-tooltip';
import { logger } from '@/lib/logger';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { asMemberId } from '@/modules/members';
import type { IanaTimezone } from '@/modules/tenants';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  formatNextResetAt,
  intlLocale,
  shouldShowPlanChangedExplainer,
} from './_helpers/quota-banner';

/** 60-second segment-level revalidate per plan.md § Cold-start, caching, & memoisation (CHK056) — full Cache
 *  Components migration is F7.1 polish (D5 of plan). */
export const revalidate = 60;

const PER_PAGE = 10;

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.broadcasts.list');
  return { title: t('title') };
}

export default async function EblastsListPage(props: {
  searchParams: Promise<{ page?: string }>;
}): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.list');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const tCompose = await getTranslations('portal.broadcasts.compose');
  const tQuota = await getTranslations('portal.broadcasts.quota');
  const tPagination = await getTranslations(
    'portal.broadcasts.list.pagination',
  );
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const dateOnlyFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'long',
  });

  const session = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    session.user.id,
  );
  const memberId = memberLookup.ok ? memberLookup.value.memberId : null;

  const searchParams = await props.searchParams;
  const requestedPage = Math.max(1, Number(searchParams.page ?? '1') || 1);

  let quota: {
    used: number;
    reserved: number;
    remaining: number;
    cap: number;
    quotaYear: number;
    nextResetAt: string;
    tenantTimezone: IanaTimezone;
  } | null = null;
  let nextResetCopy: string | null = null;
  let planChangedExplainer: string | null = null;
  let history: Array<{
    broadcastId: string;
    subject: string;
    status: string;
    submittedAt: Date | null;
    sentAt: Date | null;
    estimatedRecipientCount: number;
  }> = [];
  let pagination = { page: 1, totalPages: 0, total: 0 };

  if (memberId !== null) {
    const quotaResult = await computeQuotaCounter(
      makeComputeQuotaDeps(tenant.slug),
      { memberId },
    );
    if (quotaResult.ok) {
      const v = quotaResult.value;
      quota = {
        used: v.counter.used,
        reserved: v.counter.reserved,
        remaining: v.counter.remaining,
        cap: v.counter.cap,
        quotaYear: v.quotaYear,
        nextResetAt: v.nextResetAt,
        tenantTimezone: v.tenantTimezone,
      };

      // AS1 — reset-date copy localised via tenant tz year boundary.
      const resetIso = formatNextResetAt(v.quotaYear, v.tenantTimezone);
      nextResetCopy = tQuota('nextReset', {
        date: dateOnlyFormatter.format(new Date(resetIso)),
      });

      // AS2 — plan-changed explainer: read most-recent audit timestamp
      // via the F3 `findLastPlanChangedAt` port (Constitution Principle
      // III — Presentation never reaches into infrastructure directly).
      const planLookup = await membersDeps.memberRepo.findLastPlanChangedAt(
        tenant,
        asMemberId(memberId),
      );
      if (!planLookup.ok) {
        // Real DB error must not silently masquerade as "no plan
        // change". Log so an audit-log read regression is observable;
        // continue with `null` so the explainer is suppressed (graceful
        // degradation — the page still renders with the quota panel).
        logger.error(
          {
            err: planLookup.error,
            tenantId: tenant.slug,
            memberId,
          },
          'broadcasts.benefits_page.find_last_plan_changed_at_failed',
        );
      }
      const lastPlanChangedAt = planLookup.ok ? planLookup.value : null;
      if (
        shouldShowPlanChangedExplainer(
          lastPlanChangedAt,
          v.quotaYear,
          v.tenantTimezone,
        )
      ) {
        // Format the plan-changed date in the tenant timezone so the
        // microcopy reads "Plan changed on <Bangkok-day>" regardless
        // of where the server is running.
        const planChangedFormatter = new Intl.DateTimeFormat(
          intlLocale(locale),
          { dateStyle: 'long', timeZone: v.tenantTimezone },
        );
        planChangedExplainer = tQuota('planChangedExplainer', {
          date: planChangedFormatter.format(lastPlanChangedAt!),
        });
      }
    } else {
      // Quota query failure must not silently render zero counters
      // with the Compose CTA enabled. Log + render the page with
      // `quota=null` (the quota panel handles its own error state via
      // `<QuotaDisplay initial={null}>`); the Compose CTA stays
      // enabled because the spec mandates the benefit is observable
      // even when the count is unknown — the submit endpoint itself
      // re-validates quota at the boundary (defence in depth).
      logger.error(
        {
          err: quotaResult.error,
          tenantId: tenant.slug,
          memberId,
        },
        'broadcasts.benefits_page.compute_quota_counter_failed',
      );
    }

    const listResult = await listMemberBroadcasts(
      makeListMemberBroadcastsDeps(tenant.slug),
      { memberId, page: requestedPage, perPage: PER_PAGE },
    );
    pagination = {
      page: listResult.page,
      totalPages: listResult.totalPages,
      total: listResult.total,
    };
    history = listResult.rows.map((b) => ({
      broadcastId: b.broadcastId as string,
      subject: b.subject,
      status: b.status,
      submittedAt: b.submittedAt,
      sentAt: b.sentAt,
      estimatedRecipientCount: b.estimatedRecipientCount,
    }));
  }

  const composeDisabled = quota !== null && quota.remaining === 0;

  return (
    <DetailContainer>
      <PageHeader
        title={t('title')}
        subtitle={t('subtitle')}
        actions={
          composeDisabled ? (
            <ComposeButtonWithTooltip
              label={tCompose('title')}
              tooltipText={t('quotaExhaustedTooltip', {
                year: quota?.quotaYear ?? new Date().getFullYear(),
              })}
            />
          ) : (
            <Link
              href="/portal/broadcasts/new"
              className={buttonVariants({ variant: 'default' })}
            >
              {tCompose('title')}
            </Link>
          )
        }
      />

      <QuotaDisplay initial={quota} showComposeCta={!composeDisabled} />

      {/* AS1 reset-date copy + AS2 plan-changed explainer — both inside
          the quota card surface but rendered as sibling testid'd nodes
          so the E2E can assert each independently. */}
      {nextResetCopy !== null ? (
        <p
          data-testid="quota-next-reset"
          className="mt-2 text-xs text-muted-foreground"
        >
          {nextResetCopy}
        </p>
      ) : null}
      {/* AS2: testid present (count=1) when explainer is applicable.
          When suppressed (no plan change in quota year), the testid is
          omitted entirely so T129 distinguishes "shown vs hidden". */}
      {planChangedExplainer !== null ? (
        <p
          data-testid="quota-plan-changed-explainer"
          className="mt-2 text-xs text-amber-700 dark:text-amber-300"
        >
          {planChangedExplainer}
        </p>
      ) : null}

      {/* AS4 empty-state OR AS1 history-table */}
      {history.length === 0 ? (
        <section
          data-testid="broadcast-empty-state"
          aria-label={t('emptyTitle')}
          className="mt-6 flex flex-col items-center gap-3 rounded-md border px-4 py-12 text-center"
        >
          <div className="rounded-full bg-muted p-3">
            {/* Icon area follows ux-standards.md § 3.1 empty-state size. */}
            <Mail className="h-10 w-10 text-muted-foreground" aria-hidden="true" />
          </div>
          <p className="text-sm font-medium">{t('emptyTitle')}</p>
          <p className="max-w-md text-xs text-muted-foreground">{t('empty')}</p>
          {composeDisabled ? null : (
            <Link
              href="/portal/broadcasts/new"
              className={buttonVariants({ size: 'sm' })}
            >
              {t('emptyCta')}
            </Link>
          )}
        </section>
      ) : (
        <section
          aria-label={t('title')}
          className="mt-6 overflow-x-auto rounded-md border"
        >
          <table
            data-testid="broadcast-history-table"
            className="w-full min-w-[640px] text-sm"
          >
            <thead className="bg-muted/50 text-xs uppercase tracking-wide">
              <tr>
                <th scope="col" className="px-3 py-2 text-left">
                  {t('columns.subject')}
                </th>
                <th scope="col" className="px-3 py-2 text-left">
                  {t('columns.status')}
                </th>
                <th scope="col" className="px-3 py-2 text-left">
                  {t('columns.audience')}
                </th>
                <th scope="col" className="px-3 py-2 text-left">
                  {t('columns.submittedAt')}
                </th>
                <th scope="col" className="px-3 py-2 text-left">
                  {t('columns.sentAt')}
                </th>
              </tr>
            </thead>
            <tbody>
              {history.map((row) => (
                <tr key={row.broadcastId} className="border-t">
                  <td className="px-3 py-2">
                    <Link
                      href={`/portal/broadcasts/${row.broadcastId}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {row.subject}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Badge variant="outline">
                      {tStatus(row.status as Parameters<typeof tStatus>[0])}
                    </Badge>
                  </td>
                  <td className="px-3 py-2 tabular-nums">
                    {row.estimatedRecipientCount}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.submittedAt !== null
                      ? dateFormatter.format(new Date(row.submittedAt))
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.sentAt !== null
                      ? dateFormatter.format(new Date(row.sentAt))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      {/* Server-driven pagination (T128 / T129). At edges, render a
          disabled <span> instead of an <a href="#"> — clicking
          href="#" scrolls to top of page (unexpected on mobile) and
          aria-disabled on <a> doesn't actually prevent navigation. */}
      {pagination.totalPages > 1 ? (
        <nav
          data-testid="broadcast-history-pagination"
          aria-label={tPagination('ariaLabel')}
          className="mt-4 flex items-center justify-between text-sm"
        >
          {pagination.page > 1 ? (
            <Link
              href={`/portal/benefits/e-blasts?page=${pagination.page - 1}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              data-testid="pagination-prev"
            >
              {tPagination('previous')}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              data-testid="pagination-prev"
              className={`${buttonVariants({ variant: 'outline', size: 'sm' })} cursor-not-allowed opacity-50 pointer-events-none`}
            >
              {tPagination('previous')}
            </span>
          )}
          <span className="text-muted-foreground">
            {tPagination('pageOf', {
              page: pagination.page,
              total: pagination.totalPages,
            })}
          </span>
          {pagination.page < pagination.totalPages ? (
            <Link
              href={`/portal/benefits/e-blasts?page=${pagination.page + 1}`}
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
              data-testid="pagination-next"
            >
              {tPagination('next')}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              data-testid="pagination-next"
              className={`${buttonVariants({ variant: 'outline', size: 'sm' })} cursor-not-allowed opacity-50 pointer-events-none`}
            >
              {tPagination('next')}
            </span>
          )}
        </nav>
      ) : null}
    </DetailContainer>
  );
}
