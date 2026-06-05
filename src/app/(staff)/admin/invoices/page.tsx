/**
 * T056 / T057 — /admin/invoices list page.
 *
 * Server Component — parses URL filters (q, status, page) + calls
 * `listInvoicesPaged` with offset pagination so we can render a proper
 * numbered `<TablePagination />` (parity with members directory).
 * Default filter excludes drafts (R2-P2); `?status=draft` opts in.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { logger } from '@/lib/logger';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.meta');
  return { title: t('title') };
}
import { PlusIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
  isTenantInvoiceSetupComplete,
  computeIsOverdue,
} from '@/modules/invoicing';
import {
  listSucceededPaymentMethods,
  makeListSucceededPaymentMethodsDeps,
} from '@/modules/payments';
import { directorySearch } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { runListEventNamesByIds } from '@/lib/events-admin-deps';
import { bangkokLocalDate } from '@/lib/fiscal-year';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { InvoicesTable, type InvoicesTableRow } from './_components/invoice-table';
import { InvoiceFilters } from './_components/invoice-filters';
import { CsvExportDialog } from './_components/csv-export-dialog';

const VALID_STATUSES = new Set([
  'draft',
  'issued',
  'paid',
  'overdue',
  'void',
  'credited',
  'partially_credited',
]);

const PAGE_SIZE = 50;

/**
 * 054-event-fee-invoices Task 14 — compose the muted buyer-subtitle line.
 *
 * Event rows: `{event name} · {CE start date}`. The event name comes from
 * the batched `eventNameById` map (resolved via the F6 barrel in the page
 * body); the date is Bangkok-local CE (Buddhist Era is display-only, the
 * list stays CE-consistent with issue/due dates). When the event isn't in
 * the batch (lookup miss / archived → absent from `eventNameById`) we return
 * `null` and the line is hidden — there's no date to show either. The
 * `meta.name ? … : ceDate` branch is a defensive date-only fallback for a
 * resolved-but-empty name, which cannot occur (events.name is NOT NULL) —
 * never a crash, never a bare separator.
 *
 * Membership rows: the localised "Membership {year}" string built from
 * `planYear` (already on the invoice row — no lookup needed). Null when a
 * (legacy) membership row somehow lacks a plan_year.
 *
 * Returns `null` for anything else — the table omits the line entirely.
 */
function buildBuyerSubtitle(
  row: {
    readonly invoiceSubject: 'membership' | 'event';
    readonly eventId: string | null;
    readonly planYear: number | null;
  },
  eventNameById: ReadonlyMap<string, { name: string; startDateIso: string }>,
  t: (key: string, values?: Record<string, string | number>) => string,
): string | null {
  if (row.invoiceSubject === 'event') {
    if (row.eventId === null) return null;
    const meta = eventNameById.get(row.eventId);
    if (meta === undefined) return null;
    const ceDate = bangkokLocalDate(meta.startDateIso);
    // `·` is a literal separator (not i18n); the event name is data.
    return meta.name ? `${meta.name} · ${ceDate}` : ceDate;
  }
  // Membership row.
  if (row.planYear === null) return null;
  return t('list.buyerSubtitle.membership', { year: row.planYear });
}

interface SearchParams {
  readonly q?: string;
  readonly status?: string;
  readonly page?: string;
  /**
   * F5 Phase 5 (T096) — `?paidOnline=1` filter chip toggles invoices
   * settled via card or PromptPay. Any other value (or absent) is OFF.
   */
  readonly paidOnline?: string;
  /**
   * 054-event-fee-invoices — `?subject=membership|event` restricts the
   * list to one invoice subject. Any other value (or absent) = all.
   */
  readonly subject?: string;
}

export default async function AdminInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const t = await getTranslations('admin.invoices');
  const tShared = await getTranslations('shared');
  const query = await searchParams;

  const { user: currentUser } = await requireSession('staff');
  const isAdmin = currentUser.role === 'admin';

  const hdrs = await headers();
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  // R7-B5 — bootstrap guard. When `tenant_invoice_settings` is
  // missing the API refuses to issue (FR-010), so showing a hidden-
  // but-functional list with a "+ New Invoice" button is a UX
  // dead-end. Render a "Configure Invoicing" empty state instead
  // (US4 AS5). The settings page lives at /admin/settings/invoicing
  // (B2 — ships alongside this guard).
  const setupComplete = await isTenantInvoiceSetupComplete(tenantCtx.slug);
  if (!setupComplete) {
    return (
      <TableContainer>
        <PageHeader title={t('list.title')} subtitle={t('list.description')} />
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-muted-foreground">{t('list.setupRequired')}</p>
            {isAdmin && (
              <Link
                href="/admin/settings/invoicing"
                className={buttonVariants({ variant: 'default', className: 'mt-4' })}
              >
                {t('list.actions.configureInvoicing')}
              </Link>
            )}
          </CardContent>
        </Card>
      </TableContainer>
    );
  }

  const qTrim = query.q?.trim();
  const statusFilter =
    query.status && VALID_STATUSES.has(query.status) ? query.status : undefined;
  const includeDrafts = statusFilter === 'draft';
  const paidOnlineOnly = query.paidOnline === '1';
  // 054-event-fee-invoices — subject filter. Only the two known subjects
  // are honoured; any other value falls through to "all".
  const subjectFilter =
    query.subject === 'membership' || query.subject === 'event'
      ? query.subject
      : undefined;
  const hasFilters =
    Boolean(qTrim) || Boolean(statusFilter) || paidOnlineOnly || Boolean(subjectFilter);

  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 10_000) : 1;
  const offset = (page - 1) * PAGE_SIZE;

  // W6 fix — `directorySearch` is only used to resolve member names
  // for DRAFT invoices (which have no memberIdentitySnapshot yet per
  // FR-038). Non-draft rows all carry the frozen snapshot, so the
  // 500-row member scan is wasted work on the default view. We skip
  // it unless drafts could appear in the result set — keeping SC-005
  // (p95 < 500ms @ 5k invoices) achievable on the hot path.
  const invoicesResult = await listInvoicesPaged(makeListInvoicesDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    offset,
    pageSize: PAGE_SIZE,
    includeDrafts,
    ...(statusFilter && statusFilter !== 'draft'
      ? {
          status: statusFilter as
            | 'issued'
            | 'paid'
            | 'void'
            | 'credited'
            | 'partially_credited'
            | 'overdue',
        }
      : {}),
    ...(qTrim ? { search: qTrim } : {}),
    ...(paidOnlineOnly ? { paidOnlineOnly: true } : {}),
    ...(subjectFilter ? { invoiceSubject: subjectFilter } : {}),
  });

  // G-2 — batched CN count per invoice on the current page. Single
  // GROUP BY query keyed by original_invoice_id so we avoid N+1
  // roundtrips while still getting an exact count that matches the
  // running credited_total_satang snapshot on each invoice row.
  // Zero rows on 99% of invoices (only paid/partially_credited/
  // credited have CNs) — the map lookup falls back to 0 / '0' so
  // the table row shape stays consistent.
  const creditNoteCountById = new Map<string, number>();
  if (invoicesResult.ok && invoicesResult.value.rows.length > 0) {
    const { runInTenant } = await import('@/lib/db');
    const { creditNotes } = await import(
      '@/modules/invoicing/infrastructure/db'
    );
    const { inArray, eq, and, sql } = await import('drizzle-orm');
    const invoiceIds = invoicesResult.value.rows.map((r) => r.invoiceId);
    try {
      const counts = await runInTenant(tenantCtx, (tx) =>
        tx
          .select({
            originalInvoiceId: creditNotes.originalInvoiceId,
            count: sql<number>`COUNT(*)::int`,
          })
          .from(creditNotes)
          .where(
            and(
              eq(creditNotes.tenantId, tenantCtx.slug),
              inArray(creditNotes.originalInvoiceId, invoiceIds),
            ),
          )
          .groupBy(creditNotes.originalInvoiceId),
      );
      for (const c of counts) {
        creditNoteCountById.set(c.originalInvoiceId, Number(c.count));
      }
    } catch (err) {
      // Best-effort: count failures never 500 the list page. Missing
      // map entries fall back to 0 in the row mapper below.
      // R8-L1-sf — log so a systemic CN-count failure is observable
      // instead of silently degrading to 0 on every row across many
      // tenants.
      logger.warn(
        { tenantId: tenantCtx.slug, invoiceCount: invoiceIds.length, err },
        '[admin-invoices-list] credit-note count GROUP BY failed — rows will show 0 CN chip',
      );
    }
  }

  // F5 Phase 5 (T096) — succeeded online payment method per invoice on
  // the current page. Single batched query keyed by invoice_id; absent
  // entries fall back to `null` in the row mapper, which renders as a
  // long-dash on the Method column. Only fetched when the Method
  // column will actually render (`paidOnlineOnly` is the trigger);
  // saves a roundtrip on the default view.
  const onlineMethodById = new Map<string, 'card' | 'promptpay'>();
  if (
    paidOnlineOnly &&
    invoicesResult.ok &&
    invoicesResult.value.rows.length > 0
  ) {
    const methodResult = await listSucceededPaymentMethods(
      makeListSucceededPaymentMethodsDeps(tenantCtx.slug),
      {
        tenantId: tenantCtx.slug,
        invoiceIds: invoicesResult.value.rows.map((r) => r.invoiceId),
      },
    );
    if (methodResult.ok) {
      for (const [invoiceId, method] of methodResult.value) {
        onlineMethodById.set(invoiceId, method);
      }
    }
  }

  const memberNameById = new Map<string, string>();
  // Only run the member directory scan when the result set may include
  // drafts (tabs/filters that enable them) OR when any returned row is
  // missing a snapshot (defence-in-depth for legacy rows).
  const needsMemberDirectory =
    includeDrafts ||
    (invoicesResult.ok &&
      invoicesResult.value.rows.some((r) => !r.memberIdentitySnapshot));
  if (needsMemberDirectory) {
    const membersResult = await directorySearch(
      { tenant: tenantCtx, memberRepo: buildMembersDeps(tenantCtx).memberRepo },
      // Ceiling 500 — snapshot fallback only (detail + list use the
      // frozen memberIdentitySnapshot first per FR-038, this map is a
      // belt-and-suspenders fallback for pre-issue drafts on tenants
      // within the 500-member window). See F4 Phase 10 smart feature
      // #2 for server-paged search at scale.
      { status: ['active', 'inactive', 'archived'], limit: 500 },
    );
    if (membersResult.ok) {
      for (const row of membersResult.value.items) {
        memberNameById.set(row.member.memberId, row.member.companyName);
      }
    }
  }

  // 054-event-fee-invoices Task 14 — buyer-subtitle event names.
  // Collect the DISTINCT event ids from the event rows on THIS page, then
  // resolve their names + start dates in ONE batched query via the F6
  // public barrel (Principle III — the cross-context read goes through the
  // lib composition layer, never a JOIN inside F4 listPaged). The lookup is
  // skipped entirely when the page has no event rows (the default all-
  // membership view), so the common path pays zero extra DB cost.
  const eventNameById = new Map<string, { name: string; startDateIso: string }>();
  if (invoicesResult.ok) {
    const eventIds = new Set<string>();
    for (const r of invoicesResult.value.rows) {
      if (r.invoiceSubject === 'event' && r.eventId !== null) {
        eventIds.add(r.eventId);
      }
    }
    if (eventIds.size > 0) {
      const resolved = await runListEventNamesByIds(tenantCtx.slug, [...eventIds]);
      for (const [id, meta] of resolved) {
        eventNameById.set(id, meta);
      }
    }
  }

  // Prefer the frozen snapshot on issued/paid/void invoices (FR-038) —
  // it's the legal source of truth and always present. Fall back to the
  // live directory map only for drafts (no snapshot yet). Ultimate
  // fallback to a placeholder if directorySearch's 100-row window
  // didn't include the member (rare — tenant with >100 active members
  // AND an old draft).
  // T109 — derive presentation-only `overdue` status per FR-028.
  // `status` stays the stored value for non-derived consumers; the
  // `overdue` variant is injected ONLY when the read-time rule
  // (issued + Bangkok-today > dueDate) fires, so recording payment
  // or voiding immediately returns the row to its stored status on
  // the next fetch.
  // R8-H1-SF — was: `invoicesResult.ok ? ... : []` silent fallback.
  // Empty rows fallback is indistinguishable from "tenant has no
  // invoices" — admins saw the empty-state copy on backend failures
  // (DB outage, RLS drift, repo bug) instead of an explicit error
  // signal. Mirror the R7-M3 portal fix: log + render the standard
  // empty-state with a logger.warn diagnostic so operators see the
  // failure in pino structured logs.
  if (!invoicesResult.ok) {
    logger.warn(
      { tenantId: tenantCtx.slug, err: invoicesResult.error },
      '[admin-invoices-list] listInvoicesPaged failed — rendering empty list with diagnostic',
    );
  }
  const nowUtcIso = new Date().toISOString();
  const rows: InvoicesTableRow[] = invoicesResult.ok
    ? invoicesResult.value.rows.map((r) => ({
        invoiceId: r.invoiceId,
        documentNumber: r.documentNumber?.raw ?? '—',
        status: computeIsOverdue(r, nowUtcIso) ? 'overdue' : r.status,
        // 054-event-fee-invoices — subject discriminator drives the Event
        // chip; the buyer column renders membership + event invoices alike.
        invoiceSubject: r.invoiceSubject,
        // The buyer name links to the F3 member ONLY when one exists:
        // membership invoices always carry a `member_id`
        // (`invoices_subject_fields_ck`), and a matched-member event invoice
        // does too. A non-member event attendee has `member_id IS NULL` — its
        // name renders as plain text (no broken `/admin/members/` link).
        buyerHasMemberLink: r.memberId !== null,
        // `memberId` is the link target; empty string when there is no member
        // (event non-member) — the table never dereferences it in that case.
        memberId: r.memberId ?? '',
        // Buyer display name: the frozen identity snapshot (legal_name —
        // present on issued/paid rows + non-member event drafts), else the
        // live member-directory company name (drafts), else a placeholder.
        memberName:
          r.memberIdentitySnapshot?.legal_name ??
          (r.memberId !== null ? memberNameById.get(r.memberId) : undefined) ??
          '—',
        // 054-event-fee-invoices Task 14 — muted buyer subtitle. Event rows
        // show the event name + Bangkok-local CE start date (BE is display-
        // only; the list stays CE-consistent). When the event isn't resolved
        // (lookup miss / archived → absent from the batch) the subtitle is
        // null (line hidden). Membership rows show the localised "Membership {year}"
        // from `planYear` (already on the invoice row — no lookup needed).
        buyerSubtitle: buildBuyerSubtitle(r, eventNameById, t),
        issueDate: r.issueDate,
        dueDate: r.dueDate,
        totalSatang: r.total?.satang.toString() ?? '0',
        hasPdf: r.pdf !== null,
        // G-2 — indicator pair. `creditedTotal` is already on the
        // Invoice entity (frozen + rolled up by applyCreditNoteRollup);
        // `creditNoteCount` comes from the batched GROUP BY above.
        creditNoteCount: creditNoteCountById.get(r.invoiceId) ?? 0,
        creditedTotalSatang: r.creditedTotal.satang.toString(),
        onlinePaymentMethod: onlineMethodById.get(r.invoiceId) ?? null,
        // Receipt No. column — null on non-paid + paid-combined-mode.
        // Paid-separate-mode rows carry the §87 RC sequence number.
        receiptDocumentNumberRaw: r.receiptDocumentNumberRaw ?? null,
        // Receipt PDF availability for the Actions cell download link
        // — paid + worker has rendered the receipt-stamped bytes.
        hasReceiptPdf: r.status === 'paid' && r.receiptPdf !== null,
        // R8-H2-UX — receipt PDF render status so the table can show
        // a "preparing…" affordance for paid + pending/null/failed
        // (mirrors portal list page receipt-pending pattern).
        receiptPdfStatus: r.receiptPdfStatus,
      }))
    : [];

  const total = invoicesResult.ok ? invoicesResult.value.total : 0;

  return (
    <TableContainer>
      <PageHeader
        title={t('list.title')}
        subtitle={t('list.description')}
        actions={
          isAdmin ? (
            <div className="flex items-center gap-2">
              <CsvExportDialog />
              <Link
                href="/admin/invoices/new"
                className={buttonVariants({ variant: 'default' })}
              >
                <PlusIcon className="size-4" />
                {t('list.actions.new')}
              </Link>
            </div>
          ) : null
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <InvoiceFilters />
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">
                {hasFilters ? t('list.filteredEmpty') : t('list.empty')}
              </p>
              {hasFilters && (
                // Filtered-empty state — provide an explicit escape
                // hatch back to the unfiltered list. The filter bar
                // above has its own clear button, but on long tables
                // it may have scrolled off the viewport by the time
                // the user reaches the empty state (UX-M1).
                <Link
                  href="/admin/invoices"
                  className={buttonVariants({ variant: 'outline', className: 'mt-4' })}
                >
                  {t('list.actions.clearFilters')}
                </Link>
              )}
              {!hasFilters && isAdmin && (
                <Link
                  href="/admin/invoices/new"
                  className={buttonVariants({ variant: 'default', className: 'mt-4' })}
                >
                  {t('list.actions.new')}
                </Link>
              )}
            </div>
          ) : (
            <>
              <InvoicesTable rows={rows} showMethodColumn={paidOnlineOnly} />
              <TablePagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                baseHref="/admin/invoices"
              />
            </>
          )}
        </CardContent>
      </Card>
      <span className="sr-only">{tShared('loaded')}</span>
    </TableContainer>
  );
}
