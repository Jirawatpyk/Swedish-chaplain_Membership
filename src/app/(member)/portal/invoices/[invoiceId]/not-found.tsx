/**
 * F4/F5 polish retrospective Phase E (2026-05-17) — portal invoice
 * detail not-found UI.
 *
 * Rendered when `page.tsx` calls `notFound()` because:
 *   - the requested invoiceId does not exist in the current tenant
 *     (cross-tenant probe audit emitted by `getInvoice`); or
 *   - same-tenant-different-member case (member-scope check fails
 *     even though the invoice resolves); or
 *   - the row is in `draft` status (drafts aren't exposed to members).
 *
 * Without a segment-level `not-found.tsx` + `export const dynamic =
 * 'force-dynamic'` in page.tsx, Next.js 16 RSC streaming commits
 * response headers (status 200) BEFORE `notFound()` resolves. The
 * rendered body is still the not-found UI but the HTTP status leaks
 * 200 — breaking Principle I cross-tenant probe contract.
 *
 * Mirrors the F7 broadcasts pattern at `src/app/(member)/portal/
 * broadcasts/[id]/not-found.tsx` + the admin sibling at
 * `src/app/(staff)/admin/invoices/[invoiceId]/not-found.tsx`.
 *
 * Covered by `tests/e2e/smoke-404-status-contract.spec.ts`.
 */
import Link from 'next/link';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Card, EmptyState, Icon, buttonClass } from '@jirawatpyk/aura-react/server';

export default async function PortalInvoiceNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.invoices');
  const tErrors = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      {/* PR Q — AURA's Card holding AURA's EmptyState (frameless, its title a
          paragraph so the page outline is unchanged), the way back its action. */}
      <Card as="div" data-testid="portal-invoice-not-found">
        <EmptyState
          bordered={false}
          headingLevel={false}
          icon={<FileQuestion />}
          title={tErrors('notFound')}
          action={
            <Link
              href="/portal/invoices"
              className={buttonClass({ variant: 'secondary', size: 'sm', touchHeight: true })}
            >
              <Icon name={<ArrowLeft />} size={16} />
              {t('title')}
            </Link>
          }
        />
      </Card>
    </DetailContainer>
  );
}
