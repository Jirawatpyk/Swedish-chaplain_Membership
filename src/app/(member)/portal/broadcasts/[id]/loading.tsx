/**
 * F7 US3 T134 — Member broadcast detail loading skeleton.
 *
 * Renders the real PageHeader + Back link (static i18n + static href,
 * no broadcast data needed) so chrome doesn't flash between skeleton
 * and final state. Only the body data sections show skeletons until
 * the use-case resolves.
 */
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export default async function BroadcastDetailLoading(): Promise<React.ReactElement> {
  const t = await getTranslations('portal.broadcasts.detail');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />
      <Link
        href="/portal/benefits/e-blasts"
        className={buttonVariants({ variant: 'ghost', size: 'sm' })}
      >
        <ArrowLeft className="mr-1 h-4 w-4" aria-hidden="true" />
        {t('back')}
      </Link>
      <Skeleton className="h-40 w-full" />
      <Skeleton className="h-32 w-full" />
    </DetailContainer>
  );
}
