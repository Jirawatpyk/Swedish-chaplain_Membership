/**
 * F4 US7 AS2 — `/admin/credit-notes/[creditNoteId]` detail page.
 *
 * Target of the F3 member-timeline click-through for
 * `credit_note_issued` events (resolve-invoice-event-copy.ts:61 points
 * here). Read-only surface: credit notes are immutable after issue,
 * there are no mutating actions on this page. Admins who need to
 * adjust further must issue a second partial credit note from the
 * original invoice (US6).
 *
 * Layout: DetailContainer (72rem) per docs/ux-standards.md § 18 —
 * matches the sibling invoice-detail page and the read-only nature
 * of this surface.
 *
 * RBAC: `requireSession('staff')` (admin + manager read). `member`
 * role is rejected at the layout; this page does not need extra
 * checks beyond the session gate.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { getLocale, getTranslations } from 'next-intl/server';
import { headers } from 'next/headers';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromRequest } from '@/lib/tenant-context';
import { requestIdFromHeaders } from '@/lib/request-id';
import { getCreditNote, makeGetCreditNoteDeps } from '@/modules/invoicing';
// G-5 — sibling-CN navigation. The list is an admin-view convenience
// (no new use-case); same escape-hatch pattern as the settings +
// credit-note list reads already used on the invoice detail page.
// eslint-disable-next-line no-restricted-imports
import { makeDrizzleCreditNoteRepo } from '@/modules/invoicing/infrastructure/repos/drizzle-credit-note-repo';
// Raw repo read mirrors the escape hatch used by the invoice detail
// page (invoices/[invoiceId]/page.tsx:32). Application-layer
// `getStaffUser` passthrough is pending Phase-10 consolidation.
// eslint-disable-next-line no-restricted-imports
import { userRepo } from '@/modules/auth/infrastructure/db/user-repo';
import { asUserId } from '@/modules/auth';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PlanBreadcrumbLabel } from '@/components/layout/plan-breadcrumb-label';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { buttonVariants } from '@/components/ui/button';
import { CreditNoteMoreMenu } from '../_components/credit-note-more-menu';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.creditNotes.detail.meta');
  return { title: t('title') };
}

/**
 * Formats a satang BigInt amount into a THB decimal string.
 * Copied verbatim from invoices/[invoiceId]/page.tsx:51-62 to preserve
 * the deterministic `'en-US'` locale pin (FR-005). Future Phase-10
 * polish: extract to `src/app/(staff)/admin/_utils/format-satang.ts`.
 */
function formatSatang(satang: bigint | null): string {
  if (satang === null) return '—';
  const abs = satang < 0n ? -satang : satang;
  const whole = abs / 100n;
  const rem = abs % 100n;
  const sign = satang < 0n ? '-' : '';
  return `${sign}${whole.toLocaleString('en-US')}.${rem.toString().padStart(2, '0')}`;
}

/**
 * Format an ISO YYYY-MM-DD (CE) in the active next-intl locale. For
 * Thai locale, append the Buddhist Era year in parentheses — matches
 * the PDF-side treatment in invoice-template.tsx (BE = CE + 543;
 * display-only per project convention, storage stays CE ISO).
 */
function formatIssueDate(isoDate: string, locale: string): string {
  const [yStr, mStr, dStr] = isoDate.split('-');
  const year = Number(yStr);
  const month = Number(mStr);
  const day = Number(dStr);
  if (!year || !month || !day) return isoDate;
  const ce = new Date(Date.UTC(year, month - 1, day)).toLocaleDateString(locale, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  });
  if (locale.startsWith('th')) {
    return `${ce} (พ.ศ. ${year + 543})`;
  }
  return ce;
}

export default async function CreditNoteDetailPage({
  params,
}: {
  params: Promise<{ creditNoteId: string }>;
}) {
  const { creditNoteId } = await params;
  const t = await getTranslations('admin.creditNotes.detail');
  const locale = await getLocale();

  const { user } = await requireSession('staff');

  const hdrs = await headers();
  const requestId = requestIdFromHeaders(hdrs);
  const pseudoReq = new Request('http://localhost:3100', { headers: hdrs });
  const tenantCtx = resolveTenantFromRequest(pseudoReq as never);

  const result = await getCreditNote(makeGetCreditNoteDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    creditNoteId,
    actor: {
      userId: user.id,
      // `requireSession('staff')` narrows to admin | manager; the
      // `role` discriminator on getCreditNote admits both.
      role: user.role === 'manager' ? 'manager' : 'admin',
      requestId,
    },
  });
  if (!result.ok) notFound();
  const cn = result.value;

  // Best-effort resolve the issuer's email for display. Falls back to
  // the raw UUID if the user was deleted — never throws so a missing
  // actor does not 500 the page.
  const issuerUser = await userRepo.findById(asUserId(cn.issuedByUserId)).catch(() => null);
  const issuerLabel = issuerUser?.email ?? cn.issuedByUserId;

  const invoiceHref = `/admin/invoices/${cn.originalInvoiceId}`;

  // G-5 — sibling CNs on the same original invoice. Best-effort:
  // a repo failure never 500s the page (this is a convenience nav
  // block, not load-bearing). Filter self + sort oldest→newest so
  // the visual order matches the sequence the admin issued them in.
  const siblings = await makeDrizzleCreditNoteRepo(tenantCtx.slug)
    .findByOriginalInvoice(cn.originalInvoiceId, tenantCtx.slug)
    .then((all) =>
      all
        .filter((s) => s.creditNoteId !== cn.creditNoteId)
        .sort((a, b) => a.sequenceNumber - b.sequenceNumber),
    )
    .catch(() => [] as never[]);

  return (
    <DetailContainer>
      {/* Replace the raw UUID segment in the breadcrumb with the
        * human-readable CN document number (e.g. CN-2026-000001).
        * Same pattern as the invoice detail page — registers a
        * dynamic label against the creditNoteId path segment so
        * BreadcrumbNav's `useBreadcrumbLabelMap` picks it up. */}
      <PlanBreadcrumbLabel segment={creditNoteId} label={cn.documentNumber.raw} />
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-3">
            <span>{cn.documentNumber.raw}</span>
            <Badge variant="default" aria-label={t('status.issued')}>
              {t('status.issued')}
            </Badge>
          </span>
        }
        subtitle={t('subtitle')}
        actions={
          // Back navigation is handled by the global BreadcrumbNav
          // (admin/layout.tsx) — "Admin > Invoices > [INV#] > Credit
          // Notes > [CN#]" — so the action row only surfaces feature
          // actions (Download + Resend), collapsed into one ghost
          // icon-only dropdown per ux-standards.md § 19.
          <CreditNoteMoreMenu
            creditNoteId={cn.creditNoteId}
            documentNumber={cn.documentNumber.raw}
          />
        }
      />

      {/* Summary card — amounts + cross-reference to the original invoice. */}
      <Card>
        <CardContent>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-[auto_1fr]">
            <dt className="text-muted-foreground">{t('fields.issueDate')}</dt>
            <dd>{formatIssueDate(cn.issueDate, locale)}</dd>

            <dt className="text-muted-foreground">{t('fields.issuedBy')}</dt>
            <dd className="break-all">{issuerLabel}</dd>

            <dt className="text-muted-foreground">{t('fields.originalInvoice')}</dt>
            <dd>
              <Link
                href={invoiceHref}
                className="font-mono underline-offset-2 hover:underline"
              >
                {t('fields.originalInvoiceLinkLabel')}
              </Link>
            </dd>

            <dt className="text-muted-foreground">{t('fields.creditAmount')}</dt>
            <dd className="tabular-nums">
              {formatSatang(cn.creditAmount.satang)}{' '}
              <span className="text-muted-foreground">THB</span>
            </dd>

            <dt className="text-muted-foreground">{t('fields.vat')}</dt>
            <dd className="tabular-nums">
              {formatSatang(cn.vat.satang)}{' '}
              <span className="text-muted-foreground">THB</span>
            </dd>

            <dt className="text-muted-foreground font-medium">{t('fields.total')}</dt>
            <dd className="font-semibold tabular-nums">
              {formatSatang(cn.total.satang)}{' '}
              <span className="text-muted-foreground">THB</span>
            </dd>
          </dl>

          <Separator className="my-6" />

          <section aria-labelledby="cn-reason-heading" className="flex flex-col gap-2">
            <h3
              id="cn-reason-heading"
              className="text-sm font-medium text-muted-foreground"
            >
              {t('reason.heading')}
            </h3>
            <p className="whitespace-pre-wrap text-sm">{cn.reason}</p>
          </section>
        </CardContent>
      </Card>

      {/* G-5 — sibling credit notes against the same invoice. Renders
        * only when the invoice has multiple CNs (partial credits);
        * single-CN invoices hide this block to avoid single-item-list
        * noise. */}
      {siblings.length > 0 && (
        <nav aria-labelledby="cn-siblings-heading" className="px-1">
          <h3
            id="cn-siblings-heading"
            className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground"
          >
            {t('siblings.heading')}
          </h3>
          <ol role="list" className="flex flex-wrap gap-2">
            {siblings.map((s) => (
              <li key={s.creditNoteId}>
                <Link
                  href={`/admin/credit-notes/${s.creditNoteId}`}
                  className={buttonVariants({ variant: 'outline', size: 'sm' })}
                  aria-label={t('siblings.viewLabel', { number: s.documentNumber.raw })}
                >
                  <span className="font-mono">{s.documentNumber.raw}</span>
                </Link>
              </li>
            ))}
          </ol>
        </nav>
      )}

      {/* Parties — identity snapshots are frozen at issue time (FR-038). */}
      <Card>
        <CardContent>
          <div className="grid grid-cols-1 gap-8 sm:grid-cols-2">
            <section aria-labelledby="cn-issuer-heading" className="flex flex-col gap-2">
              <h3
                id="cn-issuer-heading"
                className="text-sm font-medium text-muted-foreground"
              >
                {t('parties.issuer')}
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('parties.legalName')}</dt>
                <dd className="flex flex-col">
                  <span>{cn.tenantIdentitySnapshot.legal_name_th}</span>
                  <span className="text-xs text-muted-foreground">
                    {cn.tenantIdentitySnapshot.legal_name_en}
                  </span>
                </dd>
                <dt className="text-muted-foreground">{t('parties.taxId')}</dt>
                <dd className="font-mono">{cn.tenantIdentitySnapshot.tax_id}</dd>
                <dt className="text-muted-foreground">{t('parties.address')}</dt>
                <dd className="flex flex-col">
                  <span>{cn.tenantIdentitySnapshot.address_th}</span>
                  <span className="text-xs text-muted-foreground">
                    {cn.tenantIdentitySnapshot.address_en}
                  </span>
                </dd>
              </dl>
            </section>

            <section aria-labelledby="cn-customer-heading" className="flex flex-col gap-2">
              <h3
                id="cn-customer-heading"
                className="text-sm font-medium text-muted-foreground"
              >
                {t('parties.customer')}
              </h3>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{t('parties.legalName')}</dt>
                <dd>{cn.memberIdentitySnapshot.legal_name}</dd>
                {cn.memberIdentitySnapshot.tax_id ? (
                  <>
                    <dt className="text-muted-foreground">{t('parties.taxId')}</dt>
                    <dd className="font-mono">{cn.memberIdentitySnapshot.tax_id}</dd>
                  </>
                ) : null}
                <dt className="text-muted-foreground">{t('parties.address')}</dt>
                <dd>{cn.memberIdentitySnapshot.address}</dd>
                {cn.memberIdentitySnapshot.primary_contact_email ? (
                  <>
                    <dt className="text-muted-foreground">{t('parties.contactEmail')}</dt>
                    <dd className="break-all">
                      {cn.memberIdentitySnapshot.primary_contact_email}
                    </dd>
                  </>
                ) : null}
              </dl>
            </section>
          </div>
        </CardContent>
      </Card>
    </DetailContainer>
  );
}
