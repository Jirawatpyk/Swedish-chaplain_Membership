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
 *
 * Spec 122 US12d-1 (T1236, boards `Portal-broadcasts`, `-mobile`, `-empty`):
 * the "My broadcasts" heading with a primary Compose E-Blast button (plus
 * icon); the history as an AURA table (its own frame) from `md` up, each status an
 * AURA `StatusPill` in the portal tones; the phone list below `md`; the empty
 * history as the shared EmptyState with the same button. Pagination keeps its
 * own `?tab=broadcasts&page=N` links, on AURA `buttonClass`.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Mail, PlusIcon } from 'lucide-react';
import { Icon, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { Table, TBody, THead, Td, Th, Tr } from '@/components/shell/aura-table';
import { EmptyState } from '@/components/shell/empty-state';
import { DashboardErrorState } from '@/components/dashboard/dashboard-error-state';
import { QuotaDisplay, type QuotaSnapshot } from '@/components/broadcast/quota-display';
import { ComposeButtonWithTooltip } from '@/components/broadcast/compose-button-with-tooltip';
import { logger } from '@/lib/logger';
import { errKind, hashId, rootCause } from '@/lib/log-id';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  computeQuotaCounter,
  listMemberBroadcasts,
  makeComputeQuotaDeps,
  makeListMemberBroadcastsDeps,
} from '@/modules/broadcasts';
import { type MemberId } from '@/modules/members';
import type { IanaTimezone } from '@/modules/tenants';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { shouldShowPlanChangedExplainer } from '@/components/broadcast/quota-banner';
import { formatCalendarYear, getDateFormatLocale } from '@/lib/format-date-localised';
import { env } from '@/lib/env';
import { keepTermTogether } from '@/components/broadcast/keep-term-together';
import { getPortalBroadcastStatusTone } from '@/components/broadcast/status-badge-mapping';
import type { BroadcastStatus } from '@/modules/broadcasts';
import {
  BroadcastHistoryCardList,
  type BroadcastHistoryRowView,
} from './broadcast-history-card-list';

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
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const tQuota = await getTranslations('portal.broadcasts.quota');
  const tAudience = await getTranslations('portal.broadcasts.list.audience');
  const tList = await getTranslations('portal.broadcasts.list');
  const locale = await getLocale();
  // Tenant-TZ pin (#315 follow-up, server-UTC display class): sent/created
  // instants rendered by the UTC Vercel runtime were 7h off (wrong day past
  // 17:00 UTC). Same canonical tenant TZ the panel's own
  // `planChangedFormatter` below already uses.
  const dateFormatter = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: env.tenant.timezone,
  });
  const dateOnlyFormatter = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
    dateStyle: 'long',
    timeZone: env.tenant.timezone,
  });

  // Defensive re-clamp: `requestedPage` is documented as already clamped to
  // [1, 1000] by the Benefits page caller, but the `number` type doesn't
  // guarantee it. Re-clamp here (belt-and-suspenders) so a future second
  // caller can't drive an out-of-range / fractional DB offset; behaviour is
  // identical for the current (already-clamped) caller.
  const safePage = Math.max(1, Math.trunc(requestedPage));

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
    segmentType: string;
  }> = [];
  let pagination = { page: 1, totalPages: 0, total: 0 };
  // Portal error states #2 — a failed history read is NOT an empty history.
  let historyFailed = false;

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
      membersDeps.memberRepo.findLastPlanChangedAt(tenant, memberId),
      listMemberBroadcasts(makeListMemberBroadcastsDeps(tenant.slug), {
        memberId,
        page: safePage,
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
          {
            errKind: errKind(rootCause(planLookup.error)),
            tenantId: tenant.slug,
            memberIdHash: hashId(memberId),
          },
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
        const planChangedFormatter = new Intl.DateTimeFormat(getDateFormatLocale(locale), {
          dateStyle: 'long',
          timeZone: v.tenantTimezone,
        });
        planChangedExplainer = tQuota('planChangedExplainer', {
          date: planChangedFormatter.format(lastPlanChangedAt),
        });
      }
    } else {
      // Quota query failure (rejected promise OR Result.err) must not
      // silently render zero counters with the Compose CTA enabled. Log only
      // the error CLASS (PII/PDPA-safe): a rejected promise carries the raw
      // thrown Error; a Result.err is a wrapper whose real cause is one
      // `.cause` deep (rootCause). Either way → `errKind` never `.message`.
      const errClass =
        quotaResultS.status === 'rejected'
          ? errKind(quotaResultS.reason)
          : quotaResult && !quotaResult.ok
            ? errKind(rootCause(quotaResult.error))
            : 'unknown';
      logger.error(
        {
          errKind: errClass,
          tenantId: tenant.slug,
          memberIdHash: hashId(memberId),
        },
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
        segmentType: b.segmentType,
      }));
    } else {
      // History query failure must not crash the entire page — quota
      // panel + reset-date are the primary surface. The table becomes a
      // load-error state, never the AS4 empty state: "No broadcasts yet"
      // beside a Compose CTA told a member with history that they had none.
      historyFailed = true;
      logger.error(
        {
          errKind: errKind(listResultS.reason),
          tenantId: tenant.slug,
          memberIdHash: hashId(memberId),
          page: safePage,
        },
        'broadcasts.benefits_page.list_history_failed',
      );
    }
  }

  // U37 — formatted ONCE for both the desktop table and the phone card list,
  // so the two representations cannot drift apart.
  const historyRows: ReadonlyArray<BroadcastHistoryRowView> = history.map((row) => {
    // Guard the i18n lookup: a broadcast status without a matching
    // `status.*` key would otherwise throw at render (next-intl). Fall back
    // to the raw status so a future enum value degrades gracefully.
    const statusKey = row.status as Parameters<typeof tStatus>[0];
    const known = tStatus.has(statusKey);
    return {
      broadcastId: row.broadcastId,
      subject: row.subject,
      statusLabel: known ? tStatus(statusKey) : row.status,
      // An unknown status (no label either) degrades to the neutral pill.
      statusTone: known ? getPortalBroadcastStatusTone(row.status as BroadcastStatus) : 'neutral',
      estimatedRecipientCount: row.estimatedRecipientCount,
      // Task #6 (board `Portal-broadcasts`): "All members · 130", the count
      // locale-formatted and held to its label by no-break spaces. A segment
      // type without a label falls back to the column's word, "Audience · 130".
      audience: tList('audienceWithCount', {
        audience: tAudience.has(row.segmentType as Parameters<typeof tAudience>[0])
          ? tAudience(row.segmentType as Parameters<typeof tAudience>[0])
          : tList('columns.audience'),
        count: row.estimatedRecipientCount,
      }),
      submitted:
        row.submittedAt !== null ? dateFormatter.format(new Date(row.submittedAt)) : '—',
      sent: row.sentAt !== null ? dateFormatter.format(new Date(row.sentAt)) : '—',
    };
  });

  // Called, not mounted: the panel's output stays one resolved tree.
  return BroadcastsPanelView({
    quota,
    nextResetCopy,
    planChangedExplainer,
    historyRows,
    historyFailed,
    pagination,
  });
}

/**
 * Spec 122 US12d-1 (T1237) — the panel's render, apart from its reads, so the
 * preview harness (`aura-portal?view=benefits-eblasts`) shows the tab in each
 * state with the page's own markup. Presentation only.
 */
export async function BroadcastsPanelView({
  quota,
  nextResetCopy,
  planChangedExplainer,
  historyRows,
  historyFailed,
  pagination,
  quotaLive = true,
}: {
  readonly quota: QuotaSnapshot | null;
  readonly nextResetCopy: string | null;
  readonly planChangedExplainer: string | null;
  readonly historyRows: ReadonlyArray<BroadcastHistoryRowView>;
  readonly historyFailed: boolean;
  readonly pagination: { readonly page: number; readonly totalPages: number; readonly total: number };
  /** `false` only in the preview harness: the quota card shows `quota` and never fetches. */
  readonly quotaLive?: boolean;
}): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.list');
  const tCompose = await getTranslations('portal.broadcasts.compose');
  const tPagination = await getTranslations('portal.broadcasts.list.pagination');
  const locale = await getLocale();
  const composeDisabled = quota !== null && quota.remaining === 0;

  return (
    <section aria-labelledby="broadcasts-panel-heading" className="flex flex-col gap-6">
      {/* Panel heading + Compose CTA. The <h2> replaces the e-blasts page
          PageHeader title (058 G1 change (d)); the Compose CTA preserves
          the e-blasts PageHeader.actions slot logic verbatim (enabled
          <Link> vs disabled-with-tooltip when quota is exhausted). */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id="broadcasts-panel-heading" className="text-xl font-semibold">
            {keepTermTogether(t('title'))}
          </h2>
          <p className="aura-text-caption text-[var(--aura-fg-secondary)]">{t('subtitle')}</p>
        </div>
        {composeDisabled ? (
          <ComposeButtonWithTooltip
            label={tCompose('title')}
            // U30 — the same calendar the reset date and the table dates use;
            // this used to interpolate a raw CE integer beside BE dates.
            tooltipText={t('quotaExhaustedTooltip', {
              year: formatCalendarYear(
                quota?.quotaYear ?? new Date().getFullYear(),
                locale,
              ),
            })}
          />
        ) : (
          <Link
            href="/portal/broadcasts/new"
            className={buttonClass({ variant: 'primary', touchHeight: true, fullWidth: 'below-sm' })}
          >
            <Icon name={<PlusIcon />} size={16} />
            {tCompose('title')}
          </Link>
        )}
      </div>

      {/* AS1+AS2 reset-date + plan-changed copy now live INSIDE the
          QuotaDisplay card so they read as quota metadata, not as a
          heading floating between cards. */}
      <QuotaDisplay
        initial={quota}
        live={quotaLive}
        nextResetCopy={nextResetCopy}
        planChangedExplainer={planChangedExplainer}
      />

      {/* Load-error (canvas "E-Blasts — empty variants" B) OR AS4 empty-state
          OR AS1 history-table */}
      {historyFailed ? (
        <DashboardErrorState title={t('loadError.title')} description={t('loadError.body')} />
      ) : null}
      {!historyFailed && historyRows.length === 0 ? (
        // Shared EmptyState (standalone, so the default bordered placeholder).
        // One canonical empty-state treatment across the app (UX R2 #8/#10).
        <EmptyState
          data-testid="broadcast-empty-state"
          icon={Mail}
          title={t('emptyTitle')}
          description={t('empty')}
          action={
            composeDisabled ? undefined : (
              <Link
                href="/portal/broadcasts/new"
                className={buttonClass({ variant: 'primary', touchHeight: true })}
              >
                <Icon name={<PlusIcon />} size={16} />
                {t('emptyCta')}
              </Link>
            )
          }
        />
      ) : null}
      {historyRows.length > 0 ? (
        <>
          {/* U37 — dual-render: the table from `md` up, the card list below it
              (at 320 px the table was 729 px wide inside a 209 px box). */}
          {/* The table draws its own frame (board `Portal-broadcasts`: the
              list alone, no card head above it). */}
          <div className="hidden md:block">
            <Table
              data-testid="broadcast-history-table"
              caption={t('title')}
              captionHidden
              className="[&_td]:align-middle"
            >
              {/* U31 — the <table> itself is named by its (hidden) caption, so a
                  screen reader listing the page's tables finds it (SC 1.3.1). */}
              <THead>
                <Tr>
                  <Th>{t('columns.subject')}</Th>
                  <Th>{t('columns.status')}</Th>
                  <Th>{t('columns.audience')}</Th>
                  <Th>{t('columns.submittedAt')}</Th>
                  <Th>{t('columns.sentAt')}</Th>
                </Tr>
              </THead>
              <TBody>
                {historyRows.map((row) => (
                  <Tr key={row.broadcastId}>
                    <Td>
                      <Link
                        href={`/portal/broadcasts/${row.broadcastId}`}
                        className="font-medium text-[var(--aura-fg-primary)] no-underline hover:underline"
                      >
                        {row.subject}
                      </Link>
                    </Td>
                    <Td>
                      <StatusPill tone={row.statusTone} wrap className="max-w-full">
                        {row.statusLabel}
                      </StatusPill>
                    </Td>
                    <Td className="tabular-nums">{row.audience}</Td>
                    <Td className="whitespace-nowrap text-[var(--aura-fg-secondary)]">{row.submitted}</Td>
                    <Td className="whitespace-nowrap text-[var(--aura-fg-secondary)]">{row.sent}</Td>
                  </Tr>
                ))}
              </TBody>
            </Table>
          </div>
          <BroadcastHistoryCardList
            rows={historyRows}
            labels={{
              submittedAt: t('columns.submittedAt'),
              sentAt: t('columns.sentAt'),
            }}
            className="md:hidden"
          />
        </>
      ) : null}

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
          className="flex items-center justify-between gap-3 aura-text-caption"
        >
          {pagination.page > 1 ? (
            <Link
              href={`/portal/benefits?tab=broadcasts&page=${pagination.page - 1}`}
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
              data-testid="pagination-prev"
            >
              {tPagination('previous')}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              data-testid="pagination-prev"
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true, className: 'pointer-events-none cursor-not-allowed opacity-50' })}
            >
              {tPagination('previous')}
            </span>
          )}
          <span className="text-[var(--aura-fg-secondary)]">
            {tPagination('pageOf', {
              page: pagination.page,
              total: pagination.totalPages,
            })}
          </span>
          {pagination.page < pagination.totalPages ? (
            <Link
              href={`/portal/benefits?tab=broadcasts&page=${pagination.page + 1}`}
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
              data-testid="pagination-next"
            >
              {tPagination('next')}
            </Link>
          ) : (
            <span
              aria-disabled="true"
              data-testid="pagination-next"
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true, className: 'pointer-events-none cursor-not-allowed opacity-50' })}
            >
              {tPagination('next')}
            </span>
          )}
        </nav>
      ) : null}
    </section>
  );
}
