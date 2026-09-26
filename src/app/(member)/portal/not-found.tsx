import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FileQuestionIcon } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { auraButtonClass } from '@/components/shell/aura-markup';

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
 *
 * Spec 122 US3: the shared (AURA) EmptyState with an AURA button link back.
 * `announce={false}`: this is a page, not a status change within one.
 */
export default async function PortalNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('notFound')} />
      <EmptyState
        data-testid="portal-not-found"
        icon={FileQuestionIcon}
        title={t('notFoundHint')}
        announce={false}
        action={
          <Link href="/portal" className={auraButtonClass()}>
            {t('backToDashboard')}
          </Link>
        }
      />
    </DetailContainer>
  );
}
