/**
 * DV-4 — Route-level loading UI for /admin/broadcasts/new.
 *
 * Form-shape skeleton so the transition from the broadcasts queue doesn't
 * flash the parent segment's table-shaped loading.tsx during navigation
 * (FR-007). U12 (#400 PR-B) — it reserved ONE full-width card while the page is
 * the T148 two-column grid (the editor beside the 600 px email preview from
 * `lg` up) with the template picker above it; the shape is now
 * `ComposeFormSkeleton`, shared with the member compose skeleton: member picker
 * → recipients → subject → the message editor → schedule → the action row.
 */
import { getTranslations } from 'next-intl/server';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ComposeFormSkeleton } from '@/components/broadcast/compose-form-skeleton';
import { env } from '@/lib/env';

export default async function Loading(): Promise<React.ReactElement> {
  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} subtitle={t('pageSubtitle')} />
      <ComposeFormSkeleton variant="staff" imageControls={env.features.f71aUs2Images} />
    </DetailContainer>
  );
}
