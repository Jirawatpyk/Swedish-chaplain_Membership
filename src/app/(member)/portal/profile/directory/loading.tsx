/**
 * Route-level loading UI for /portal/profile/directory — AURA card skeletons
 * in the final shape (spec 122 US3): the logo card, then the listing form's
 * cards (listed switch, field-visibility checkboxes, details fields).
 */
import { getTranslations } from 'next-intl/server';
import { SkeletonBlock } from '@/components/shell/page-skeletons';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';

const FIELD_ROWS = Array.from({ length: 9 }, (_, i) => i);

function CardSkeleton({ children }: { readonly children: React.ReactNode }) {
  return (
    <div className="aura-card" aria-hidden>
      <div className="aura-card__head">
        <SkeletonBlock className="h-5 w-40" />
      </div>
      <div className="aura-card__body flex flex-col gap-3">{children}</div>
    </div>
  );
}

export default async function Loading(): Promise<React.JSX.Element> {
  const t = await getTranslations('directorySettings');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('subtitle')} />

      <CardSkeleton>
        <SkeletonBlock className="h-20 w-32" />
        <SkeletonBlock className="h-4 w-64" />
        <SkeletonBlock className="h-11 w-40" />
      </CardSkeleton>

      <CardSkeleton>
        <SkeletonBlock className="h-6 w-full max-w-sm" />
      </CardSkeleton>

      <CardSkeleton>
        {FIELD_ROWS.map((i) => (
          <SkeletonBlock key={i} className="h-5 w-full max-w-xs" />
        ))}
      </CardSkeleton>

      <CardSkeleton>
        <SkeletonBlock className="h-11 w-full" />
        <SkeletonBlock className="h-20 w-full" />
        <SkeletonBlock className="h-11 w-full" />
      </CardSkeleton>
    </DetailContainer>
  );
}
