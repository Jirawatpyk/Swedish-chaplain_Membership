import type { Metadata } from 'next';
import Link from 'next/link';
import { sql } from 'drizzle-orm';
import { getLocale, getTranslations } from 'next-intl/server';
import { Mail } from 'lucide-react';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { QuotaDisplay } from '@/components/broadcast/quota-display';
import { ComposeButtonWithTooltip } from '@/components/broadcast/compose-button-with-tooltip';
import { db } from '@/lib/db';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  computeQuotaCounter,
  makeComputeQuotaDeps,
} from '@/modules/broadcasts';
import { buildMembersDeps } from '@/modules/members/members-deps';

/**
 * Member-facing e-blasts list (T079 scope adjacent — backs T053 quota-block E2E).
 *
 * Shows the member's broadcasts in a single page table + the quota
 * counter card. RLS keeps the SELECT scoped — the raw query below is
 * bound to the tenant slug but RLS would also block rows from other
 * tenants automatically.
 */
export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.broadcasts.list');
  return { title: t('title') };
}

interface BroadcastRow {
  readonly broadcast_id: string;
  readonly subject: string;
  readonly status: string;
  readonly submitted_at: Date | null;
  readonly sent_at: Date | null;
  readonly estimated_recipient_count: number;
}

export default async function EblastsListPage(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.list');
  const tStatus = await getTranslations('portal.broadcasts.list.status');
  const tCompose = await getTranslations('portal.broadcasts.compose');
  const locale = await getLocale();
  // TH locale uses Buddhist Era calendar in tax-document and benefit
  // dashboards — matches F4 invoice convention for member-facing dates.
  const dateFormatter = new Intl.DateTimeFormat(
    locale === 'th' ? 'th-TH-u-ca-buddhist' : locale,
    { dateStyle: 'medium', timeStyle: 'short' },
  );

  const session = await requireSession('member');
  const tenant = resolveTenantFromRequest();
  const membersDeps = buildMembersDeps(tenant);
  const memberLookup = await membersDeps.memberRepo.findByLinkedUserId(
    tenant,
    session.user.id,
  );

  const memberId = memberLookup.ok ? memberLookup.value.memberId : null;

  let quota = null;
  let rows: ReadonlyArray<BroadcastRow> = [];
  if (memberId !== null) {
    const quotaResult = await computeQuotaCounter(
      makeComputeQuotaDeps(tenant.slug),
      { memberId },
    );
    if (quotaResult.ok) {
      quota = {
        used: quotaResult.value.counter.used,
        reserved: quotaResult.value.counter.reserved,
        remaining: quotaResult.value.counter.remaining,
        cap: quotaResult.value.counter.cap,
        quotaYear: quotaResult.value.quotaYear,
      };
    }
    const result = (await db.execute(sql`
      SELECT broadcast_id, subject, status, submitted_at, sent_at,
             estimated_recipient_count
        FROM broadcasts
       WHERE tenant_id = ${tenant.slug}
         AND requested_by_member_id = ${memberId}
       ORDER BY COALESCE(submitted_at, created_at) DESC
       LIMIT 50
    `)) as unknown as Array<BroadcastRow>;
    rows = result;
  }

  const composeDisabled = quota !== null && quota.remaining === 0;

  return (
    <TableContainer>
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

      <section
        aria-label={t('title')}
        className="mt-6 overflow-x-auto rounded-md border"
      >
        {rows.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-12 text-center">
            <div className="rounded-full bg-muted p-3">
              <Mail className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
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
          </div>
        ) : (
          <table className="w-full min-w-[640px] text-sm">
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
              {rows.map((row) => (
                <tr key={row.broadcast_id} className="border-t">
                  <td className="px-3 py-2">
                    <Link
                      href={`/portal/broadcasts/${row.broadcast_id}`}
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
                    {row.estimated_recipient_count}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.submitted_at !== null
                      ? dateFormatter.format(new Date(row.submitted_at))
                      : '—'}
                  </td>
                  <td className="px-3 py-2 text-muted-foreground">
                    {row.sent_at !== null
                      ? dateFormatter.format(new Date(row.sent_at))
                      : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </TableContainer>
  );
}
