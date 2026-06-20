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
import { AlertTriangle, UserCheck } from 'lucide-react';
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
import { Skeleton } from '@/components/ui/skeleton';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { logger } from '@/lib/logger';
import {
  loadMembersWithoutCycle,
  makeRenewalsDeps,
  type LoadMembersWithoutCycleOutput,
} from '@/modules/renewals';

export async function MembersWithoutCycleTray({
  tenantSlug,
}: {
  readonly tenantSlug: string;
}) {
  const t = await getTranslations('admin.renewals.membersWithoutCycle');
  const locale = await getLocale();
  const deps = makeRenewalsDeps(tenantSlug);

  let result: LoadMembersWithoutCycleOutput;
  try {
    const r = await loadMembersWithoutCycle(deps, { tenantId: tenantSlug });
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
        <CardContent
          role="alert"
          aria-live="assertive"
          className="flex flex-col items-center gap-4 py-12 text-center"
        >
          <AlertTriangle
            aria-hidden="true"
            className="h-10 w-10 text-destructive"
          />
          <div className="text-base font-medium text-destructive">
            {t('loadFailed')}
          </div>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardContent className="flex flex-col gap-4">
        <section
          aria-labelledby="members-without-cycle-heading"
          className="flex flex-col gap-3"
        >
          <div className="space-y-1">
            <h2
              id="members-without-cycle-heading"
              className="text-base font-semibold"
            >
              {t('banner.title')}
            </h2>
            <p className="text-sm text-muted-foreground">
              {t('banner.description')}
            </p>
          </div>

          {result.items.length === 0 ? (
            <EmptyState
              icon={UserCheck}
              title={t('empty.title')}
              description={t('empty.description')}
              bordered={false}
            />
          ) : (
            <>
              <p className="text-sm text-muted-foreground" aria-live="polite">
                {t('count', { count: result.totalCount })}
                {result.totalCount > result.items.length ? (
                  <span className="ml-1">
                    {t('showingFirst', { shown: result.items.length })}
                  </span>
                ) : null}
              </p>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t('columns.company')}</TableHead>
                    <TableHead>{t('columns.joinedAt')}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {result.items.map((m) => (
                    <TableRow key={m.memberId}>
                      <TableCell>
                        <Link
                          href={`/admin/members/${m.memberId}`}
                          aria-label={t('viewMemberFor', {
                            company: m.companyName,
                          })}
                          className="rounded-sm text-primary underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
                        >
                          {m.companyName}
                        </Link>
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {/* registrationDate is a date-only string — force UTC
                            so it never renders the previous day on a non-UTC
                            runtime (matches the invoice tables' convention). */}
                        {formatLocalisedDate(m.registrationDate, locale, {
                          dateStyle: 'long',
                          timeZone: 'UTC',
                        })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </>
          )}
        </section>
      </CardContent>
    </Card>
  );
}

/**
 * Suspense fallback for `<MembersWithoutCycleTray>` — a Card-shaped skeleton so
 * the tray's anti-join query streams in WITHOUT blocking the pipeline's render
 * (it would otherwise run as a serial waterfall after `loadPipeline`, adding a
 * round-trip to the SC-003 hot path). Presentational only; no layout shift.
 */
export function MembersWithoutCycleTraySkeleton() {
  return (
    <Card>
      <CardContent className="flex flex-col gap-3">
        <Skeleton className="h-5 w-64" />
        <Skeleton className="h-4 w-full max-w-md" />
        <Skeleton className="h-24 w-full" />
      </CardContent>
    </Card>
  );
}
