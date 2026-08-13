import type { Metadata } from 'next';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { FileQuestionIcon } from 'lucide-react';
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
 * The copy is CAUSE-NEUTRAL, and that is the correction the final review forced.
 * There are 71 `notFound()` calls under `/admin/**` and this one boundary
 * catches all of them: unknown record ids, archived rows, feature-flag-off
 * pages, cross-tenant probes — and permission denials. The first version said
 * "some staff surfaces need a higher role than yours", which is wrong for most
 * of them and actively confusing for the case it is worst at: a SUPER_ADMIN
 * opening a stale link to a deleted invoice was told to go ask a super admin.
 *
 * So the body names the three real causes and points at the likeliest one — a
 * stale link — and the role hint is a separate, softer line. Still no
 * enumeration of which pages are restricted: `notFound()` is the deny shape for
 * unknown-id probes too, so naming them would turn every stray 404 into a
 * disclosure.
 */
// Static, so it cannot be localised here (generateMetadata would make this a
// dynamic segment for a boundary that must stay cheap). Kept deliberately
// generic — the browser tab is not where the explanation belongs.
export const metadata: Metadata = {
  title: 'Not available',
};

export default async function StaffNotFound() {
  const t = await getTranslations('admin.notFound');
  return (
    <DetailContainer>
      <PageHeader title={t('title')} />
      <EmptyState
        icon={FileQuestionIcon}
        title={t('body')}
        description={t('roleHint')}
        action={
          <Link href="/admin" className={buttonVariants()}>
            {t('back')}
          </Link>
        }
      />
    </DetailContainer>
  );
}
