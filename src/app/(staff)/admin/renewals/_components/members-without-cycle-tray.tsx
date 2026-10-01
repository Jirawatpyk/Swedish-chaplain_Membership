/**
 * DV-18 — `<MembersWithoutCycleTray>` server sub-component.
 *
 * Read-only tray for the `/admin/renewals` dashboard listing members that
 * have NO `renewal_cycles` row at all (typically pre-F8 members never
 * onboarded into the cycle lifecycle). The admin clicks through to a member
 * to remediate (e.g. start a renewal cycle).
 *
 * Best-effort error handling (modeled on `PendingReviewSection`): an
 * infrastructure throw from the use-case renders a "couldn't load" card so
 * the tray NEVER crashes the pipeline page. A zero-result tenant renders the
 * shared `EmptyState` ("All members have a renewal cycle").
 *
 * Dates are formatted day-grain, locale-/BE-aware, on the server so the
 * shadcn `Table` markup stays locale-agnostic. The anti-join +
 * archived/erased exclusion lives in the Drizzle adapter
 * (`listMembersWithoutCycle`); this component is presentation-only.
 */
import Link from 'next/link';
import { getLocale, getTranslations } from 'next-intl/server';
import { Alert, Card, EmptyState } from '@jirawatpyk/aura-react/server';
import { Table, TBody, THead, Td, Th, Tr } from '@/components/shell/aura-table';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { logger } from '@/lib/logger';
import {
  type loadMembersWithoutCycle,
  type LoadMembersWithoutCycleOutput,
} from '@/modules/renewals';
import type { Settled } from '../_lib/settled';

export async function MembersWithoutCycleTray({
  tenantSlug,
  resultPromise,
}: {
  readonly tenantSlug: string;
  /**
   * Waterfall fix (eager-island pattern, `_lib/settled.ts`) — the page
   * CREATES this `loadMembersWithoutCycle` promise BEFORE its blocking
   * `await loadPipeline` so the anti-join runs concurrently with the
   * pipeline query. Settled at creation (no unhandled rejection window);
   * the unwrap re-throws INSIDE the pre-existing try so the catch renders
   * the exact same LoadErrorCard as before.
   */
  readonly resultPromise: Promise<
    Settled<Awaited<ReturnType<typeof loadMembersWithoutCycle>>>
  >;
}) {
  const t = await getTranslations('admin.renewals.membersWithoutCycle');
  const locale = await getLocale();

  let result: LoadMembersWithoutCycleOutput;
  try {
    const settled = await resultPromise;
    if (!settled.ok) throw settled.e;
    const r = settled.v;
    // The error channel is `never` today, so `ok` is always true; THROW if a
    // real error variant is ever added so the catch renders the "couldn't
    // load" card instead of silently showing an EMPTY tray.
    if (!r.ok) {
      throw new Error('loadMembersWithoutCycle returned an unexpected error');
    }
    result = r.value;
  } catch (e) {
    logger.error(
      {
        errorId: 'F8.ADMIN.MEMBERS_WITHOUT_CYCLE_LOAD',
        err: e instanceof Error ? e.message : String(e),
        tenantId: tenantSlug,
      },
      '[admin/renewals] members-without-cycle tray load failed',
    );
    return (
      <Card>
        <Alert tone="danger" title={t('loadFailed')} />
      </Card>
    );
  }

  // Board `Admin-renewals`: the title and explanation, then each member (a
  // link to their record) beside the join date.
  return (
    <Card
      title={t('banner.title')}
      titleId="members-without-cycle-heading"
      headingLevel={2}
      description={t('banner.description')}
    >
      {result.items.length === 0 ? (
        <EmptyState
          icon="users"
          title={t('empty.title')}
          description={t('empty.description')}
          headingLevel={false}
        />
      ) : (
        <div className="flex flex-col gap-[var(--aura-space-2)]">
          <p className="text-sm text-[var(--aura-fg-secondary)]" aria-live="polite">
            {t('count', { count: result.totalCount })}
            {result.totalCount > result.items.length ? (
              <span className="ml-1">{t('showingFirst', { shown: result.items.length })}</span>
            ) : null}
          </p>
          <Table caption={t('banner.title')} captionHidden bordered={false} align="middle">
            <THead>
              <Tr>
                <Th>{t('columns.company')}</Th>
                <Th>{t('columns.joinedAt')}</Th>
              </Tr>
            </THead>
            <TBody>
              {result.items.map((m) => (
                <Tr key={m.memberId}>
                  <Td>
                    <Link
                      href={`/admin/members/${m.memberId}`}
                      aria-label={t('viewMemberFor', { company: m.companyName })}
                      className="text-[var(--aura-fg-accent)] underline-offset-2 hover:underline"
                    >
                      {m.companyName}
                    </Link>
                  </Td>
                  <Td className="text-[var(--aura-fg-secondary)]">
                    {/* registrationDate is a date-only string — force UTC so
                        it never renders the previous day on a non-UTC runtime. */}
                    {formatLocalisedDate(m.registrationDate, locale, {
                      dateStyle: 'long',
                      timeZone: 'UTC',
                    })}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </Table>
        </div>
      )}
    </Card>
  );
}

export function MembersWithoutCycleTraySkeleton() {
  return (
    <Card
      header={
        <div className="flex flex-col gap-[var(--aura-space-1)]">
          <SkeletonBlock className="h-5 w-64" />
          <SkeletonBlock className="h-4 w-full max-w-md" />
        </div>
      }
    >
      <SkeletonBlock className="h-24 w-full" />
    </Card>
  );
}
