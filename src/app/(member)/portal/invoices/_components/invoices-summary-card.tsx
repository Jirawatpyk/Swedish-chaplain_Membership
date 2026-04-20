/**
 * T072 (R7-B3 polish) — Member-portal invoice summary card.
 *
 * Renders the **latest 3 invoices** for the signed-in member plus a
 * "view all" link to `/portal/invoices`. Mounted on `/portal`
 * (member landing page) to satisfy **US7 AS4**:
 *
 *   Given a `member` role (self-service),
 *   When they open their own portal landing page,
 *   Then a compact invoice-history summary (latest 3 + "view all"
 *        link) is visible.
 *
 * Architecture notes:
 * - Server Component: calls `listInvoicesPaged` directly with
 *   `memberId` filter (same B3 pattern as `/portal/invoices`).
 *   `includeDrafts: false` — members never see drafts.
 * - Handles the **three member-linking states** surfaced on the
 *   full list page (linked + has invoices, linked + empty, not
 *   linked) so the card renders gracefully in all cases — no 5xx
 *   regression path.
 * - Reuses `portal.invoices.*` i18n namespace + adds
 *   `portal.invoices.summary.*` keys (heading + viewAll copy).
 * - PDF download goes through the same byte-streamed route as the
 *   full list (`/api/portal/invoices/[id]/pdf`) — no Blob URL leak.
 */
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import type { UserAccount } from '@/modules/auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';

const SUMMARY_LIMIT = 3;

function formatSatangThb(satang: bigint | null): string {
  if (satang === null) return '—';
  const whole = satang / 100n;
  const rem = satang % 100n;
  return `${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')} THB`;
}

function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type InvoiceStatusBadgeVariant =
  | 'default'
  | 'secondary'
  | 'outline'
  | 'destructive';

function statusBadgeVariant(status: string): InvoiceStatusBadgeVariant {
  switch (status) {
    case 'paid':
      return 'default';
    case 'issued':
      return 'secondary';
    case 'overdue':
      return 'destructive';
    default:
      return 'outline';
  }
}

export interface InvoicesSummaryCardProps {
  /** The authenticated member-role user from `requireSession('member')`. */
  readonly user: Pick<UserAccount, 'id'>;
}

export async function InvoicesSummaryCard({ user }: InvoicesSummaryCardProps) {
  const t = await getTranslations('portal.invoices');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const userLocale = await getLocale();

  const tenantCtx = resolveTenantFromRequest();
  const memberDeps = buildMembersDeps(tenantCtx);

  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(
    tenantCtx,
    user.id,
  );

  if (!memberResult.ok) {
    // Not-linked state: surface the same copy the full list uses so
    // members don't get conflicting signals across portal surfaces.
    return (
      <Card>
        <CardHeader>
          <CardTitle>{t('summary.heading')}</CardTitle>
          <CardDescription>{t('summary.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-muted-foreground">
            {t('notLinked')}
          </p>
        </CardContent>
      </Card>
    );
  }

  const member = memberResult.value;

  const invoicesResult = await listInvoicesPaged(
    makeListInvoicesDeps(tenantCtx.slug),
    {
      tenantId: tenantCtx.slug,
      offset: 0,
      pageSize: SUMMARY_LIMIT,
      includeDrafts: false,
      memberId: member.memberId,
    },
  );

  const rows = invoicesResult.ok ? invoicesResult.value.rows : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle>{t('summary.heading')}</CardTitle>
          <CardDescription>{t('summary.description')}</CardDescription>
        </div>
        {rows.length > 0 ? (
          <Link
            href="/portal/invoices"
            className={cn(
              buttonVariants({ variant: 'ghost', size: 'sm' }),
              'min-h-11 px-3',
            )}
          >
            {t('summary.viewAll')}
          </Link>
        ) : null}
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-caption text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li
                key={r.invoiceId}
                className="flex flex-wrap items-center justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex flex-col gap-1">
                  <span className="font-mono text-caption text-muted-foreground">
                    {r.documentNumber?.raw ?? '—'}
                  </span>
                  <div className="flex items-center gap-2">
                    <Badge variant={statusBadgeVariant(r.status)}>
                      {tStatus(r.status)}
                    </Badge>
                    <span className="text-caption text-muted-foreground">
                      {formatDate(r.issueDate, userLocale)}
                    </span>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span className="tabular-nums text-body font-medium">
                    {formatSatangThb(r.total?.satang ?? null)}
                  </span>
                  {r.pdf ? (
                    <a
                      href={`/api/portal/invoices/${r.invoiceId}/pdf`}
                      aria-label={`${t('actions.download')} — ${r.documentNumber?.raw ?? r.invoiceId}`}
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'sm' }),
                        'min-h-11 px-3',
                      )}
                      target="_blank"
                      rel="noopener noreferrer"
                      download
                    >
                      {t('actions.download')}
                    </a>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
