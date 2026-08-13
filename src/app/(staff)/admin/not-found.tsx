import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { ShieldAlertIcon } from 'lucide-react';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { EmptyState } from '@/components/shell/empty-state';
import { buttonVariants } from '@/components/ui/button';

/**
 * Staff-shell not-found boundary (016 review, UX H).
 *
 * `requirePagePermission` denies with `notFound()`, and until this file existed
 * there was no `not-found.tsx` anywhere under `src/app/(staff)/` — so a denial
 * rendered Next.js's built-in "404 — This page could not be found": no
 * localisation, no branding, no way back, outside the admin shell entirely.
 *
 * That became a real support path when D4 narrowed `users.manage`,
 * `audit.read`, `settings.invoicing` and the erasure keys to super_admin. An
 * administrator who used /admin/audit last week, following a bookmark or a link
 * in a runbook, lands on a bare framework 404 and reasonably concludes the
 * system is broken.
 *
 * The sidebar stays SILENT about surfaces the viewer cannot open — a greyed
 * "Users 🔒" row would be permanent nav clutter and would advertise the
 * elevation target to anyone looking over the operator's shoulder. The right
 * place to explain is the destination, which is only reached deliberately.
 *
 * The copy names no specific surface. `notFound()` is also the deny shape for
 * cross-tenant and unknown-id probes, and this boundary catches those too; a
 * message enumerating the super-admin-only pages would turn every stray 404
 * into a disclosure. "Some staff surfaces need a higher role" tells an
 * authenticated operator what they need to know — the product documents which
 * pages exist — without confirming anything about the id they typed.
 */
export const metadata: Metadata = {
  title: 'Not available',
};

export default async function StaffNotFound() {
  const t = await getTranslations('admin.notFound');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      <EmptyState
        icon={ShieldAlertIcon}
        title={t('body')}
        action={
          <Link href="/admin" className={buttonVariants()}>
            {t('back')}
          </Link>
        }
      />
    </DetailContainer>
  );
}
