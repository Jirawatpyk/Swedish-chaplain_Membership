/**
 * DV-4 — /admin/broadcasts/new admin proxy-compose page.
 *
 * Admin-only surface for composing + queueing a broadcast on a member's
 * behalf (Q12). The proxy-submit route enforces admin-only at the API
 * level; this page guard prevents manager (and member) from *seeing* the
 * compose surface. `requireSession('staff')` admits both admin + manager,
 * so the explicit `role !== 'admin' → notFound()` is required to exclude
 * manager (mirrors `admin/members/new/page.tsx`).
 */

import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { ProxyComposeForm } from '@/components/broadcast/proxy-compose-form';
import { requireSession } from '@/lib/auth-session';

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');
  return { title: t('title') };
}

export default async function AdminProxyComposePage(): Promise<React.ReactElement> {
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') notFound();

  const t = await getTranslations('admin.broadcasts.proxySubmitDialog');

  return (
    <FormContainer>
      <PageHeader title={t('title')} subtitle={t('pageSubtitle')} />
      <ProxyComposeForm />
    </FormContainer>
  );
}
