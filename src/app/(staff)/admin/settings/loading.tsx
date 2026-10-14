/**
 * Route-level loading skeleton for `/admin/settings` index. Matches
 * the page's `<DetailContainer>` width + card grid shape so layout
 * shifts are minimal (CLS=0 per docs/ux-standards.md § 2.1).
 *
 * Wrapped in `<DetailContainer>` so `pnpm check:layout` invariant
 * (page+loading both use the same variant) holds.
 *
 * Spec 122 US10c (T1022): AURA cards and the AURA pulse skeleton, in the
 * page's own grid — icon tile, title, two description lines, chevron. Four
 * cards, not six: most roles see fewer, so the swap shifts less (UX review M2).
 * `PageSkeletonShell` announces the loading state; the blocks are hidden
 * from assistive tech.
 */
import { getTranslations } from 'next-intl/server';
import { Card } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { PageSkeletonShell, SkeletonBlock } from '@/components/shell/page-skeletons';

export default async function SettingsIndexLoading() {
  const t = await getTranslations('admin.settings.index');
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingPage')}>
      <DetailContainer aria-busy="true">
        <PageHeader title={t('title')} subtitle={t('subtitle')} />
        <ul aria-hidden className="grid gap-[var(--aura-space-4)] md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => (
            <Card key={i} as="li">
              <div className="flex items-start gap-[var(--aura-space-4)]">
                <SkeletonBlock className="size-10 shrink-0 rounded-[var(--aura-radius-md)]" />
                <div className="flex min-w-0 flex-1 flex-col gap-[var(--aura-space-2)]">
                  <SkeletonBlock className="h-5 w-40" />
                  <SkeletonBlock className="h-4 w-full" />
                  <SkeletonBlock className="h-4 w-2/3" />
                </div>
                <SkeletonBlock className="size-4 shrink-0" />
              </div>
            </Card>
          ))}
        </ul>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
