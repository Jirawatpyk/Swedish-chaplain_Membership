/**
 * Member-portal invoice summary card (relocated from
 * `app/(member)/portal/invoices/_components/` to the shared
 * `src/components/portal/` namespace — review S1 architect).
 *
 * Renders the **latest 3 invoices** for the signed-in member plus a
 * "view all" link to `/portal/invoices`. Reused by BOTH the Invoices
 * page and the redesigned Dashboard (`/portal`), which is why it now
 * lives under `src/components/portal/` rather than a route-local
 * `_components/` folder.
 *
 * Architecture notes (unchanged from the original):
 * - Server Component: calls `listInvoicesPaged` directly with a
 *   `memberId` filter resolved from the session via
 *   `findByLinkedUserId` (RLS-safe, never URL-derived).
 *   `includeDrafts: false` — members never see drafts.
 * - Handles the three member-linking states (linked + has invoices,
 *   linked + empty, not linked) so the card renders gracefully in all
 *   cases — no 5xx regression path.
 * - On a backend read failure it logs + renders a distinct error
 *   variant (NOT the "no invoices" empty copy) so operators see the
 *   diagnostic (R7-M4).
 */
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import type { UserAccount } from '@/modules/auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind } from '@/lib/log-id';
import { listInvoicesPaged, makeListInvoicesDeps } from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
} from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  AlertTriangle,
  Ban,
  CheckCircle2,
  Clock,
  FileText,
  type LucideIcon,
} from 'lucide-react';
import {
  formatDate,
  formatSatangThb,
  statusBadgeVariant,
  statusIconName,
  type InvoiceStatusIconName,
} from '@/app/(member)/portal/invoices/_utils/format';
import { PortalInvoiceDownloadButton } from '@/app/(member)/portal/invoices/_components/portal-pdf-download-button';

const SUMMARY_LIMIT = 3;

const STATUS_ICON_MAP: Record<InvoiceStatusIconName, LucideIcon> = {
  CheckCircle2,
  Clock,
  AlertTriangle,
  FileText,
  Ban,
};

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
          <h2 className="font-heading text-base font-medium leading-snug">{t('summary.heading')}</h2>
          <CardDescription>{t('summary.description')}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-caption text-muted-foreground">
            {t('notLinked')}
          </p>
          <a
            href="mailto:info@swecham.se"
            className={cn(
              buttonVariants({ variant: 'outline', size: 'sm' }),
              'min-h-11 px-3 self-start',
            )}
          >
            {t('summary.contactAdmin')}
          </a>
        </CardContent>
      </Card>
    );
  }

  const member = memberResult.value;

  // R7-M4 — was: `invoicesResult.ok ? value.rows : []` (silent fallback).
  // Card showed "no invoices" copy on backend failures, identical to a member
  // who actually had zero invoices. Now we log + render a distinct error
  // variant so operators see the diagnostic.
  //
  // D1 review finding B3 — `listInvoicesPaged` is typed `Result<…, never>` and
  // has NO try/catch: a DB error THROWS rather than returning `!ok`, so the
  // `!ok` branch was UNREACHABLE and the card would CRASH instead of showing
  // the error variant. Wrap the call so a thrown read renders the error variant
  // (making the docblock claim true). Log only the error CLASS (errKind) — never
  // the raw error/SQL/PII.
  let rows;
  try {
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
    // `listInvoicesPaged` is `Result<…, never>` — `ok` is always true at
    // runtime, but the union still carries the `Err<never>` variant so we
    // narrow explicitly (the `else` is type-unreachable, not a real branch).
    if (!invoicesResult.ok) throw new Error('unreachable');
    rows = invoicesResult.value.rows;
  } catch (e) {
    logger.warn(
      {
        tenantId: tenantCtx.slug,
        memberId: member.memberId,
        errKind: errKind(e),
      },
      '[portal-invoices-summary] listInvoicesPaged threw — rendering error variant',
    );
    return (
      <Card>
        <CardHeader>
          <h2 className="font-heading text-base font-medium leading-snug">{t('summary.heading')}</h2>
          <CardDescription>{t('summary.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <p className="text-caption text-muted-foreground">{t('loadFailed')}</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      {/* Heading + "view all" share one centred row (heading level with the
          button, matching the Recent activity card); the description sits on
          its own line below. */}
      <CardHeader>
        <div className="flex flex-row items-center justify-between gap-3">
          <h2 className="font-heading text-base font-medium leading-snug">{t('summary.heading')}</h2>
          {rows.length > 0 ? (
            <Link
              href="/portal/invoices"
              className={buttonVariants({ variant: 'outline' })}
            >
              {t('summary.viewAll')}
            </Link>
          ) : null}
        </div>
        <CardDescription>{t('summary.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {rows.length === 0 ? (
          <p className="text-caption text-muted-foreground">{t('empty')}</p>
        ) : (
          <ul className="divide-y">
            {rows.map((r) => (
              <li
                key={r.invoiceId}
                /* items-start aligns the two columns into a clean 2x2 grid
                   (doc#+badge ↔ total on the top row, date ↔ download on the
                   bottom row) instead of vertically centring the trailing
                   total/button against the 2-line left block. No flex-wrap, so
                   on a narrow phone the right column stacks under nothing — the
                   two columns stay side-by-side down to 320px (the labels are
                   short: doc# + "Invoice"/"Voided invoice"). */
                className="flex items-start justify-between gap-3 py-3 first:pt-0 last:pb-0"
              >
                <div className="flex min-w-0 flex-col gap-1">
                  <Link
                    href={`/portal/invoices/${r.invoiceId}`}
                    className="font-mono text-caption text-muted-foreground underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2 self-start"
                    aria-label={`${t('actions.viewDetail')} ${r.documentNumber?.raw ?? r.invoiceId}`}
                  >
                    {r.documentNumber?.raw ?? '—'}
                  </Link>
                  <div className="flex flex-wrap items-center gap-2">
                    {(() => {
                      const Icon = STATUS_ICON_MAP[statusIconName(r.status)];
                      return (
                        <Badge
                          variant={statusBadgeVariant(r.status)}
                          className="inline-flex items-center gap-1"
                        >
                          <Icon className="size-3.5" aria-hidden="true" />
                          {tStatus(r.status)}
                        </Badge>
                      );
                    })()}
                    {/* whitespace-nowrap so the date wraps as a UNIT below the
                        badge (not mid-date "Apr 27, / 2026") when the row is
                        tight on a narrow phone; flex-wrap on the parent lets it
                        drop to its own line. */}
                    <span className="text-caption text-muted-foreground whitespace-nowrap">
                      {formatDate(r.issueDate, userLocale)}
                    </span>
                  </div>
                </div>
                <div className="flex shrink-0 flex-col items-end gap-1">
                  <span className="tabular-nums text-body font-medium">
                    {formatSatangThb(r.total?.satang ?? null, userLocale)}
                  </span>
                  {r.pdf ? (
                    <PortalInvoiceDownloadButton
                      invoiceId={r.invoiceId}
                      documentNumber={r.documentNumber?.raw ?? r.invoiceId}
                      label={
                        r.status === 'void'
                          ? t('actions.downloadVoided')
                          : t('actions.download')
                      }
                      ariaLabel={t(
                        r.status === 'void'
                          ? 'actions.downloadVoidedAria'
                          : 'actions.downloadInvoiceAria',
                        {
                          number: r.documentNumber?.raw ?? r.invoiceId,
                        },
                      )}
                      className={cn(
                        buttonVariants({ variant: 'ghost', size: 'sm' }),
                        'min-h-11 px-3',
                      )}
                    />
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
