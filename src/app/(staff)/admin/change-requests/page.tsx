/**
 * F114 — `/admin/change-requests` (US2 slice; contracts/admin-change-
 * requests-api.md § queue deep link). The staff email links here with
 * `?submitter=<userId>&state=pending`: exactly one pending request for that
 * person → redirect to its review page; none → "no pending request — decided
 * by X at T" (the coalescing case, FR-011). Without a submitter the page
 * lists the pending requests oldest-first; the full queue with filters,
 * cursor paging and the overdue flag lands in US4 (T072 / T074).
 *
 * `requirePagePermission('members.read')`; platform flag OFF → 404.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { headers } from 'next/headers';
import { notFound, redirect } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { env } from '@/lib/env';
import { requirePagePermission } from '@/lib/rbac';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import { buildChangeRequestDeps } from '@/lib/members-change-request-deps';
import type { ChangeRequestListRow, UserId } from '@/modules/members';
import { buttonVariants } from '@/components/ui/button';
import { InlineAlert } from '@/components/ui/inline-alert';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  readonly searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.changeRequests.queue');
  return { title: t('title') };
}

function one(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function ChangeRequestsQueuePage({ searchParams }: PageProps) {
  if (!env.features.memberChangeApproval) notFound();
  await requirePagePermission('members.read');
  const h = await headers();
  const tenant = resolveTenantFromHeaders(h);
  const deps = buildChangeRequestDeps(tenant);
  const sp = await searchParams;
  const submitterRaw = one(sp.submitter);
  const submitter = submitterRaw && UUID_RE.test(submitterRaw) ? (submitterRaw as UserId) : undefined;
  const t = await getTranslations('admin.changeRequests.queue');
  const locale = await getLocale();
  const fmt = (d: Date) => formatLocalisedDate(d.toISOString(), locale, { dateStyle: 'medium', timeStyle: 'short' });

  let deepLinkNotice: string | null = null;
  if (submitter) {
    const pending = await deps.changeRequestRepo.listQueue(tenant, { state: 'pending', submitterUserId: submitter }, { cursor: null, limit: 2 });
    const rows = pending.ok ? pending.value.items : [];
    if (rows.length === 1 && rows[0]) redirect(`/admin/change-requests/${rows[0].request.id}`);
    if (rows.length === 0) {
      const decided = await deps.changeRequestRepo.listQueue(tenant, { state: 'decided', submitterUserId: submitter }, { cursor: null, limit: 1 });
      const last = decided.ok ? decided.value.items[0] : undefined;
      deepLinkNotice =
        last && last.request.decidedAt
          ? t('noPendingForSubmitter', { name: last.decidedBy?.displayName ?? '', decidedAt: fmt(last.request.decidedAt) })
          : t('noRequestForSubmitter');
    }
  }

  const queue = await deps.changeRequestRepo.listQueue(
    tenant,
    submitter ? { state: 'pending', submitterUserId: submitter } : { state: 'pending' },
    { cursor: null, limit: 50 },
  );
  const items: readonly ChangeRequestListRow[] = queue.ok ? queue.value.items : [];

  return (
    <TableContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      {deepLinkNotice ? (
        <InlineAlert tone="info" role="status" data-testid="deep-link-notice">
          {deepLinkNotice}
        </InlineAlert>
      ) : null}
      {items.length === 0 ? (
        <div className="rounded-md border p-8 text-center text-sm text-muted-foreground" data-testid="queue-empty">
          {t('empty')}
        </div>
      ) : (
        <ul className="divide-y divide-border rounded-md border" data-testid="queue-list">
          {items.map((row) => (
            <li key={row.request.id} className="flex flex-col gap-2 px-3 py-3 text-sm sm:flex-row sm:items-center sm:justify-between">
              <div className="space-y-0.5">
                <p className="font-medium">{row.member.companyName}</p>
                <p className="text-caption text-muted-foreground">
                  {t('rowMeta', {
                    submitter: row.submitter.displayName,
                    count: row.request.fields.length,
                    submittedAt: fmt(row.request.submittedAt),
                  })}
                </p>
              </div>
              <Link href={`/admin/change-requests/${row.request.id}`} className={`${buttonVariants({ variant: 'outline', size: 'sm' })} inline-flex items-center`}>
                {t('open')}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </TableContainer>
  );
}
