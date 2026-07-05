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
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import { env } from '@/lib/env';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
  isTenantInvoiceSetupComplete,
  computeIsOverdue,
  displayDocumentNumber,
  resolveTaxDocumentKind,
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
  /**
   * 088 T021b / FR-035 — `?pay=1` payment-intent marker set by the command-
   * palette "Record payment for …" action (alongside `?status=issued`). Drives
   * a guiding hint pointing the admin at the per-row Record payment button;
   * `'1'` = on, any other value (or absent) = off.
   */
  readonly pay?: string;
  /**
   * 088 T065b / FR-031 — three ADMIN-only tax-document filters (ภพ.30 support),
   * honoured ONLY when `FEATURE_088_TAX_AT_PAYMENT` is on:
   *   `?docType=sc|rc|re|cn` · `?taxPoint=pre_payment|at_payment` ·
   *   `?vat=standard|zero_rated_80_1_5`. Any other value (or flag-off) = no
   *   restriction.
   */
  readonly docType?: string;
  readonly taxPoint?: string;
  readonly vat?: string;
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
  const tenantCtx = resolveTenantFromHeaders(hdrs);

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
  // 088 T021b / FR-035 — the command-palette "Record payment for …" action
  // deep-links to ?status=issued&pay=1. The action is generic (no specific
  // invoice), so it can't auto-open a row's dialog; instead we surface a hint
  // that lands the admin on the payable list + points at the per-row button.
  const payIntent = query.pay === '1';
  // 054-event-fee-invoices — subject filter. Only the two known subjects
  // are honoured; any other value falls through to "all".
  const subjectFilter =
    query.subject === 'membership' || query.subject === 'event'
      ? query.subject
      : undefined;
  // 088 (T065 / FR-016) — tax-at-payment flag gates the SC-bill ↔ RC-tax-receipt
  // disambiguation (baked per-row below) AND the T065b tax-document filters +
  // register entry. Read once here so the filter params + the InvoiceFilters
  // render + the row mapper all share one value.
  const f088TaxAtPayment = env.features.f088TaxAtPayment;
  // 088 T065b / FR-031 — three tax-document filters, honoured ONLY when the
  // flag is on (flag-off / member portal never thread them). Unknown values
  // fall through to undefined (no restriction).
  const documentTypeFilter =
    f088TaxAtPayment &&
    (query.docType === 'sc' ||
      query.docType === 'rc' ||
      query.docType === 're' ||
      query.docType === 'cn')
      ? query.docType
      : undefined;
  const taxPointFilter =
    f088TaxAtPayment &&
    (query.taxPoint === 'pre_payment' || query.taxPoint === 'at_payment')
      ? query.taxPoint
      : undefined;
  const vatTreatmentFilter =
    f088TaxAtPayment &&
    (query.vat === 'standard' || query.vat === 'zero_rated_80_1_5')
      ? query.vat
      : undefined;
  const hasFilters =
    Boolean(qTrim) ||
    Boolean(statusFilter) ||
    paidOnlineOnly ||
    Boolean(subjectFilter) ||
    Boolean(documentTypeFilter) ||
    Boolean(taxPointFilter) ||
    Boolean(vatTreatmentFilter);

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
    // BUG-015: forward the status for EVERY filter, including 'draft'. The
    // repo needs BOTH includeDrafts:true AND status:'draft' to return
    // drafts-only (it applies eq(status,'draft') AND skips the draft-exclusion
    // guard). Previously 'draft' was excluded here, so the repo got
    // includeDrafts:true with no positive status predicate and the query
    // degenerated to "all invoices for the tenant".
    ...(statusFilter
      ? {
          status: statusFilter as
            | 'draft'
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
    ...(documentTypeFilter ? { documentType: documentTypeFilter } : {}),
    ...(taxPointFilter ? { taxPointState: taxPointFilter } : {}),
    ...(vatTreatmentFilter ? { vatTreatment: vatTreatmentFilter } : {}),
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
  // 088 (T065 / FR-016) — `f088TaxAtPayment` (hoisted to the filter-parse block
  // above) gates the SC-bill ↔ RC-tax-receipt disambiguation, baked into each
  // row's `taxDocumentKind` server-side so the client table renders it without
  // an env read.
  const rows: InvoicesTableRow[] = invoicesResult.ok
    ? invoicesResult.value.rows.map((r) => {
        // 088 (T065 / T065a) — disambiguation is applied only when the flag is
        // on AND the row is a real 088 bill (bill number present). A legacy row
        // (no bill number) stays 'none' and renders exactly as today.
        const taxDocumentKind = resolveTaxDocumentKind(r, f088TaxAtPayment);
        return {
        invoiceId: r.invoiceId,
        // 064 remediation S7 — display number, never '—' on a numbered row:
        // β as-paid no-TIN rows have a NULL invoice document number and carry
        // their printed §105 number in receipt_document_number_raw. The
        // shared helper resolves whichever exists; only true drafts fall
        // back to the em-dash. 088 A-refined (FR-016) — an 088 invoice is
        // ALWAYS identified by its OWN (SC) NON-§87 bill number, consistently
        // for PAID and UNPAID rows (never swapped to the RC on payment). The RC
        // §86/4 tax receipt is surfaced separately in the Receipt No. column.
        documentNumber:
          taxDocumentKind !== 'none'
            ? (r.billDocumentNumberRaw ?? '—')
            : (displayDocumentNumber(r) ?? '—'),
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
        // 064 remediation S7 — the main pdf IS a §105 receipt (β as-paid
        // no-TIN / legacy issued no-TIN event rows): the table flips the
        // main download to the Receipt label + aria.
        mainDownloadIsReceipt: r.pdfDocKind === 'receipt_separate',
        // 088 A-refined (FR-016) — two-document disambiguation. The SC bill
        // number IS the row identity in the Number column (paid AND unpaid); the
        // resolved document kind drives the ใบแจ้งหนี้/Invoice tag + the RC
        // clickable link in the Receipt No. column. Null/'none' unless this is a
        // real 088 bill and the flag is on.
        billDocumentNumberRaw:
          taxDocumentKind !== 'none' ? r.billDocumentNumberRaw : null,
        taxDocumentKind,
        };
      })
    : [];

  const total = invoicesResult.ok ? invoicesResult.value.total : 0;

  return (
    <TableContainer>
      <PageHeader
        title={t('list.title')}
        subtitle={t('list.description')}
        actions={
          isAdmin ? (
            // flex-wrap: three actions (Registers + Export CSV + New Invoice)
            // must wrap on a 320px viewport rather than overflow it
            // (WCAG 1.4.10 reflow — B2 review FINDING 3).
            <div className="flex flex-wrap items-center gap-2">
              {/* 088 T065b (FR-031) — period tax-document registers (§86/4 RC
                  register + §80/1(5) zero-rate sales + §105 RE register) for
                  ภ.พ.30. Admin + flag gated; the register page 404s when the
                  flag is off. */}
              {f088TaxAtPayment ? (
                <Link
                  href="/admin/invoices/registers"
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('registers.entry')}
                </Link>
              ) : null}
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
          {/* 088 T065b — the three tax-document filters render only when the
              tax-at-payment flag is on (flag-off renders today's filter set). */}
          <InvoiceFilters show088Filters={f088TaxAtPayment} />
          {payIntent && isAdmin && rows.length > 0 ? (
            // FR-035 — realise the palette `?pay=1` deep-link: guide the admin
            // to the per-row Record payment button (role=status = polite, this
            // is guidance not an error).
            <div
              role="status"
              className="rounded-md border border-primary/30 bg-primary/5 px-4 py-3 text-sm text-foreground"
              data-testid="record-payment-intent-hint"
            >
              {t('list.recordPaymentIntentHint')}
            </div>
          ) : null}
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
              <InvoicesTable
                rows={rows}
                showMethodColumn={paidOnlineOnly}
                // 088 T021c / FR-035 — per-row Record payment quick action.
                // Admin-only (money mutation); managers are read-only on
                // finance. `todayIso` is the tenant-timezone (Bangkok) today —
                // the SAME value the detail page threads to the dialog so the
                // payment-date clamp never off-by-ones for ~7h/day.
                canRecordPayment={isAdmin}
                todayIso={bangkokLocalDate(nowUtcIso)}
              />
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
