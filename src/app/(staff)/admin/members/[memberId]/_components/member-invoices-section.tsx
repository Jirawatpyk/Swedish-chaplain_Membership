/**
 * Member detail page "Invoices" section — US7 AS1, AS3.
 *
 * Server Component reading through `listInvoicesByMember` with the
 * same tenant-scoped deps as the sibling `getMember` fetch on the
 * parent page.
 *
 * Why direct use-case call (not `fetch('/api/members/<id>/invoices')`):
 *   This renders on the same request as the parent page. An internal
 *   HTTP hop would double the DB round-trips and serialise/parse the
 *   payload twice for zero functional gain. Sibling convention: see
 *   `page.tsx` calling `getMember` directly. The REST route remains
 *   the source of truth for programmatic clients (contract tests,
 *   future client-side sort/filter).
 *
 * RBAC (`canMutate = canPerform(role, 'invoicing.write')`):
 *   - `admin` / promoted `super_admin` — list + all quick actions (view,
 *     record payment, issue CN), plus the "New invoice" create affordances.
 *   - `manager` — list only. Per-row mutating actions (record payment / void /
 *     issue CN) render DISABLED with a role-constraint tooltip
 *     (`ManagerDisabledAction`). The "New invoice" create affordances (the
 *     header CTA and the empty-state CTA) are HIDDEN rather than disabled —
 *     a create flow has no existing row to anchor a per-action tooltip on.
 *   - `member`  — never reaches this surface (admin route).
 */
import Link from 'next/link';
import { getTranslations, getLocale } from 'next-intl/server';
import { canPerform } from '@/lib/rbac';
import type { Role } from '@/modules/auth/domain/role';
import { PlusIcon } from 'lucide-react';
import {
  listInvoicesByMember,
  makeListInvoicesByMemberDeps,
  type Invoice,
} from '@/modules/invoicing';
import type { TenantContext } from '@/modules/tenants';
import { Card, EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';
import { MemberInvoicesFilters } from './member-invoices-filters';
import { MemberInvoicesTable, type MemberInvoiceRow } from './member-invoices-table';
import { resolveMemberInvoiceDisplayNumber } from './resolve-invoice-display-number';
import { formatDatePreset } from '@/lib/format-date-localised';
import { formatSatangThb } from '@/lib/format-thb';

interface MemberInvoicesSectionProps {
  readonly tenant: TenantContext;
  readonly memberId: string;
  // 016 re-review D — widened to the full Role union: the parent page now
  // admits via canPerform (not a role-pair literal), so no narrowing reaches
  // this prop; `canMutate` below derives everything role-specific.
  readonly role: Role;
  /**
   * G-U7F — status filter from URL (`?invStatus=paid`). `undefined`
   * means "all". Legal values narrowed at the page layer before
   * passing in, so any non-matching string falls back to `all`.
   */
  readonly statusFilter?: string | undefined;
  /** G-U7F — fiscal-year filter from URL (`?invYear=2026`). */
  readonly fiscalYearFilter?: number | undefined;
  /** G-U7F — document-number substring search from URL (`?invQ=`). */
  readonly searchFilter?: string | undefined;
}

/** Difference between invoice total and credited total = amount owing. */
function remainingSatang(inv: Invoice): bigint | null {
  if (!inv.total) return null;
  return inv.total.satang - inv.creditedTotal.satang;
}

export async function MemberInvoicesSection({
  tenant,
  memberId,
  role,
  statusFilter,
  fiscalYearFilter,
  searchFilter,
}: MemberInvoicesSectionProps): Promise<React.ReactElement> {
  const t = await getTranslations('admin.members.invoices');
  const locale = await getLocale();

  // G-U7F — fetch the unfiltered count once so we know whether to
  // show the filter bar at all (member with zero invoices gets the
  // empty-CTA without filter noise). Year derivation was moved to
  // the filter component (now a free-text number input; no dropdown
  // options needed).
  const allYearsResult = await listInvoicesByMember(
    makeListInvoicesByMemberDeps(tenant.slug),
    { tenantId: tenant.slug, memberId, pageSize: 1, offset: 0, status: 'all' },
  );

  const VALID_STATUSES = new Set([
    'draft',
    'issued',
    'paid',
    'void',
    'credited',
    'partially_credited',
  ]);
  const narrowedStatus =
    statusFilter && VALID_STATUSES.has(statusFilter)
      ? (statusFilter as
          | 'draft'
          | 'issued'
          | 'paid'
          | 'void'
          | 'credited'
          | 'partially_credited')
      : 'all';

  const result = await listInvoicesByMember(
    makeListInvoicesByMemberDeps(tenant.slug),
    {
      tenantId: tenant.slug,
      memberId,
      pageSize: 100,
      offset: 0,
      status: narrowedStatus,
      ...(fiscalYearFilter !== undefined ? { fiscalYear: fiscalYearFilter } : {}),
      ...(searchFilter ? { search: searchFilter } : {}),
    },
  );

  // Surface repo failures to the parent error boundary instead of
  // silently rendering an empty state — an admin on a renewal call
  // needs to distinguish "no invoices" from "DB failed".
  if (!result.ok) {
    throw new Error(
      `MemberInvoicesSection: listInvoicesByMember failed (${String(result.error.cause)})`,
    );
  }

  const rows = result.value.rows;
  const total = result.value.total;
  // 016 re-review D — evaluator-derived ('invoicing.write'; OFF leg
  // legacyAdminOnly reproduces the admin-only mutations and admits a promoted
  // super_admin — this was the one staff-role literal living in _components/,
  // outside the first version of the page gate's scan radius).
  const canMutate = canPerform(role, 'invoicing.write');

  // The board's form ("38,520.00 THB"), the same as the figures strip above.
  const formatBaht = (satang: bigint | null): string =>
    satang === null ? '—' : formatSatangThb(satang, locale);

  const formatDate = (iso: string | null): string =>
    iso === null ? '—' : formatDatePreset(iso, locale, 'dateMedium2Digit');

  const hasFilter = statusFilter !== undefined || fiscalYearFilter !== undefined || searchFilter !== undefined;
  // 088 FR-030 — bill-first: an issued (or paid) 088 bill carries its SC
  // number in `billDocumentNumberRaw` with the §87 `documentNumber` NULL;
  // `null` (a true draft) falls back to the placeholder.
  const tableRows: MemberInvoiceRow[] = rows.map((inv) => {
    const remaining = remainingSatang(inv);
    return {
      invoiceId: inv.invoiceId,
      number: resolveMemberInvoiceDisplayNumber(inv) ?? t('draftPlaceholder'),
      status: inv.status,
      statusLabel: t(`statuses.${inv.status}`),
      issued: formatDate(inv.issueDate),
      due: formatDate(inv.dueDate),
      paid: inv.paidAt ? formatDate(inv.paidAt) : null,
      total: formatBaht(inv.total?.satang ?? null),
      remaining: formatBaht(remaining),
      owing: remaining !== null && remaining > 0n && inv.status !== 'paid',
    };
  });
  return (
    <MemberInvoicesCard
      memberId={memberId}
      total={total}
      rows={tableRows}
      canMutate={canMutate}
      hasFilter={hasFilter}
      showFilters={allYearsResult.ok && allYearsResult.value.total > 0}
    />
  );
}

/**
 * The invoices card once its rows are loaded and formatted — split out so the
 * no-DB preview route renders the same markup (spec 122 US5b-1).
 */
export async function MemberInvoicesCard({
  memberId,
  total,
  rows: tableRows,
  canMutate,
  hasFilter,
  showFilters,
}: {
  readonly memberId: string;
  readonly total: number;
  readonly rows: readonly MemberInvoiceRow[];
  readonly canMutate: boolean;
  readonly hasFilter: boolean;
  /** G-U7F — only when the member has any invoice at all. */
  readonly showFilters: boolean;
}): Promise<React.ReactElement> {
  const t = await getTranslations('admin.members.invoices');
  const newInvoiceHref = `/admin/invoices/new?memberId=${encodeURIComponent(memberId)}`;

  // Spec 122 US5b-1 — an AURA Card as the `Admin-member-detail` board draws
  // it: the title with the count and "New invoice", the filters, then the
  // table (cards on a phone) or an empty state.
  return (
    <Card
      as="section"
      title={t('title')}
      titleId="member-invoices-heading"
      headingLevel={2}
      actions={
        // The count beside the heading, not in it. "New invoice" shows
        // whenever the member already has invoices; the empty state carries
        // its own, so the page never shows two. Admin only — managers are
        // read-only on finance (Principle V).
        <span className="flex items-center gap-3">
          <span className="text-xs text-[var(--aura-fg-secondary)]">{t('count', { count: total })}</span>
          {canMutate && total > 0 ? (
            <Link href={newInvoiceHref} className={buttonClass({ size: 'sm' })}>
              <PlusIcon className="size-4" aria-hidden="true" />
              {t('newInvoice')}
            </Link>
          ) : null}
        </span>
      }
    >
      <div data-testid="member-invoices-content">
        {/* G-U7F — only when the unfiltered set is non-empty: with ZERO
            invoices there is nothing to filter. */}
        {showFilters && <MemberInvoicesFilters />}
        {tableRows.length === 0 ? (
          <EmptyState
            size="sm"
            title={hasFilter ? t('emptyFiltered') : t('empty')}
            action={
              !hasFilter && canMutate ? (
                <Link href={newInvoiceHref} className={buttonClass({ variant: 'secondary', size: 'sm' })}>
                  {t('emptyCta')}
                </Link>
              ) : undefined
            }
          />
        ) : (
          <MemberInvoicesTable
            rows={tableRows}
            canMutate={canMutate}
            labels={{
              caption: t('title'),
              number: t('cols.number'),
              status: t('cols.status'),
              issued: t('cols.issued'),
              due: t('cols.due'),
              paid: t('cols.paid'),
              total: t('cols.total'),
              remaining: t('cols.remaining'),
              notPaid: t('cols.paidEmpty'),
              actionsFor: t('actions.menuFor', { number: '{number}' }),
              view: t('actions.view'),
              recordPayment: t('actions.recordPayment'),
              issueCreditNote: t('actions.issueCreditNote'),
              void: t('actions.void'),
              disabledForManager: t('actions.disabledForManager'),
            }}
          />
        )}
      </div>
    </Card>
  );
}
