import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon, SearchIcon } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { Card, Icon, buttonClass } from '@jirawatpyk/aura-react/server';

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
 * Spec 122 US3 (`Portal-not-found` board): one centred 560px card, the h1
 * inside it under a search icon, the hint as plain text, and a primary
 * "back to dashboard" button with an arrow. `data-testid="portal-not-found"`
 * stays on the card for the e2e.
 */
export default async function PortalNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('errors');

  return (
    <DetailContainer className="lg:pt-8">
      <Card
        as="section"
        data-testid="portal-not-found"
        aria-labelledby="portal-not-found-heading"
        className="mx-auto w-full max-w-[560px] [--font-size-h1:1.875rem]"
      >
        <div className="flex flex-col gap-3">
          <SearchIcon size={28} aria-hidden="true" className="text-[var(--aura-fg-secondary)]" />
          <h1 id="portal-not-found-heading" tabIndex={-1} className="text-h1 focus-visible:outline-none">
            {t('notFound')}
          </h1>
          <p className="text-[var(--aura-fg-secondary)]">{t('notFoundHint')}</p>
          <div className="flex gap-2 pt-1">
            <Link href="/portal" className={buttonClass()}>
              <Icon name={<ArrowLeftIcon />} size={16} />
              {t('backToDashboard')}
            </Link>
          </div>
        </div>
      </Card>
    </DetailContainer>
  );
}
