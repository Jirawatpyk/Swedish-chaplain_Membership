/**
 * 122 US5b-1 (T553) — the one "member not found" view for the detail page and
 * its timeline and benefits pages (each carried its own copy before). AURA
 * `EmptyState` with a way back to the list; the copy is unchanged.
 */
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ArrowLeftIcon } from 'lucide-react';
import { EmptyState, buttonClass } from '@jirawatpyk/aura-react/server';
import { DetailContainer } from '@/components/layout';

export async function MemberNotFound() {
  const t = await getTranslations('admin.members.detail.notFound');
  return (
    <DetailContainer>
      <EmptyState
        title={t('title')}
        description={t('description')}
        action={
          <Link href="/admin/members" className={buttonClass({ variant: 'secondary' })}>
            <ArrowLeftIcon className="size-4" aria-hidden="true" />
            {t('cta')}
          </Link>
        }
      />
    </DetailContainer>
  );
}
