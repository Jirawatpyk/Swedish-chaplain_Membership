/**
 * 058 G1 T4 — BroadcastsPanel server component.
 *
 * Extracted verbatim from the F7 US3 T130 e-blasts page body
 * (`../e-blasts/page.tsx`) so the tabbed Benefits page stays small, and the
 * e-blasts route is now a thin redirect to ?tab=broadcasts (058 G1).
 *
 * Spec authority (unchanged from the e-blasts page): spec.md US3 AS1, AS2,
 * AS4 + contracts/broadcasts-api.md § 1.7 (`nextResetAt` + `tenantTimezone`).
 *
 * Pagination: server-driven, but driven by the `?tab=broadcasts&page=N` URL
 * shape (so `?tab=` and `?page=` coexist on the tabbed Benefits page). The
 * caller (Benefits page, T5) computes & clamps the requested page and passes
 * it as `requestedPage`; this panel does NOT parse `searchParams` and carries
 * no `export const revalidate` (that belongs on the page segment, T5).
 *
 * Plan-changed-mid-year explainer (AS2): derived from a small audit-log
 * lookup `member_plan_changed`-event timestamp. If the most recent change
 * falls within the current quota year, the explainer microcopy renders;
 * otherwise the row is suppressed.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Mail } from 'lucide-react';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { EmptyState } from '@/components/shell/empty-state';
import { QuotaDisplay } from '@/components/broadcast/quota-display';
import { ComposeButtonWithTooltip } from '@/components/broadcast/compose-button-with-tooltip';
import { logger } from '@/lib/logger';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { asMemberId, type MemberId } from '@/modules/members';
import type { IanaTimezone } from '@/modules/tenants';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { intlLocale, shouldShowPlanChangedExplainer } from '../e-blasts/_helpers/quota-banner';

const PER_PAGE = 10;

export async function BroadcastsPanel({
  requestedPage,
  memberId,
}: {
  readonly requestedPage: number;
  /**
   * The signed-in member's id, resolved ONCE by the Benefits page
   * (`findByLinkedUserId`) and threaded down. The page renders its
   * not-found empty card BEFORE this panel, so `memberId` is guaranteed
   * non-null here — the panel no longer re-derives the session/member
   * (removes 4 duplicate DB roundtrips per load and the bug where a
   * transient lookup failure silently fell into the "unlinked" path,
   * leaving the Compose CTA enabled with zeroed quota). xhigh #2/#3.
   */
  readonly memberId: MemberId;
}): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.list');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const tCompose = await getTranslations('portal.broadcasts.compose');
  const tQuota = await getTranslations('portal.broadcasts.quota');
  const tPagination = await getTranslations('portal.broadcasts.list.pagination');
  const locale = await getLocale();
  const dateFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const dateOnlyFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
    dateStyle: 'long',
  });

  // `memberId` is supplied by the page (resolved once via the session).
  // `membersDeps` is still needed for the F3 `findLastPlanChangedAt` port.
  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);

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

  {
    // `memberId` is always present (page-resolved). Bare block scope keeps
    // the parallel-fetch locals from leaking — the outer `let`s above are
    // the panel's render inputs. xhigh #2/#3.
    //
    // Parallelise the 3 independent DB roundtrips (quota + plan-changed
    // audit + history) via Promise.allSettled. Previously sequential
    // (~260ms total Neon Singapore) which crossed the streaming
    // threshold and made the loading.tsx skeleton paint visibly on
    // refresh; parallelised they complete in ~max(80,80,100)≈100ms
    // and the shell + content arrive together.
    const [quotaResultS, planLookupS, listResultS] = await Promise.allSettled([
      computeQuotaCounter(makeComputeQuotaDeps(tenant.slug), { memberId }),
      membersDeps.memberRepo.findLastPlanChangedAt(tenant, asMemberId(memberId)),
      listMemberBroadcasts(makeListMemberBroadcastsDeps(tenant.slug), {
        memberId,
        page: requestedPage,
        perPage: PER_PAGE,
      }),
    ]);

    const quotaResult = quotaResultS.status === 'fulfilled' ? quotaResultS.value : null;
    const planLookup = planLookupS.status === 'fulfilled' ? planLookupS.value : null;

    if (quotaResult && quotaResult.ok) {
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

      // AS1 — use the use-case's `nextResetAt` directly (single source of
      // truth shared with the API contract field).
      nextResetCopy = tQuota('nextReset', {
        date: dateOnlyFormatter.format(new Date(v.nextResetAt)),
      });

      // AS2 — plan-changed explainer: derive from the parallel-fetched
      // audit lookup. Constitution Principle III — Presentation never
      // reaches into infrastructure directly; uses the F3 port.
      if (planLookup && !planLookup.ok) {
        // Real DB error must not silently masquerade as "no plan
        // change". Log so an audit-log read regression is observable;
        // continue with `null` so the explainer is suppressed.
        logger.error(
          { err: planLookup.error, tenantId: tenant.slug, memberId },
          'broadcasts.benefits_page.find_last_plan_changed_at_failed',
        );
      }
      const lastPlanChangedAt = planLookup && planLookup.ok ? planLookup.value : null;
      if (
        lastPlanChangedAt !== null &&
        shouldShowPlanChangedExplainer(lastPlanChangedAt, v.quotaYear, v.tenantTimezone)
      ) {
        // Format the plan-changed date in the tenant timezone so the
        // microcopy reads "Plan changed on <Bangkok-day>" regardless
        // of where the server is running.
        const planChangedFormatter = new Intl.DateTimeFormat(intlLocale(locale), {
          dateStyle: 'long',
          timeZone: v.tenantTimezone,
        });
        planChangedExplainer = tQuota('planChangedExplainer', {
          date: planChangedFormatter.format(lastPlanChangedAt),
        });
      }
    } else {
      // Quota query failure (rejected promise OR Result.err) must not
      // silently render zero counters with the Compose CTA enabled.
      const err =
        quotaResultS.status === 'rejected'
          ? quotaResultS.reason
          : quotaResult && !quotaResult.ok
            ? quotaResult.error
            : null;
      logger.error(
        { err, tenantId: tenant.slug, memberId },
        'broadcasts.benefits_page.compute_quota_counter_failed',
      );
    }

    if (listResultS.status === 'fulfilled') {
      const listResult = listResultS.value;
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
    } else {
      // History query failure must not crash the entire page — quota
      // panel + reset-date are the primary surface; the table degrades
      // to the AS4 empty-state.
      logger.error(
        {
          err: listResultS.reason,
          tenantId: tenant.slug,
          memberId,
          page: requestedPage,
        },
        'broadcasts.benefits_page.list_history_failed',
      );
    }
  }

  const composeDisabled = quota !== null && quota.remaining === 0;

  return (
    <section aria-labelledby="broadcasts-panel-heading" className="flex flex-col gap-6">
      {/* Panel heading + Compose CTA. The <h2> replaces the e-blasts page
          PageHeader title (058 G1 change (d)); the Compose CTA preserves
          the e-blasts PageHeader.actions slot logic verbatim (enabled
          <Link> vs disabled-with-tooltip when quota is exhausted). */}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="space-y-1">
          <h2 id="broadcasts-panel-heading" className="text-lg font-semibold">
            {t('title')}
          </h2>
          <p className="text-sm text-muted-foreground">{t('subtitle')}</p>
        </div>
        {composeDisabled ? (
          <ComposeButtonWithTooltip
            label={tCompose('title')}
            tooltipText={t('quotaExhaustedTooltip', {
              year: quota?.quotaYear ?? new Date().getFullYear(),
            })}
          />
        ) : (
          <Link href="/portal/broadcasts/new" className={buttonVariants({ variant: 'default' })}>
            {tCompose('title')}
          </Link>
        )}
      </div>

      {/* AS1+AS2 reset-date + plan-changed copy now live INSIDE the
          QuotaDisplay card so they read as quota metadata, not as a
          heading floating between cards. */}
      <QuotaDisplay
        initial={quota}
        nextResetCopy={nextResetCopy}
        planChangedExplainer={planChangedExplainer}
      />

      {/* AS4 empty-state OR AS1 history-table */}
      {history.length === 0 ? (
        // Shared EmptyState (standalone, so the default bordered placeholder).
        // One canonical empty-state treatment across the app (UX R2 #8/#10).
        <EmptyState
          data-testid="broadcast-empty-state"
          icon={Mail}
          title={t('emptyTitle')}
          description={t('empty')}
          action={
            composeDisabled ? undefined : (
              <Link href="/portal/broadcasts/new" className={buttonVariants({ size: 'sm' })}>
                {t('emptyCta')}
              </Link>
            )
          }
        />
      ) : (
        <Card>
          <CardContent>
            <Table
              data-testid="broadcast-history-table"
              aria-label={t('title')}
              className="min-w-[640px]"
            >
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('columns.subject')}</TableHead>
                  <TableHead scope="col">{t('columns.status')}</TableHead>
                  <TableHead scope="col">{t('columns.audience')}</TableHead>
                  <TableHead scope="col">{t('columns.submittedAt')}</TableHead>
                  <TableHead scope="col">{t('columns.sentAt')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {history.map((row) => {
                  // Guard the i18n lookup: a broadcast status without a matching
                  // `status.*` key would otherwise throw at render (next-intl).
                  // Fall back to the raw status so a future enum value degrades
                  // gracefully. Cast hoisted once (was repeated in has()+call()).
                  const statusKey = row.status as Parameters<typeof tStatus>[0];
                  const statusLabel = tStatus.has(statusKey) ? tStatus(statusKey) : row.status;
                  return (
                    <TableRow key={row.broadcastId}>
                      <TableCell>
                        <Link
                          href={`/portal/broadcasts/${row.broadcastId}`}
                          className="font-medium text-primary hover:underline"
                        >
                          {row.subject}
                        </Link>
                      </TableCell>
                      <TableCell>
                        <Badge variant="outline">{statusLabel}</Badge>
                      </TableCell>
                      <TableCell className="tabular-nums">{row.estimatedRecipientCount}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.submittedAt !== null
                          ? dateFormatter.format(new Date(row.submittedAt))
                          : '—'}
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {row.sentAt !== null ? dateFormatter.format(new Date(row.sentAt)) : '—'}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      {/* Server-driven pagination (T128 / T129). At edges, render a
          disabled <span> instead of an <a href="#"> — clicking
          href="#" scrolls to top of page (unexpected on mobile) and
          aria-disabled on <a> doesn't actually prevent navigation.
          Hrefs target `?tab=broadcasts&page=N` so the tab + page params
          coexist on the tabbed Benefits page (058 G1). */}
      {pagination.totalPages > 1 ? (
        <nav
          data-testid="broadcast-history-pagination"
          aria-label={tPagination('ariaLabel')}
          className="flex items-center justify-between text-sm"
        >
          {pagination.page > 1 ? (
            <Link
              href={`/portal/benefits?tab=broadcasts&page=${pagination.page - 1}`}
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
              href={`/portal/benefits?tab=broadcasts&page=${pagination.page + 1}`}
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
    </section>
  );
}
