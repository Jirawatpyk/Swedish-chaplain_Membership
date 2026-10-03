/**
 * F4 US1 AS6 — invoice detail not-found UI.
 *
 * Rendered when `page.tsx` calls `notFound()` because:
 *   - the requested invoiceId does not exist in the current tenant
 *     (`getInvoice → err({code:'not_found'})`, an invoice_cross_tenant_probe
 *     audit fires server-side), or
 *   - a cross-tenant probe was caught (anti-enumeration: absent-row
 *     and cross-tenant probe are indistinguishable to the caller).
 *
 * Without a segment-level `not-found.tsx`, Next.js 16 RSC streaming
 * commits response headers (with status 200) BEFORE `notFound()`
 * resolves — the rendered body is still the not-found UI but the
 * HTTP status leaks 200 in dev mode. F5R6+ fix mirrors the F7
 * broadcasts pattern at `src/app/(member)/portal/broadcasts/[id]/
 * not-found.tsx` to restore the spec-mandated 404 status.
 *
 * See `tests/e2e/invoice-draft-issue.spec.ts` AS6 for the pinned
 * "HTTP status MUST be 404" contract. On AURA since spec 122 US8b (T827).
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Icon, buttonClass } from '@jirawatpyk/aura-react/server';

export default async function InvoiceNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.invoices');
  const tErrors = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('list.title')} />
      <div
        data-testid="invoice-not-found"
        className="rounded-[var(--aura-card-radius)] border border-[var(--aura-border-default)] bg-[var(--aura-bg-surface)] p-8 text-center"
      >
        <p className="m-0 text-sm text-[var(--aura-fg-secondary)]">{tErrors('notFound')}</p>
        <Link
          href="/admin/invoices"
          className={buttonClass({ variant: 'secondary', size: 'sm', className: 'mt-4' })}
        >
          <Icon name={<ArrowLeft />} size={16} />
          {t('list.title')}
        </Link>
      </div>
    </DetailContainer>
  );
}
