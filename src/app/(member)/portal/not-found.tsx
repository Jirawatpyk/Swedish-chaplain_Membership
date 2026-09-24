import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FileQuestionIcon } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';

/**
 * Member-portal not-found boundary (portal error states #3; AURA canvas
 * "Portal not found (proposed)").
 *
 * Until this file existed there was no `not-found.tsx` at the portal root, so
 * every `notFound()` without a segment-level boundary of its own —
 * `change-requests`, `profile/directory`, `account`, `account/data-export`,
 * `renewal/[memberId]`, `renewal/[memberId]/success` — and every unmatched
 * `/portal/*` URL (routed here by the `[...unknown]` catch-all) rendered
 * Next.js's built-in English-only 404, outside the member shell, with no way
 * back.
 *
 * The copy is cause-neutral for the same reason as the staff boundary
 * (`src/app/(staff)/admin/not-found.tsx`): `notFound()` is also the deny shape
 * for cross-member and unknown-id probes, so naming a cause would disclose one.
 * The segment-level boundaries (`invoices/[invoiceId]`,
 * `credit-notes/[creditNoteId]`, `broadcasts/[id]`) keep their own
 * back-to-list links.
 */
export default async function PortalNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('notFound')} />
      <div
        data-testid="portal-not-found"
        className="flex flex-col items-center gap-3 rounded-md border p-12 text-center"
      >
        <FileQuestionIcon className="size-12 text-muted-foreground" aria-hidden="true" />
        <p className="max-w-md text-sm text-muted-foreground">{t('notFoundHint')}</p>
        <Link href="/portal" className={`${buttonVariants()} mt-2`}>
          {t('backToDashboard')}
        </Link>
      </div>
    </DetailContainer>
  );
}
