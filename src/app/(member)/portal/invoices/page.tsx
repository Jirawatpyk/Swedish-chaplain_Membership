/**
 * R7-B3 — /portal/invoices (F4 US3).
 *
 * Member self-service view of their company's invoices. Scoped via
 * `requireSession('member')` + member lookup by linked user id; the
 * `listInvoicesPaged` call passes `memberId` so RLS + application
 * filters together never leak a sibling company's documents.
 *
 * US3 AS1 — member with 3 invoices sees 3 rows (status, amount,
 * issue/due/paid dates, download button).
 * US3 AS2 — cross-tenant URL attempt → RLS hides the invoice; 404
 * with probe audit emitted by `getInvoicePdfSignedUrl` on download.
 * US3 AS3 — member with 0 invoices → friendly empty state.
 *
 * PDF download goes through `/api/portal/invoices/[id]/pdf` (byte-
 * streamed, never exposes Blob URL — same B1 pattern as admin).
 */
import type { Metadata } from 'next';
import { getTranslations, getLocale } from 'next-intl/server';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { logger } from '@/lib/logger';
import { errKind, hashId, rootCause } from '@/lib/log-id';
import {
  listInvoicesPaged,
  makeListInvoicesDeps,
  type ListInvoicesPagedOutput,
} from '@/modules/invoicing';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { TablePagination } from '@/components/layout/table-pagination';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { cn } from '@/lib/utils';
import Link from 'next/link';
import { formatDate, formatSatangThb } from './_utils/format';
import { InvoiceStatusBadge } from './_components/invoice-status-badge';
import {
  toInvoiceRowViewModel,
  rowHasAnyAction,
} from './_utils/invoice-row-view-model';
import {
  InvoiceFilters,
  type InvoiceStatusFilterValue,
} from '@/app/(staff)/admin/invoices/_components/invoice-filters';
import { ResendInvoiceButton } from './_components/resend-invoice-button';
import {
  PortalInvoiceDownloadButton,
  PortalReceiptDownloadButton,
} from './_components/portal-pdf-download-button';
import { CombinedReceiptHint } from './_components/combined-receipt-hint';
import { EmptyCell } from './_components/empty-cell';
import { PortalInvoiceCardList } from './_components/portal-invoice-card-list';

const PAGE_SIZE = 20;

interface SearchParams {
  readonly page?: string;
  readonly q?: string;
  readonly status?: string;
  // 054-event-fee-invoices — subject (membership/event) filter. The shared
  // InvoiceFilters control writes ?subject= to the URL; the portal page reads
  // + threads it (members can have both membership and event invoices).
  //
  // 060-member-portal-d4 — the `?paidOnline=` param is intentionally NOT read
  // here. It is an admin reconciliation filter (succeeded card/PromptPay
  // payment); a member who paid OFFLINE (bank transfer/cash) would see their
  // legitimate invoices vanish. The portal hides the chip (showPaidOnlineChip
  // ={false}) so it is unreachable from the UI; dropping the parse closes the
  // remaining hand-typed-URL hole (`?paidOnline=1` is now inert on the portal).
  readonly subject?: string;
}

// The non-`all` status values the portal exposes — the SINGLE source for the
// `StatusFilter` union, the `parseStatusFilter` accept-set, and the
// `statusOptions` passed to <InvoiceFilters>, so the three can never diverge.
// `satisfies readonly InvoiceStatusFilterValue[]` ties the list to the shared
// filter vocabulary (a typo / a value the control can't render is a compile
// error). `'draft'` is intentionally excluded — members never see drafts.
//
// 'overdue' is a DERIVED filter (issued + Bangkok-today past dueDate), not a
// stored status. `listInvoicesPaged` accepts it and the repo translates it to
// `status='issued' AND dueDate < today`. It MUST be honoured here — demoting it
// to 'all' (the previous behaviour) silently returned EVERY non-draft invoice
// when a member selected Overdue, never reaching the repo's overdue branch.
const PORTAL_STATUS_OPTIONS = [
  'issued',
  'paid',
  'overdue',
  'void',
  'credited',
  'partially_credited',
] as const satisfies readonly InvoiceStatusFilterValue[];

export type StatusFilter = (typeof PORTAL_STATUS_OPTIONS)[number] | 'all';

export function parseStatusFilter(raw: string | undefined): StatusFilter {
  return (PORTAL_STATUS_OPTIONS as readonly string[]).includes(raw ?? '')
    ? (raw as StatusFilter)
    : 'all';
}

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('portal.invoices');
  return { title: t('title') };
}

export default async function PortalInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const { user } = await requireSession('member');
  const t = await getTranslations('portal.invoices');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const userLocale = await getLocale();

  const tenantCtx = resolveTenantFromRequest();
  const memberDeps = buildMembersDeps(tenantCtx);

  // 060-member-portal-d4 (final review) — three early-return branches
  // (member-lookup failure, not-linked, list-read throw) render the SAME
  // centred message card under the page header; only the message string
  // differs. Extracted to a local helper so the three branches keep their
  // own log/discriminate logic but share ONE byte-identical card shape (a
  // copy drifting would give members three subtly different empty states).
  const messageState = (message: string): React.ReactElement => (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-muted-foreground">{message}</p>
        </CardContent>
      </Card>
    </DetailContainer>
  );

  // Resolve the member linked to this user — if none, surface the
  // "not linked" empty state instead of listing zero rows (which
  // would be indistinguishable from "member with no invoices").
  //
  // 060-member-portal-d4 (I5) — `findByLinkedUserId` returns TWO distinct
  // errors: `repo.not_found` (no contact links this session user — genuine,
  // expected) and `repo.unexpected` (a DB/RLS error THREW, wrapped by the
  // repo). Previously both collapsed to the "not linked" card with no log, so
  // a transient DB failure told a legitimately-linked member their account
  // wasn't linked (wrong + unactionable) and gave operators zero signal. Now
  // we discriminate: `repo.not_found` → notLinked (no log); ANY OTHER code →
  // log the failure CLASS (errKind) + a hashed user id (never the raw id —
  // CLAUDE.md § Secrets) and render the loadFailed card.
  const memberResult = await memberDeps.memberRepo.findByLinkedUserId(tenantCtx, user.id);
  if (!memberResult.ok) {
    if (memberResult.error.code !== 'repo.not_found') {
      logger.warn(
        {
          tenantId: tenantCtx.slug,
          userIdHash: hashId(user.id),
          errKind: errKind(rootCause(memberResult.error)),
        },
        '[portal-invoices-list] member lookup failed — rendering error state',
      );
      return messageState(t('loadFailed'));
    }
    return messageState(t('notLinked'));
  }
  const member = memberResult.value;

  const query = await searchParams;
  const rawPage = Number.parseInt(query.page ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, 1000) : 1;
  const offset = (page - 1) * PAGE_SIZE;
  const searchTerm = (query.q ?? '').trim().slice(0, 100);
  const statusFilter = parseStatusFilter(query.status);
  // 054-event-fee-invoices — subject (membership/event) filter, mirroring the
  // admin list (admin/invoices/page.tsx) so the portal honours the shared
  // InvoiceFilters control. Only the two known subjects are honoured; anything
  // else falls through to "all subjects". (The paid-online filter is admin-only
  // — see SearchParams above — so it is deliberately not threaded here.)
  const subjectFilter =
    query.subject === 'membership' || query.subject === 'event'
      ? query.subject
      : undefined;

  // R7-M3 — was: `invoicesResult.ok ? value.rows : []` (silent fallback).
  // Empty fallback is indistinguishable from "no invoices" — members
  // saw a clean empty state on backend failures (DB outage, RLS misconfig,
  // repo bug). Now we log the error AND render an explicit error card
  // with a retry affordance so operators see the diagnostic AND members
  // know to retry instead of assuming their account is empty.
  //
  // 060-member-portal-d4 (C1) — `listInvoicesPaged` is typed `Result<…, never>`
  // and the repo's `listPaged` runs inside `runInTenant` with NO try/catch, so
  // a DB outage / RLS error / SQL bug THROWS rather than returning `!ok`. The
  // old `if (!invoicesResult.ok)` block was therefore UNREACHABLE — the
  // member-scoped diagnostic never ran and a real failure bubbled to
  // `error.tsx` (which logs WITHOUT tenantId/memberId). Wrap the call so a
  // thrown read renders the loadFailed card and logs the failure CLASS only
  // (errKind — never the raw error / SQL / PII). The `!ok` narrow is kept for
  // type-completeness (the union still carries `Err<never>`) but is
  // unreachable-by-design: it throws into the same catch.
  let pageData: ListInvoicesPagedOutput;
  try {
    const invoicesResult = await listInvoicesPaged(makeListInvoicesDeps(tenantCtx.slug), {
      tenantId: tenantCtx.slug,
      offset,
      pageSize: PAGE_SIZE,
      includeDrafts: false, // members never see drafts
      memberId: member.memberId,
      search: searchTerm.length > 0 ? searchTerm : undefined,
      status: statusFilter,
      ...(subjectFilter ? { invoiceSubject: subjectFilter } : {}),
    });
    // If `listInvoicesPaged` ever gains a real Err variant, branch on
    // `invoicesResult.error` here instead of re-throwing — re-throwing would
    // log it as a generic `Error` kind, losing the structured error.code.
    if (!invoicesResult.ok) throw new Error('unreachable');
    pageData = invoicesResult.value;
  } catch (e) {
    logger.warn(
      {
        tenantId: tenantCtx.slug,
        memberId: member.memberId,
        errKind: errKind(e),
      },
      '[portal-invoices-list] listInvoicesPaged threw — rendering error state',
    );
    return messageState(t('loadFailed'));
  }
  const rawRows = pageData.rows;
  const total = pageData.total;
  // T109 — presentation-only overdue derivation (FR-028). Each row's
  // view-model swaps `'issued'` for `'overdue'` (via `toInvoiceRowViewModel`,
  // which calls `computeIsOverdue` internally) when Bangkok-today has
  // passed dueDate. Audit emit is NOT done on portal list reads — the
  // admin surface handles that opportunistically to avoid multiplying
  // per-row inserts on self-service page loads.
  //
  // 060-member-portal-d4 — per-row presentation flags (displayStatus,
  // isCombinedPaid, showInvoice/showReceipt, receiptPending, receiptFailed,
  // resendable) are derived ONCE here into a shared view-model so the desktop table
  // (below) and the mobile card list consume one source of truth and can
  // never drift apart. The "has any action" decision is derived on demand
  // from those flags via `rowHasAnyAction(vm)` (not stored, so it can't go
  // stale). The raw repo row is NOT carried on these entries — every
  // action/label/hint/sentinel decision on both surfaces reads `vm.*` only,
  // so the card can never re-derive a flag the table didn't (and vice versa).
  const nowUtcIso = new Date().toISOString();
  const rows = rawRows.map((r) => ({
    vm: toInvoiceRowViewModel(r, nowUtcIso),
  }));

  const hasActiveFilter =
    searchTerm.length > 0 ||
    statusFilter !== 'all' ||
    subjectFilter !== undefined;

  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Card>
        <CardContent className="flex flex-col gap-4">
          {/* Reuse the admin InvoiceFilters client component for UI parity
              (same shadcn Select, same debounced search, same X-clear
              affordance), but configured for self-service:
              - statusOptions drops 'draft' (members never see drafts —
                includeDrafts:false at the use-case level — so a draft option
                would only ever yield an unexplained empty state). 'overdue'
                IS included and now filters correctly (parseStatusFilter +
                the repo's derived overdue branch).
              - showPaidOnlineChip={false}: the paid-online chip is an admin
                reconciliation filter; a member who paid OFFLINE would see
                their legitimate invoices vanish, so it is meaningless here. */}
          <InvoiceFilters
            statusOptions={PORTAL_STATUS_OPTIONS}
            showPaidOnlineChip={false}
          />
          {rows.length === 0 ? (
            <div className="py-12 text-center">
              <p className="text-muted-foreground">
                {hasActiveFilter ? t('filters.noMatch') : t('empty')}
              </p>
            </div>
          ) : (
            <>
              {/* 060-member-portal-d4 — dual-render. The 7-column desktop
                  table is hidden below `md` (768px); the mobile card list
                  (`PortalInvoiceCardList`) takes over `< md`. Both consume
                  the SAME per-row view-model (`rows[].vm`) so they can never
                  drift apart. Filters + pagination + empty/no-match states
                  live ABOVE this branch and render ONCE for both form
                  factors. */}
              {/* R8-M1-ux — dual-tone inset shadow signals horizontal
                  scroll on the table (parity with admin table U-I4). The
                  portal list has 7 columns; without the cue, members miss
                  the right-edge Total + Actions silently. */}
              <div className="hidden overflow-x-auto shadow-[inset_-12px_0_8px_-12px_rgba(0,0,0,0.08)] md:block dark:shadow-[inset_-12px_0_8px_-12px_rgba(255,255,255,0.10)]">
                <Table aria-label={t('title')}>
                  <TableHeader>
                    <TableRow>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.documentNumber')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground whitespace-nowrap"
                      >
                        {t('columns.receiptNumber')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.status')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.issueDate')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.dueDate')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.total')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('columns.actions')}
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {/* 060-member-portal-d4 — the row map reads ONLY `vm.*`
                        (the shared view-model) for every action/label/hint/
                        sentinel decision; the raw repo row is no longer
                        destructured here so the table can never drift from the
                        mobile card. */}
                    {rows.map(({ vm }) => (
                      <TableRow key={vm.invoiceId}>
                        <TableCell className="align-middle font-mono text-xs">
                          <Link
                            href={`/portal/invoices/${vm.invoiceId}`}
                            className="underline underline-offset-4 hover:no-underline focus-visible:outline-2 focus-visible:outline-offset-2"
                            aria-label={`${t('actions.viewDetail')} ${vm.documentNumber ?? vm.invoiceId}`}
                          >
                            {vm.documentNumber ?? '—'}
                          </Link>
                        </TableCell>
                        <TableCell className="align-middle whitespace-nowrap">
                          {vm.receiptNumber ? (
                            <span className="font-mono text-sm tabular-nums">
                              {vm.receiptNumber}
                            </span>
                          ) : vm.isCombinedPaid ? (
                            // Combined-mode = receipt reuses invoice number.
                            // 060-member-portal-d4 (F3) — gate on
                            // `vm.isCombinedPaid` (paid AND receiptPdfStatus
                            // 'rendered'), NOT the raw `r.status === 'paid'`.
                            // A paid combined-mode invoice whose receipt is
                            // still rendering (`receiptPdfStatus = 'pending'`)
                            // must NOT show the "receipt = invoice number" hint
                            // prematurely — the action cell shows "Preparing
                            // receipt…" in that window. The card omits only
                            // the combined-mode receipt-number HINT (em-dash +
                            // tooltip); it STILL renders a separate-mode
                            // receipt-number line when `vm.receiptNumber` is
                            // present, so it shows nothing in combined-pending
                            // — gating this table hint on `vm.isCombinedPaid`
                            // keeps the two surfaces in lockstep. Only the
                            // combined RECEIPT-DOWNLOAD label is gated on
                            // `isCombinedPaid` on both surfaces.
                            // Em-dash + InfoIcon affordance with min-h-6 hit
                            // area for WCAG 2.2 SC 2.5.8 (R5-UX-M2).
                            // F5R6+ — extracted to a Client Component
                            // wrapper because Tooltip.Trigger's `render`
                            // prop is a function; passing it from a Server
                            // Component to a Client Component throws the
                            // "Functions cannot be passed directly to
                            // Client Components" error under React 19 +
                            // Next.js 16 strict SC/CC boundaries.
                            <CombinedReceiptHint
                              ariaLabel={t('receiptNumberCombinedAria')}
                              tooltipText={t('receiptNumberCombinedTooltip')}
                            />
                          ) : (
                            <EmptyCell />
                          )}
                        </TableCell>
                        <TableCell className="align-middle">
                          <InvoiceStatusBadge
                            status={vm.displayStatus}
                            label={tStatus(vm.displayStatus)}
                          />
                        </TableCell>
                        <TableCell className="align-middle">
                          {formatDate(vm.issueDate, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle">
                          {formatDate(vm.dueDate, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle text-right tabular-nums">
                          {formatSatangThb(vm.total?.satang ?? null, userLocale)}
                        </TableCell>
                        <TableCell className="align-middle text-right">
                          {(() => {
                            // 060-member-portal-d4 — per-row flags are now
                            // derived once into `vm` (toInvoiceRowViewModel)
                            // and shared with the mobile card list.
                            //
                            // Combined-paid rows: the invoice PDF *is*
                            // the receipt — hide the (now-stale) invoice
                            // anchor + show only "Receipt" so the legal
                            // §86/4+§105ทวิ document is what the member
                            // grabs. Separate-paid: show both.
                            // R7-M5 — async receipt-PDF gate: when the
                            // receipt is mid-render (`receiptPending`),
                            // surface a compact "preparing" affordance
                            // alongside any visible download button.
                            // 060-member-portal-d4 (F4) — guard on the shared
                            // `rowHasAnyAction(vm)` (= OR of the four action
                            // flags) instead of the former multi-term guard
                            // whose final term was `r.pdf === null`, so the
                            // mobile card (which only receives the VM) applies
                            // the IDENTICAL "nothing to show → em-dash" rule and
                            // never renders an empty action group.
                            if (!rowHasAnyAction(vm)) {
                              return <EmptyCell />;
                            }
                            return (
                              <div className="flex items-center justify-end gap-1">
                                {vm.resendable ? (
                                  <ResendInvoiceButton
                                    invoiceId={vm.invoiceId}
                                    documentNumber={vm.documentNumber ?? vm.invoiceId}
                                    variant="ghost"
                                    layout="compact"
                                    className="min-h-11 min-w-11"
                                  />
                                ) : null}
                                {vm.showInvoice && (
                                  <PortalInvoiceDownloadButton
                                    invoiceId={vm.invoiceId}
                                    documentNumber={vm.documentNumber ?? vm.invoiceId}
                                    // 064 — as-paid TIN rows: the main pdf IS the
                                    // final combined Tax Invoice / Receipt, so the
                                    // label + aria flip to the combined dual-role
                                    // wording (same keys the receipt button uses in
                                    // bill-first combined mode). Mirrors the card.
                                    label={
                                      vm.displayStatus === 'void'
                                        ? t('actions.downloadVoided')
                                        : vm.mainPdfIsFinalCombined
                                          ? t('actions.downloadCombined')
                                          : t('actions.download')
                                    }
                                    ariaLabel={t(
                                      vm.displayStatus === 'void'
                                        ? 'actions.downloadVoidedAria'
                                        : vm.mainPdfIsFinalCombined
                                          ? 'actions.downloadCombinedAria'
                                          : 'actions.downloadInvoiceAria',
                                      {
                                        number: vm.documentNumber ?? vm.invoiceId,
                                      },
                                    )}
                                    className={cn(
                                      buttonVariants({ variant: 'ghost', size: 'sm' }),
                                      'min-h-11 px-3',
                                    )}
                                  />
                                )}
                                {vm.showReceipt &&
                                  (() => {
                                    // 060-member-portal-d4 (final review) — the
                                    // receipt reference (separate-mode receipt
                                    // number, else the invoice doc number, else
                                    // the raw id) was computed twice in this
                                    // button (the `documentNumber` prop + the aria
                                    // `number`). Hoist it so the visible doc-ref
                                    // and the SR aria can never diverge. Mirrors
                                    // the card.
                                    const receiptRef =
                                      vm.receiptNumber ?? vm.documentNumber ?? vm.invoiceId;
                                    return (
                                      <PortalReceiptDownloadButton
                                        invoiceId={vm.invoiceId}
                                        documentNumber={receiptRef}
                                        label={
                                          vm.isCombinedPaid
                                            ? t('actions.downloadCombined')
                                            : t('actions.downloadReceipt')
                                        }
                                        // 060-member-portal-d4 (F2) — branch the aria
                                        // on `vm.isCombinedPaid` so the SR name matches
                                        // the visible combined label ("Tax invoice /
                                        // Receipt"). Previously hardcoded to
                                        // `downloadReceiptAria` ("Download tax receipt
                                        // PDF"), contradicting the combined visible
                                        // text. Mirrors the card.
                                        ariaLabel={t(
                                          vm.isCombinedPaid
                                            ? 'actions.downloadCombinedAria'
                                            : 'actions.downloadReceiptAria',
                                          { number: receiptRef },
                                        )}
                                        className={cn(
                                          buttonVariants({ variant: 'ghost', size: 'sm' }),
                                          'min-h-11 px-3',
                                        )}
                                      />
                                    );
                                  })()}
                                {vm.receiptPending && (
                                  <span
                                    role="status"
                                    aria-live="polite"
                                    aria-busy="true"
                                    className={cn(
                                      buttonVariants({ variant: 'outline', size: 'sm' }),
                                      'min-h-11 px-3 cursor-progress',
                                    )}
                                  >
                                    {t('actions.receiptPreparing')}
                                  </span>
                                )}
                                {/* S1 fix — TERMINAL receipt-render failure.
                                    A 'failed' receiptPdfStatus is NOT in-progress,
                                    so it must NOT reuse the receiptPending spinner
                                    (role=status + aria-busy) — that mislabels a
                                    permanent failure as a perpetual "preparing"
                                    state. Render a static, muted "Receipt
                                    unavailable" label with NO aria-busy and NO
                                    spinner. The member can still grab the Invoice
                                    PDF (showInvoice) and a receipt action surfaces
                                    the existing 502 toast. Identical affordance on
                                    the mobile card (same vm.receiptFailed flag). */}
                                {vm.receiptFailed && (
                                  <span className="text-sm text-muted-foreground">
                                    {t('actions.receiptUnavailable')}
                                  </span>
                                )}
                              </div>
                            );
                          })()}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
              {/* Mobile card list (`< md`). Consumes the same `rows[].vm`
                  the table consumes — no recomputed flags. */}
              <PortalInvoiceCardList
                rows={rows}
                locale={userLocale}
                t={t}
                tStatus={tStatus}
                className="md:hidden"
              />
              <TablePagination
                page={page}
                pageSize={PAGE_SIZE}
                total={total}
                baseHref="/portal/invoices"
              />
            </>
          )}
        </CardContent>
      </Card>
      <span className="sr-only">{t('loaded')}</span>
    </DetailContainer>
  );
}
