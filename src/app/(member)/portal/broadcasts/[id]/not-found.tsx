/**
 * F7 US3 AS5 — broadcast detail not-found UI.
 *
 * Rendered when the page calls `notFound()` because the requested
 * broadcast does not exist OR is owned by a different member.
 * Next.js returns HTTP 404 along with this UI (anti-enumeration:
 * absent-row and cross-member probe are indistinguishable to the
 * caller).
 *
 * Without a `not-found.tsx` at this level, Next.js falls back to the
 * default not-found render which is masked by the parent `error.tsx`
 * and ends up serving HTTP 200 for the rendered fallback. Having a
 * dedicated segment-level not-found.tsx restores the spec-mandated
 * 404 status.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';

export default async function BroadcastNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.detail');
  const tErrors = await getTranslations('errors');

  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      <div className="rounded-md border p-8 text-center">
        <p className="text-sm text-muted-foreground">{tErrors('notFound')}</p>
        <Link
          href="/portal/benefits/e-blasts"
          className={`${buttonVariants({ variant: 'outline', size: 'sm' })} mt-4`}
        >
          ← {t('back')}
        </Link>
      </div>
    </DetailContainer>
  );
}
