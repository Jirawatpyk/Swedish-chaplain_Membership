/**
 * T098 — /admin/events/import — CSV bulk-import admin page (F6 Phase 7).
 *
 * Server component. Admin-only via `requireAdminContext` (F1 RBAC).
 * Renders the `<CsvMappingForm>` client component inside the
 * project's `TableContainer` (96rem, content-type "wide data preview"
 * per ux-standards.md §18). Migrated UX-R1.1 2026-05-18 from
 * `FormContainer` (42rem) because the CSV preview table renders
 * natively at ~4480px and was visibly cramped in a 672px container.
 * `PageHeader` primitive.
 *
 * Feature-flag gated by `env.features.f6EventCreate`: when off,
 * `notFound()` returns 404. Mirrors the surface-disclosure pattern
 * established by other F6 admin pages.
 */
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { env } from '@/lib/env';
import { requireSession } from '@/lib/auth-session';
import { TableContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { buttonVariants } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { CsvMappingForm } from '@/components/events/csv-mapping-form';

export default async function CsvImportPage() {
  if (!env.features.f6EventCreate) {
    notFound();
  }
  // Admin-only — manager + member return 404 (surface disclosure) per
  // FR-035. Mirrors Phase 4 /admin/events/page.tsx pattern.
  const { user } = await requireSession('staff');
  if (user.role !== 'admin') {
    notFound();
  }

  const t = await getTranslations('admin.events.import');
  return (
    <TableContainer>
      <PageHeader
        title={t('pageTitle')}
        subtitle={t('pageSubtitle')}
        actions={
          // Nav-orphans follow-up: the CSV import-history viewer
          // (`/admin/events/import/history`) existed but had no visible
          // link into it from the import form — palette-only. Mirrors the
          // history page's own "Back to import" action button style.
          <Link
            href="/admin/events/import/history"
            className={cn(buttonVariants({ variant: 'outline' }))}
          >
            {t('viewHistory')}
          </Link>
        }
      />
      <CsvMappingForm />
    </TableContainer>
  );
}
