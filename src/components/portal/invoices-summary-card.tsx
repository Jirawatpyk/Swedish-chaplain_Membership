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
} from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { AuraCard, auraButtonClass } from '@/components/shell/aura-markup';
import { cn } from '@/lib/utils';
import {
  formatDate,
  formatSatangThb,
} from '@/app/(member)/portal/invoices/_utils/format';
import { InvoiceStatusBadge } from '@/app/(member)/portal/invoices/_components/invoice-status-badge';
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
        <AuraCard title={t('summary.heading')} description={t('summary.description')} headingLevel={2}>
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('loadFailed')}</p>
        </AuraCard>
      );
    }
    // Not-linked state: surface the same copy the full list uses so
    // members don't get conflicting signals across portal surfaces.
    return (
      <AuraCard title={t('summary.heading')} description={t('summary.description')} headingLevel={2}>
        <div className="flex flex-col gap-3">
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('notLinked')}</p>
          <a href={`mailto:${env.supportEmail}`} className={cn(auraButtonClass({ variant: 'secondary' }), 'self-start')}>
            {t('summary.contactAdmin')}
          </a>
        </div>
      </AuraCard>
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
      <AuraCard title={t('summary.heading')} description={t('summary.description')} headingLevel={2}>
        <p className="text-sm text-[var(--aura-fg-secondary)]">{t('loadFailed')}</p>
      </AuraCard>
    );
  }

  // 090 Bug 3 — one "now" for the whole card so each row's view-model derives a
  // deterministic overdue status (the view-model's purity contract: the CALLER
  // supplies now; the mapper never calls `new Date()`). Mirrors the list page.
  const nowUtcIso = new Date().toISOString();

  return (
    // AURA card (spec 122 US3, `Main` board): heading and description on top,
    // hairline rows, and "view all" as a footer text link, as the board draws
    // it (the benefit usage card beside it does the same).
    <AuraCard
      title={t('summary.heading')}
      description={t('summary.description')}
      headingLevel={2}
      footer={
        rows.length > 0 ? (
          <Link
            href="/portal/invoices"
            className="inline-flex min-h-11 items-center gap-1.5 text-sm font-medium text-[var(--aura-fg-accent)] no-underline hover:text-[var(--aura-fg-primary)] hover:underline"
          >
            {t('summary.viewAll')}
            <ArrowRight aria-hidden="true" size={16} className="aura-icon" />
          </Link>
        ) : undefined
      }
    >
        {rows.length === 0 ? (
          <p className="text-sm text-[var(--aura-fg-secondary)]">{t('empty')}</p>
        ) : (
          <ul className="divide-y divide-[var(--aura-border-default)]">
            {rows.map((r) => {
              // 088 FR-030 — an 088 bill has NULL §87 `documentNumber`; its
              // number lives in `billDocumentNumberRaw` (unpaid/paid) and, once
              // paid, the §86/4 RC in `receiptDocumentNumberRaw`. Bill-first so
              // this widget's "latest invoices" rows never render '—'/UUID.
              const displayNo =
                billFirstDocumentNumber(r) ?? r.receiptDocumentNumberRaw;
              // 090 Bug 3 — derive the download flags from the SHARED
              // single-source-of-truth view-model (same one the detail page +
              // full list consume) so this summary card can never drift on
              // WHICH document(s) a row exposes. Passed 2-arg (tax-at-payment
              // flag defaults false): the flags this card reads —
              // `showInvoice` / `showReceipt` / `isCombinedPaid` / `mainPdfKind`
              // — are all flag-INDEPENDENT (only `taxDocumentKind` /
              // `primaryNumber` depend on the flag, and this card keeps its own
              // bill-first `displayNo` for the visible number). Pre-fix the card
              // only ever rendered the invoice/bill PDF, so a PAID member never
              // saw the §86/4 RC receipt download.
              const vm = toInvoiceRowViewModel(r, nowUtcIso);
              const receiptRef =
                r.receiptDocumentNumberRaw ?? displayNo ?? r.invoiceId;
              return (
              <li
                key={r.invoiceId}
                /* 090 finding #1 — a `flex-col` row: a header row (doc#/badge/
                   date on the left, total on the right) ABOVE a separate
                   full-width `flex-wrap justify-end` download-button row.
                   The pre-fix layout put both download buttons in the trailing
                   `shrink-0` column, which defeated `flex-wrap` and starved the
                   `min-w-0` doc#/date column to ~27px at 320px (overflow/clip).
                   Giving the buttons their OWN full-width row lets flex-wrap
                   actually work — mirrors the full invoice-list card
                   (`portal-invoice-card-list.tsx`). */
                className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0"
              >
                {/* Header row — doc#/badge/date (left, min-w-0) + total (right). */}
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col gap-1">
                    <Link
                      href={`/portal/invoices/${r.invoiceId}`}
                      className="self-start font-mono text-[13px] text-[var(--aura-fg-primary)] underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                      aria-label={`${t('actions.viewDetail')} ${displayNo ?? r.invoiceId}`}
                    >
                      {displayNo ?? '—'}
                    </Link>
                    <div className="flex flex-wrap items-center gap-2">
                      <InvoiceStatusBadge status={r.status} label={tStatus(r.status)} />
                      {/* whitespace-nowrap so the date wraps as a UNIT below the
                          badge (not mid-date "Apr 27, / 2026") when the row is
                          tight on a narrow phone; flex-wrap on the parent lets it
                          drop to its own line. */}
                      <span className="whitespace-nowrap text-[13px] text-[var(--aura-fg-secondary)]">
                        {formatDate(r.issueDate, userLocale)}
                      </span>
                    </div>
                  </div>
                  <span className="shrink-0 tabular-nums text-body font-medium">
                    {formatSatangThb(r.total?.satang ?? null, userLocale)}
                  </span>
                </div>
                {/* Download row — its OWN full-width `flex-wrap` line (finding #1)
                    so both PDFs (invoice/bill + §86/4 receipt) wrap at 320px
                    without starving the header above. `gap-2` (finding #6);
                    `outline` variant matches the full invoice-list card
                    (finding #4 — ghost read as too low-discoverability). */}
                {vm.showInvoice || vm.showReceipt ? (
                  <div className="flex flex-wrap items-center justify-end gap-2">
                    {/* Invoice/bill PDF — hidden in combined-mode paid (the
                        stale pre-payment draft is not a legal doc; the combined
                        receipt is), matching the detail page's `showInvoicePdf`.
                        The mainPdfKind nuance flips the label for as-paid
                        combined/§105 receipt rows. */}
                    {vm.showInvoice ? (
                      <PortalInvoiceDownloadButton
                        invoiceId={r.invoiceId}
                        documentNumber={displayNo ?? r.invoiceId}
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
                        // AURA's default secondary button (44px), one height
                        // for both downloads (spec 122 US3).
                        className={auraButtonClass({ variant: 'secondary' })}
                      />
                    ) : null}
                    {/* 090 Bug 3 — §86/4 RC receipt download, shown once the row
                        is paid + its receipt PDF has rendered (blob present).
                        Combined-mode paid uses the dual-role label + the wrap
                        treatment (finding #3 — the long TH "ใบกำกับภาษี /
                        ใบเสร็จรับเงิน" would otherwise clip); separate-mode the
                        plain "Receipt". Matches the detail page + full list. */}
                    {vm.showReceipt ? (
                      <PortalReceiptDownloadButton
                        invoiceId={r.invoiceId}
                        documentNumber={receiptRef}
                        label={
                          vm.isCombinedPaid
                            ? t('actions.downloadCombined')
                            : t('actions.downloadReceipt')
                        }
                        ariaLabel={t(
                          vm.isCombinedPaid
                            ? 'actions.downloadCombinedAria'
                            : 'actions.downloadReceiptAria',
                          { number: receiptRef },
                        )}
                        // AURA's default secondary button (44px), as the
                        // invoice button beside it.
                        className={cn(
                          auraButtonClass({ variant: 'secondary' }),
                          // finding #3 — the long combined dual-role label wraps
                          // to 2 lines instead of clipping; AURA's button is
                          // at least 44px, so `h-auto` only lets it grow.
                          vm.isCombinedPaid && 'h-auto whitespace-normal text-left',
                        )}
                      />
                    ) : null}
                  </div>
                ) : null}
              </li>
              );
            })}
          </ul>
        )}
    </AuraCard>
  );
}
