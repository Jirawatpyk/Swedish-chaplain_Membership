/**
 * T056 — /admin/invoices/[invoiceId] detail page.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.invoices.meta');
  return { title: t('title') };
}
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import {
  getInvoice,
  makeGetInvoiceDeps,
  Money,
  calculateVat,
  computeIsOverdue,
  maybeEmitOverdueDetected,
  makeOverdueAuditPort,
} from '@/modules/invoicing';
// Direct infra import for the settings read — same escape-hatch as
// the B2 settings page. This is a READ against the public port
// `getForIssue`, not a deep reach into internals.
// eslint-disable-next-line no-restricted-imports
import { drizzleTenantSettingsRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-tenant-settings-repo';
// Same escape-hatch as the tenant-settings repo read above: a public-
// port read (`findByOriginalInvoice`) used to populate the "Credit
// Notes attached" section. No Application-layer use-case exists yet
// for this list (Phase 10 candidate); the infra repo is called
// directly.
// eslint-disable-next-line no-restricted-imports
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
import { asInvoiceId } from '@/modules/invoicing';
import { getMember } from '@/modules/members';
import type { MemberId } from '@/modules/members';
import { buildMembersDeps } from '@/modules/members/members-deps';
import { listPlans } from '@/modules/plans';
import { buildPlansDeps } from '@/modules/plans/plans-deps';
// Raw repo read mirrors the escape hatch used by /admin/users page.tsx —
// an Application-layer `getStaffUser` would be a passthrough. Read is
// admin-gated by the layout guard.
// eslint-disable-next-line no-restricted-imports
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { asUserId } from '@/modules/auth';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { Card, CardContent } from '@/components/ui/card';
import { buttonVariants } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { IssueInvoiceDialog } from '../_components/issue-invoice-dialog';
import { RecordPaymentDialog } from '../_components/record-payment-dialog';
import { DeleteDraftDialog } from '../_components/delete-draft-dialog';
import { InvoiceMoreMenu } from '../_components/invoice-more-menu';
import { PaymentTimeline } from './_components/payment-timeline';

function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  // N11 — explicit `'en-US'` locale pins thousand-separator output on
  // Vercel runtimes whose process locale may be `C`/`POSIX` (emits no
  // separator). Thai-tax amounts are legal figures; deterministic
  // formatting is required by FR-005.
  return `${sign}${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

/**
 * Format an ISO timestamp as a medium-style date in the active
 * next-intl locale. Returns an em-dash for null inputs so missing
 * audit timestamps read cleanly in the UI (L7 — duplicate of the
 * inline blocks that used to live on the payment/void sections).
 */
function formatDate(iso: string | null, locale: string): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

type InvoiceStatusBadgeVariant = 'default' | 'secondary' | 'outline' | 'destructive';
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

export default async function InvoiceDetailPage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const t = await getTranslations('admin.invoices.detail');
  const tStatus = await getTranslations('admin.invoices.list.statuses');
  const { user: currentUser } = await requireSession('staff');
  // M3 — use the next-intl locale for date display so TH/SV users
  // see their localised format instead of the browser default.
  const locale = (await import('next-intl/server')).getLocale;
  const userLocale = await locale();

  const hdrs = await headers();
  const requestId = requestIdFromHeaders(hdrs);
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const result = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
    // Actor context — enables invoice_cross_tenant_probe audit emit
    // when an admin navigates to /admin/invoices/<foreign-id>.
    actor: {
      userId: currentUser.id,
      role: currentUser.role as 'admin' | 'manager' | 'member',
      requestId,
    },
  });
  if (!result.ok) return notFound();
  const invoice = result.value;

  // Look up plan display name so we don't show the raw planId slug.
  const plansResult = await listPlans(
    { filter: { year: invoice.planYear as never } },
    buildPlansDeps(tenantCtx),
  );
  const foundPlan = plansResult.ok
    ? plansResult.value.data.find((p) => p.plan_id === invoice.planId)
    : undefined;
  const planDisplayName = foundPlan
    ? (typeof foundPlan.plan_name === 'object' && foundPlan.plan_name !== null
        ? ((foundPlan.plan_name as { en?: string }).en ?? invoice.planId)
        : String(foundPlan.plan_name ?? invoice.planId))
    : invoice.planId;

  // Prefer the frozen snapshot on issued/paid/void invoices (FR-038);
  // fall back to a live member lookup only for drafts (which have no
  // snapshot yet). getMember emits `member_cross_tenant_probe` on 404
  // with the signed-in admin's user id as actor.
  const snapshotName = (invoice.memberIdentitySnapshot as { legal_name?: string } | null)?.legal_name;
  let memberDisplayName = snapshotName ?? invoice.memberId;
  if (!snapshotName) {
    const memberResult = await getMember(
      invoice.memberId as MemberId,
      { actorUserId: currentUser.id, requestId },
      buildMembersDeps(tenantCtx),
    );
    if (memberResult.ok) memberDisplayName = memberResult.value.member.companyName;
  }

  // Resolve staff-user display names for the audit fields on the
  // paid / void sections. Showing a raw UUID in "Recorded by" tells
  // the admin nothing — email is the smallest humane identifier we
  // have today (TODO: add display_name when F1 user profile lands).
  async function resolveUserEmail(userId: string | null): Promise<string> {
    if (!userId) return '—';
    const row = await userRepo.findById(asUserId(userId));
    return row?.email ?? userId;
  }
  const [paymentRecordedByEmail, voidedByEmail] = await Promise.all([
    resolveUserEmail(invoice.paymentRecordedByUserId),
    resolveUserEmail(invoice.voidedByUserId),
  ]);

  // Phase-10 polish — load any credit notes attached to this invoice
  // so the detail page can surface the CN list inline. Cheap: no CN
  // rows are returned for 99% of invoices (only paid/credited ones
  // can have any); the "don't render when empty" rule keeps the
  // section invisible on the common path.
  const creditNoteRepo = makeDrizzleCreditNoteRepo(tenantCtx.slug);
  const creditNotes = await creditNoteRepo.findByOriginalInvoice(
    asInvoiceId(invoiceId),
    tenantCtx.slug,
  );

  const isDraft = invoice.status === 'draft';
  const isAdmin = currentUser.role === 'admin';

  // T109 — derive the presentation-only `overdue` variant + fire the
  // opportunistic `invoice_overdue_detected` audit on first detection
  // per Bangkok-local day (idempotent via migration 0021's partial
  // unique idx). Detail page is a single-invoice read, so the emit
  // is cheap (one insert, dedup by index on repeat views the same
  // day). Fire-and-forget — swallowed-adapter errors do not 500 the
  // page because the adapter's catch logs pino and returns false.
  const nowUtcIso = new Date().toISOString();
  const overdueDetected = computeIsOverdue(invoice, nowUtcIso);
  const displayStatus = overdueDetected ? 'overdue' : invoice.status;
  if (overdueDetected) {
    void maybeEmitOverdueDetected(
      makeOverdueAuditPort(),
      invoice,
      nowUtcIso,
      { userId: currentUser.id, requestId: requestId ?? null },
    );
  }

  // Drafts don't persist subtotal/vat/total on the row (those are
  // frozen snapshots set on issue). For display, compute a live
  // preview from line totals + current F2 VAT rate. Issued invoices
  // use their stored snapshots.
  let displaySubtotalSatang: bigint | null = invoice.subtotal?.satang ?? null;
  let displayVatSatang: bigint | null = invoice.vat?.satang ?? null;
  let displayTotalSatang: bigint | null = invoice.total?.satang ?? null;
  let displayVatPercent: string | null = invoice.vatRate?.toPercentString() ?? null;

  if (isDraft) {
    let sub = Money.zero();
    for (const line of invoice.lines) sub = sub.add(line.total);
    displaySubtotalSatang = sub.satang;

    // R7-B2 follow-up — source VAT from `tenant_invoice_settings`
    // (the `issue-invoice` use-case's source of truth, FR-009/011),
    // NOT from F2 `tenant_fee_config`. The two tables can drift and
    // the invoice will be snapshotted from invoice-settings at
    // issue time — the draft preview MUST match what issuance will
    // produce, otherwise admin sees one number and commits another.
    const invoiceSettings = await drizzleTenantSettingsRepo.getForIssue(tenantCtx.slug);
    if (invoiceSettings) {
      const { vat, total } = calculateVat(sub, invoiceSettings.vatRate);
      displayVatSatang = vat.satang;
      displayTotalSatang = total.satang;
      displayVatPercent = invoiceSettings.vatRate.toPercentString();
    }
  }

  const breadcrumbLabel = invoice.documentNumber?.raw ?? t('draftTitle');

  return (
    <DetailContainer>
      <PlanBreadcrumbLabel segment={invoiceId} label={breadcrumbLabel} />
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            <span>{invoice.documentNumber?.raw ?? t('draftTitle')}</span>
            <Badge variant={statusBadgeVariant(displayStatus)}>
              {tStatus(displayStatus)}
            </Badge>
          </span>
        }
        actions={
          <>
            {isDraft && isAdmin && (
              <>
                <a
                  href={`/api/invoices/${invoice.invoiceId}/preview`}
                  className={buttonVariants({ variant: 'outline' })}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {t('actions.preview')}
                </a>
                {/* Issue — AlertDialog pattern (align with F3 archive /
                    F2 clone-year). Confirmation stays in-context so
                    the admin sees the summary numbers as they type
                    the irreversible phrase. */}
                <DeleteDraftDialog invoiceId={invoice.invoiceId} />
                <IssueInvoiceDialog
                  invoiceId={invoice.invoiceId}
                  summary={{
                    memberName: memberDisplayName,
                    planDisplayName,
                    planYear: invoice.planYear,
                    subtotalText: formatSatang(displaySubtotalSatang),
                    vatText: formatSatang(displayVatSatang),
                    vatPercent: displayVatPercent ?? '',
                    totalText: formatSatang(displayTotalSatang),
                  }}
                />
              </>
            )}
            {invoice.status === 'issued' && isAdmin && (
              // Pay — Dialog pattern (align with F1 invite / F1 change
              // password). Short 4-field form, in-context overlay so
              // the admin still sees the invoice total + document
              // number in the background card.
              <RecordPaymentDialog
                invoiceId={invoice.invoiceId}
                documentNumber={invoice.documentNumber?.raw ?? null}
                issueDate={invoice.issueDate}
              />
            )}
            {invoice.status === 'issued' && isAdmin && (
              // Void — destructive terminal action on issued-unpaid
              // invoices (US5 / FR-008). Routes to the typed-phrase
              // confirm page at /admin/invoices/[id]/void rather than
              // using an in-context dialog — a typed-phrase gate is
              // high-friction by design (the phrase is the invoice's
              // document number; see void-confirm-dialog.tsx) and
              // deserves its own route for deep-linking + staging walk-
              // throughs (CP-9.3). Rendered as a destructive outline
              // button so it sits visually next to Pay without
              // outranking it as a primary action.
              <Link
                href={`/admin/invoices/${invoice.invoiceId}/void`}
                className={buttonVariants({ variant: 'destructive-outline' })}
                data-testid="void-invoice-trigger"
              >
                {t('actions.void')}
              </Link>
            )}
            {(invoice.status === 'paid' || invoice.status === 'partially_credited') &&
              isAdmin && (
                <Link
                  href={`/admin/invoices/${invoice.invoiceId}/credit-notes/new`}
                  className={buttonVariants({ variant: 'outline' })}
                >
                  {t('actions.issueCreditNote')}
                </Link>
              )}
            {/* Secondary actions (Download PDF, Resend invoice, Resend
                receipt) collapse into one "⋯" icon dropdown so the
                action row exposes only primary/destructive CTAs as
                standalone buttons. Menu returns null when nothing to
                show. T107 visibility rules preserved inside the menu. */}
            {!isDraft && (
              <InvoiceMoreMenu
                invoiceId={invoice.invoiceId}
                documentNumber={invoice.documentNumber?.raw ?? invoice.invoiceId}
                showDownload={Boolean(invoice.pdf)}
                showResendInvoice={
                  isAdmin && invoice.status !== 'void' && Boolean(invoice.pdf)
                }
                showResendReceipt={
                  isAdmin &&
                  invoice.status === 'paid' &&
                  Boolean(invoice.receiptPdf)
                }
              />
            )}
          </>
        }
      />
      <Card>
        <CardContent className="flex flex-col gap-4">
          <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
            <div>
              <dt className="text-muted-foreground">{t('fields.memberId')}</dt>
              <dd>
                <Link
                  href={`/admin/members/${invoice.memberId}`}
                  className="underline-offset-2 hover:underline"
                >
                  {memberDisplayName}
                </Link>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.plan')}</dt>
              <dd>
                {planDisplayName} <span className="text-muted-foreground">/ {invoice.planYear}</span>
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.issueDate')}</dt>
              <dd>{formatDate(invoice.issueDate, userLocale)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.dueDate')}</dt>
              <dd>{formatDate(invoice.dueDate, userLocale)}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">{t('fields.subtotal')}</dt>
              <dd>{formatSatang(displaySubtotalSatang)} THB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t('fields.vat')}
                {displayVatPercent && (
                  <span className="ml-1 text-xs">({displayVatPercent})</span>
                )}
              </dt>
              <dd>{formatSatang(displayVatSatang)} THB</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">
                {t('fields.total')}
                {isDraft && <span className="ml-1 text-xs">({t('previewLabel')})</span>}
              </dt>
              <dd className="font-semibold">{formatSatang(displayTotalSatang)} THB</dd>
            </div>
          </dl>

          {/* Payment details — visible once the invoice is paid. Shows
              who recorded the payment, when, and the supporting
              reference/notes so finance + audit both have the story
              on one screen. */}
          {invoice.status === 'paid' && (
            <section
              className="mt-2 rounded-md border bg-muted/30 p-4"
              aria-labelledby="payment-details-heading"
            >
              <h3
                id="payment-details-heading"
                className="mb-3 text-sm font-medium"
              >
                {t('payment.title')}
              </h3>
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{t('payment.paymentDate')}</dt>
                  <dd>{formatDate(invoice.paymentDate, userLocale)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('payment.paidAt')}</dt>
                  <dd>{formatDate(invoice.paidAt, userLocale)}</dd>
                </div>
                {/* No separate "Amount paid" row — partial payments are
                    out of MVP scope (spec §US2 AS4), so paid amount is
                    always invoice.total which is already in the main
                    summary above. Add this row when partial payments
                    land. */}
                <div>
                  <dt className="text-muted-foreground">{t('payment.method')}</dt>
                  <dd>
                    {invoice.paymentMethod
                      ? t(`payment.methods.${invoice.paymentMethod}`)
                      : '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('payment.reference')}</dt>
                  <dd className="font-mono text-xs">
                    {invoice.paymentReference ?? '—'}
                  </dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('payment.recordedBy')}</dt>
                  <dd>{paymentRecordedByEmail}</dd>
                </div>
                {invoice.paymentNotes && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{t('payment.notes')}</dt>
                    <dd className="whitespace-pre-wrap">
                      {invoice.paymentNotes}
                    </dd>
                  </div>
                )}
              </dl>
            </section>
          )}

          {/* Void details — parallel structure for voided invoices. */}
          {invoice.status === 'void' && (
            <section
              className="mt-2 rounded-md border border-destructive/30 bg-destructive/5 p-4"
              aria-labelledby="void-details-heading"
            >
              <h3
                id="void-details-heading"
                className="mb-3 text-sm font-medium text-destructive"
              >
                {t('voidDetails.title')}
              </h3>
              <dl className="grid grid-cols-1 gap-4 text-sm sm:grid-cols-2">
                <div>
                  <dt className="text-muted-foreground">{t('voidDetails.voidedAt')}</dt>
                  <dd>{formatDate(invoice.voidedAt, userLocale)}</dd>
                </div>
                <div>
                  <dt className="text-muted-foreground">{t('voidDetails.voidedBy')}</dt>
                  <dd>{voidedByEmail}</dd>
                </div>
                {invoice.voidReason && (
                  <div className="col-span-2">
                    <dt className="text-muted-foreground">{t('voidDetails.reason')}</dt>
                    <dd className="whitespace-pre-wrap">{invoice.voidReason}</dd>
                  </div>
                )}
              </dl>
              {/* Next-step hint (M6) — voided invoices are terminal in
                  §87 terms but finance almost always wants to issue a
                  credit note as the legal undo. F4 US6 ships the flow;
                  until then we surface the intent as a disabled CTA
                  with tooltip so admins know where it's coming. */}
              <p className="mt-3 text-xs text-muted-foreground">
                {t('voidDetails.creditNoteHint')}
              </p>
            </section>
          )}

          {creditNotes.length > 0 && (
            <section
              aria-labelledby="credit-notes-heading"
              className="mt-6 border-t pt-6"
            >
              <div className="mb-4 flex flex-wrap items-baseline justify-between gap-2">
                <h3
                  id="credit-notes-heading"
                  className="text-sm font-medium text-muted-foreground"
                >
                  {t('creditNotesSection.title', { count: creditNotes.length })}
                </h3>
                <p className="text-xs text-muted-foreground">
                  <span>{t('creditNotesSection.totalCredited')}</span>{' '}
                  <span className="font-medium tabular-nums text-foreground">
                    {formatSatang(invoice.creditedTotal.satang)}{' '}
                    <span className="text-muted-foreground">THB</span>
                  </span>
                </p>
              </div>
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.number')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.issueDate')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.reason')}
                      </TableHead>
                      <TableHead
                        scope="col"
                        className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                      >
                        {t('creditNotesSection.col.total')}
                      </TableHead>
                      <TableHead scope="col" className="w-[1%] text-right">
                        <span className="sr-only">
                          {t('creditNotesSection.col.actions')}
                        </span>
                      </TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {creditNotes.map((cn) => (
                      <TableRow key={cn.creditNoteId}>
                        <TableCell className="font-mono font-medium">
                          {cn.documentNumber.raw}
                        </TableCell>
                        <TableCell className="tabular-nums">
                          {formatDate(cn.issueDate, userLocale)}
                        </TableCell>
                        <TableCell
                          className="max-w-[20rem] truncate"
                          title={cn.reason}
                        >
                          {cn.reason}
                        </TableCell>
                        <TableCell className="text-right tabular-nums">
                          {formatSatang(cn.total.satang)}{' '}
                          <span className="text-muted-foreground">THB</span>
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex justify-end gap-2">
                            <a
                              href={`/api/credit-notes/${cn.creditNoteId}/pdf`}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={buttonVariants({
                                variant: 'outline',
                                size: 'sm',
                              })}
                              aria-label={t(
                                'creditNotesSection.action.pdfAria',
                                { number: cn.documentNumber.raw },
                              )}
                            >
                              {t('creditNotesSection.action.pdf')}
                            </a>
                            <Link
                              href={`/admin/credit-notes/${cn.creditNoteId}`}
                              className={buttonVariants({
                                variant: 'secondary',
                                size: 'sm',
                              })}
                              aria-label={t(
                                'creditNotesSection.action.viewAria',
                                { number: cn.documentNumber.raw },
                              )}
                            >
                              {t('creditNotesSection.action.view')}
                            </Link>
                          </div>
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            </section>
          )}

          <section className="mt-6" aria-labelledby="invoice-lines-heading">
            <h3
              id="invoice-lines-heading"
              className="mb-2 text-sm font-medium text-muted-foreground"
            >
              {t('lines.title')}
            </h3>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead
                      scope="col"
                      className="text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.description')}
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.qty')}
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.unit')}
                    </TableHead>
                    <TableHead
                      scope="col"
                      className="text-right text-xs uppercase tracking-wide text-muted-foreground"
                    >
                      {t('lines.total')}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {invoice.lines.map((l) => (
                    <TableRow key={l.lineId}>
                      <TableCell className="align-middle">
                        <div lang="th" className="font-sarabun">{l.descriptionTh}</div>
                        <div className="text-xs text-muted-foreground">{l.descriptionEn}</div>
                      </TableCell>
                      <TableCell className="align-middle text-right tabular-nums">{l.quantity}</TableCell>
                      <TableCell className="align-middle text-right tabular-nums">
                        {formatSatang(l.unitPrice.satang)}
                      </TableCell>
                      <TableCell className="align-middle text-right tabular-nums">{formatSatang(l.total.satang)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        </CardContent>
      </Card>
      {/* F5 Phase 5 (T097–T099) — payment activity timeline. Renders
          for both admin + manager (read-only); mutating refund/void/
          record-payment actions are gated above by `isAdmin`. The
          panel hides behind its own empty state when the invoice has
          no F5 payment + the F4 record-payment flow has not been used
          either, so non-paid drafts/issued invoices show a clean card. */}
      {!isDraft && (
        <div className="mt-4">
          <PaymentTimeline
            invoiceId={invoice.invoiceId}
            tenantId={tenantCtx.slug}
            invoicePaidAt={invoice.paidAt}
          />
        </div>
      )}
    </DetailContainer>
  );
}
