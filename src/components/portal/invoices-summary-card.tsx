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
import { ArrowRight } from 'lucide-react';
import { getTranslations, getLocale } from 'next-intl/server';
import type { UserAccount } from '@/modules/auth';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import { logger } from '@/lib/logger';
import { errKind, hashId, rootCause } from '@/lib/log-id';
import {
  billFirstDocumentNumber,
  listInvoicesPaged,
  makeListInvoicesDeps,
  type Invoice,
} from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { Card, StatusPill, buttonClass } from '@jirawatpyk/aura-react/server';
import { cn } from '@/lib/utils';
import {
  formatDate,
  formatSatangThb,
  invoiceStatusTone,
} from '@/app/(member)/portal/invoices/_utils/format';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from '@/app/(member)/portal/invoices/_components/portal-pdf-download-button';
import {
  toInvoiceRowViewModel,
  downloadLabelKeys,
} from '@/app/(member)/portal/invoices/_utils/invoice-row-view-model';

const SUMMARY_LIMIT = 3;

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
    // 060-member-portal-d4 (I5) — `findByLinkedUserId` returns TWO distinct
    // errors: `repo.not_found` (no contact links this session user — genuine,
    // expected) and `repo.unexpected` (a DB/RLS error THREW, wrapped by the
    // repo). Previously both collapsed to the "not linked" card with no log, so
    // a transient DB failure told a legitimately-linked member their account
    // wasn't linked (wrong + unactionable) and gave operators zero signal.
    // Discriminate on the code: anything other than `repo.not_found` is a real
    // failure → log the CLASS (errKind) + a hashed user id (never the raw id —
    // CLAUDE.md § Secrets) and render the loadFailed variant.
    if (memberResult.error.code !== 'repo.not_found') {
      logger.warn(
        {
          tenantId: tenantCtx.slug,
          userIdHash: hashId(user.id),
          errKind: errKind(rootCause(memberResult.error)),
        },
        '[portal-invoices-summary] member lookup failed — rendering error variant',
      );
      return (
        <Card title={t('summary.heading')} description={t('summary.description')} headingLevel={2}>
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('loadFailed')}</p>
        </Card>
      );
    }
    // Not-linked state: surface the same copy the full list uses so
    // members don't get conflicting signals across portal surfaces.
    return (
      <Card title={t('summary.heading')} description={t('summary.description')} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('notLinked')}</p>
          <a href={`mailto:${env.supportEmail}`} className={cn(buttonClass({ variant: 'secondary' }), 'self-start')}>
            {t('summary.contactAdmin')}
          </a>
        </div>
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
    // If `listInvoicesPaged` ever gains a real Err variant, branch on
    // `invoicesResult.error` here instead of re-throwing — re-throwing would
    // log it as a generic `Error` kind, losing the structured error.code.
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
      <Card title={t('summary.heading')} description={t('summary.description')} headingLevel={2}>
        <p className="text-sm text-[var(--aura-fg-secondary)]">{t('loadFailed')}</p>
      </Card>
    );
  }

  // 090 Bug 3 — one "now" for the whole card so each row's view-model derives a
  // deterministic overdue status (the view-model's purity contract: the CALLER
  // supplies now; the mapper never calls `new Date()`). Mirrors the list page.
  const nowUtcIso = new Date().toISOString();

  return <InvoicesSummaryView rows={rows} nowUtcIso={nowUtcIso} t={t} tStatus={tStatus} userLocale={userLocale} />;
}

type PortalInvoicesT = Awaited<ReturnType<typeof getTranslations<'portal.invoices'>>>;
type InvoiceStatusT = Awaited<ReturnType<typeof getTranslations<'admin.invoices.list.statuses'>>>;

/**
 * The card's rows, apart from the reads so the preview route can render them
 * with fixture invoices (spec 122 US3 board comparison).
 */
export function InvoicesSummaryView({
  rows,
  nowUtcIso,
  t,
  tStatus,
  userLocale,
}: {
  readonly rows: readonly Invoice[];
  readonly nowUtcIso: string;
  readonly t: PortalInvoicesT;
  readonly tStatus: InvoiceStatusT;
  readonly userLocale: string;
}) {

  return (
    // AURA card (spec 122 US3, `Main` board): heading and description on top,
    // a hairline above every row, and "View all invoices" as the last row of
    // the body (left-aligned), as the board draws it.
    <Card title={t('summary.heading')} description={t('summary.description')} headingLevel={2}>
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('empty')}</p>
        ) : (
          <>
          <ul>
            {rows.map((r) => {
              // 088 FR-030 — an 088 bill has NULL §87 `documentNumber`; its
              // number lives in `billDocumentNumberRaw` (unpaid/paid) and, once
              // paid, the §86/4 RC in `receiptDocumentNumberRaw`. Bill-first so
              // this widget's "latest invoices" rows never render '—'/UUID.
              const displayNo =
                billFirstDocumentNumber(r) ?? r.receiptDocumentNumberRaw;
              // 090 Bug 3 — the download flags come from the SHARED view-model
              // (same one the detail page + full list consume), so this card
              // can never drift on WHICH document(s) a row exposes (the
              // invoice/bill PDF, and the §86/4 RC receipt once paid).
              const vm = toInvoiceRowViewModel(r, nowUtcIso);
              const receiptRef =
                r.receiptDocumentNumberRaw ?? displayNo ?? r.invoiceId;
              const issued = t('summary.issuedOn', { date: formatDate(r.issueDate, userLocale) });
              const due = r.dueDate ? t('summary.dueOn', { date: formatDate(r.dueDate, userLocale) }) : null;
              const unpaid = r.status === 'issued';
              // Desktop: "Issued … · Due …" (unpaid) or "Issued … · Receipt RC-…"
              // (paid). Phone: the one date that matters — Due while unpaid.
              const metaWide =
                unpaid && due
                  ? `${issued} · ${due}`
                  : r.receiptDocumentNumberRaw
                    ? `${issued} · ${t('summary.receiptRef', { number: r.receiptDocumentNumberRaw })}`
                    : issued;
              const metaNarrow = unpaid && due ? due : issued;
              const pill = <StatusPill tone={invoiceStatusTone(r.status)}>{tStatus(r.status)}</StatusPill>;
              const amount = formatSatangThb(r.total?.satang ?? null, userLocale);
              return (
              <li
                key={r.invoiceId}
                className="flex items-center gap-3 border-t border-[var(--aura-border-default)] py-3 sm:gap-4"
              >
                <div className="flex min-w-0 flex-1 items-center gap-4">
                  <div className="flex min-w-0 flex-1 flex-col gap-1">
                    <div className="flex items-baseline justify-between gap-3">
                      <Link
                        href={`/portal/invoices/${r.invoiceId}`}
                        className="min-w-0 truncate font-mono text-xs text-[var(--aura-fg-primary)] no-underline hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
                        aria-label={`${t('actions.viewDetail')} ${displayNo ?? r.invoiceId}`}
                      >
                        {displayNo ?? '—'}
                      </Link>
                      <span className="shrink-0 font-semibold tabular-nums sm:hidden">{amount}</span>
                    </div>
                    <div className="flex items-center justify-between gap-3 text-xs text-[var(--aura-fg-secondary)]">
                      <span className="min-w-0 max-sm:hidden">{metaWide}</span>
                      <span className="min-w-0 sm:hidden">{metaNarrow}</span>
                      <span className="shrink-0 sm:hidden">{pill}</span>
                    </div>
                  </div>
                  <span className="shrink-0 max-sm:hidden">{pill}</span>
                  <span className="w-[120px] shrink-0 text-right font-semibold tabular-nums max-sm:hidden">{amount}</span>
                </div>
                {vm.showInvoice || vm.showReceipt ? (
                  <div className="flex shrink-0 items-center gap-1">
                    {/* Invoice/bill PDF, whenever the row has one — matching the
                        detail page's `showInvoicePdf`. Icon buttons, as the board draws them; the name is the
                        full "Download … PDF for {number}". */}
                    {vm.showInvoice ? (
                      <PortalInvoiceDownloadButton
                        invoiceId={r.invoiceId}
                        documentNumber={displayNo ?? r.invoiceId}
                        iconOnly
                        label={
                          r.status === 'void'
                            ? t('actions.downloadVoided')
                            : t(downloadLabelKeys(vm.mainPdfKind).labelKey)
                        }
                        ariaLabel={t(
                          r.status === 'void'
                            ? 'actions.downloadVoidedAria'
                            : downloadLabelKeys(vm.mainPdfKind).ariaKey,
                          {
                            number: displayNo ?? r.invoiceId,
                          },
                        )}
                        className="aura-icon-btn"
                      />
                    ) : null}
                    {/* 090 Bug 3 — §86/4 RC receipt download, once the row is
                        paid and its receipt PDF has rendered. A separate-mode
                        paid row keeps both buttons (FR-011). */}
                    {vm.showReceipt ? (
                      <PortalReceiptDownloadButton
                        invoiceId={r.invoiceId}
                        documentNumber={receiptRef}
                        iconOnly
                        label={t('actions.downloadReceipt')}
                        ariaLabel={t('actions.downloadReceiptAria', { number: receiptRef })}
                        className="aura-icon-btn"
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
          <div className="border-t border-[var(--aura-border-default)] pt-3">
            <Link
              href="/portal/invoices"
              className="inline-flex min-h-11 items-center gap-1.5 text-[13px] font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline sm:min-h-0"
            >
              {t('summary.viewAll')}
              <ArrowRight aria-hidden="true" size={16} className="aura-icon" />
            </Link>
          </div>
          </>
        )}
    </Card>
  );
}
