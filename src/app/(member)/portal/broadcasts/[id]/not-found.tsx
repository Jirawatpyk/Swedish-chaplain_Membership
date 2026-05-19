/**
 * F7 US3 AS5 — broadcast detail not-found UI.
 *
 * Rendered when the page calls `notFound()` because the requested
 * broadcast does not exist OR is owned by a different member
 * (anti-enumeration: absent-row and cross-member probe are
 * indistinguishable to the caller).
 *
 * Without a segment-level `not-found.tsx`, Next.js 16 RSC streaming
 * can commit response headers (with status 200) before `notFound()`
 * resolves — the rendered body is still the not-found UI but the
 * HTTP status leaks 200 in dev mode. A dedicated segment-level
 * not-found.tsx (combined with `export const dynamic = 'force-dynamic'`
 * on the page) restores the spec-mandated 404 status in production.
 * See `tests/e2e/member-quota-history.spec.ts` AS5 for the dev-vs-prod
 * status nuance.
 */
import Link from 'next/link';
import { ArrowLeft, FileQuestion } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';

export default async function BroadcastNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.detail');
  const tErrors = await getTranslations('errors');

  return (
    // F2 UX hardening — full empty-state anatomy per ux-standards § 3.1:
    // muted icon (48px), heading, explanatory paragraph, primary CTA.
    // Previously: just a flat `<p>` — visually anaemic and SR users had
    // no heading landmark for the state.
    <DetailContainer>
      <PageHeader title={t('title')} />
      <div
        data-testid="broadcast-not-found"
        className="flex flex-col items-center gap-3 rounded-md border p-12 text-center"
      >
        <FileQuestion
          className="h-12 w-12 text-muted-foreground"
          aria-hidden="true"
        />
        <h2 className="text-lg font-semibold">{tErrors('notFound')}</h2>
        <p className="max-w-md text-sm text-muted-foreground">
          {tErrors('notFound')}
        </p>
        <Link
          href="/portal/benefits/e-blasts"
          className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-2 inline-flex items-center`}
        >
          <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
          {t('back')}
        </Link>
      </div>
    </DetailContainer>
  );
}
