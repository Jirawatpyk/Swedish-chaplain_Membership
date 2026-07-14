/**
 * T080 — /admin/invoices/[invoiceId]/credit-notes/new (F4 / US6).
 *
 * Admin-only form to issue a credit note against a paid or
 * partially-credited invoice. Refuses if the invoice is in any other
 * status (draft / issued / void / credited) — the server-side
 * use-case guards the same transition, this page just fails fast at
 * the UI layer so admins don't see a form that will always 409.
 */
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { headers } from 'next/headers';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { requireSession } from '@/lib/auth-session';
import { resolveTenantFromHeaders } from '@/lib/tenant-context';
import {
  getInvoice,
  makeGetInvoiceDeps,
  displayDocumentNumber,
  inferEventDocumentKind,
  resolveBuyerIsVatRegistrant,
} from '@/modules/invoicing';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, CardContent } from '@/components/ui/card';
import { CreditNoteForm } from './_components/credit-note-form';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.creditNotes.new');
  return { title: t('title') };
}

export default async function NewCreditNotePage({
  params,
}: {
  params: Promise<{ invoiceId: string }>;
}) {
  const { invoiceId } = await params;
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  const t = await getTranslations('admin.creditNotes.new');

  const hdrs = await headers();
  const tenantCtx = resolveTenantFromHeaders(hdrs);

  const invoiceResult = await getInvoice(makeGetInvoiceDeps(tenantCtx.slug), {
    tenantId: tenantCtx.slug,
    invoiceId,
  });
  if (!invoiceResult.ok) notFound();
  const invoice = invoiceResult.value;

  // Only paid + partially_credited can be further credited. The
  // use-case enforces the same; this is the fail-fast UI guard.
  if (invoice.status !== 'paid' && invoice.status !== 'partially_credited') {
    notFound();
  }
  // 088 FIX 5 — mirror `issueCreditNote`'s §86/10 legal gate at the page so a
  // §105 ใบเสร็จรับเงิน (`receipt_separate`) 404s fail-fast instead of rendering
  // a form that always rejects with `receipt_not_creditable` (a §105 receipt has
  // no input VAT to reverse — legally uncreditable). Reconstructs the verdict
  // from the SAME inputs as the use-case (`invoiceSubject` + the BUYER's
  // VAT-registrant status via the shared Domain helpers), keeping issue-time,
  // pay-time, and credit-time gates in lockstep. Runs BEFORE the total/display-
  // number guard: after 088 widened `displayDocumentNumber` to fall back to
  // `receiptDocumentNumberRaw`, a β §105 row now passes that guard, so this
  // dedicated check is what averts the dead-end form the §87 change re-opened.
  //
  // 059 / PR-A Task 6a — re-keyed onto the recorded registrant flag. The
  // resolver fails closed on a missing snapshot (→ non-registrant →
  // receipt_separate → 404), preserving the old `?.` fail-closed posture.
  if (
    inferEventDocumentKind(
      invoice.invoiceSubject,
      resolveBuyerIsVatRegistrant(
        invoice.memberId,
        invoice.memberIdentitySnapshot,
      ),
    ) === 'receipt_separate'
  ) {
    notFound();
  }
  // 088 FR-030 — a paid 088 invoice has NULL §87 `documentNumber`; its
  // §86/4 RC receipt number lives in `receiptDocumentNumberRaw`. Resolve via
  // the shared, unit-tested `displayDocumentNumber` (documentNumber-first, RC
  // fallback, null only when both absent) so a paid 088 invoice is creditable
  // (SC-006), not 404'd. `!displayDocumentNumber(invoice)` is equivalent to
  // `!invoice.documentNumber && !invoice.receiptDocumentNumberRaw` — a validated
  // DocumentNumber's `.raw` is never empty, so `!displayDocumentNumber(invoice)`
  // is true iff both fields are absent. Hoisted to one call — reused by the
  // guard below AND the CreditNoteForm `documentNumber` prop.
  const displayNumber = displayDocumentNumber(invoice);
  if (!invoice.total || !displayNumber) {
    notFound();
  }

  const remainingSatang = (
    invoice.total.satang - invoice.creditedTotal.satang
  ).toString();

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('description')} />
      <Card>
        <CardContent>
          <CreditNoteForm
            invoiceId={invoiceId}
            // documentNumber-FIRST so legacy IN-…/separate-mode keep their
            // §87 number; a paid 088 invoice (documentNumber NULL) falls
            // through to its RC (SC-006). Display-only ("against invoice
            // {number}" label). The guard above already proved this is non-null.
            documentNumber={displayNumber ?? ''}
            remainingSatang={remainingSatang}
            currencySymbol="THB"
            // F-2 (2026-07-08) — the form shows the membership-effect radio
            // ONLY for a membership invoice whose amount fully credits it.
            invoiceSubject={invoice.invoiceSubject}
          />
        </CardContent>
      </Card>
      <Link
        href={`/admin/invoices/${invoiceId}`}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:underline"
      >
        <ArrowLeftIcon className="size-4" aria-hidden="true" />
        {t('backToInvoice')}
      </Link>
    </FormContainer>
  );
}
