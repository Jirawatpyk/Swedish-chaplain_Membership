/**
 * T098 — /admin/events/import — CSV bulk-import admin page (F6 Phase 7).
 *
 * Server component. Admin-only via `requireAdminContext` (F1 RBAC).
 * Renders the `<CsvMappingForm>` client component in the form column
 * (`FormContainer`, 720px, start-aligned), header included, as the
 * `Admin-events-import` board draws it (spec 122 US9b-2 parity, decided
 * 2026-10-09). The CSV preview table scrolls inside its own region, so
 * the narrow column no longer cramps it (the reason UX-R1.1 had moved
 * the page to `TableContainer` on 2026-05-18).
 *
 * Feature-flag gated by `env.features.f6EventCreate`: when off,
 * `notFound()` returns 404. Mirrors the surface-disclosure pattern
 * established by other F6 admin pages.
 */
import { notFound } from 'next/navigation';
import { getTranslations } from 'next-intl/server';
import Link from 'next/link';
import { env } from '@/lib/env';
import { requirePagePermission } from '@/lib/rbac';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { Icon, buttonClass } from '@jirawatpyk/aura-react/server';
import { CsvMappingForm } from '@/components/events/csv-mapping-form';

export default async function CsvImportPage() {
  if (!env.features.f6EventCreate) {
    notFound();
  }
  // Admin-only — manager + member return 404 (surface disclosure) per
  // FR-035. Mirrors Phase 4 /admin/events/page.tsx pattern.
  await requirePagePermission('events.write');

  const t = await getTranslations('admin.events.import');
  return (
    <FormContainer align="start">
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
            className={buttonClass({ variant: 'secondary' })}
          >
            <Icon name="clock" />
            {t('viewHistory')}
          </Link>
        }
      />
      <CsvMappingForm />
    </FormContainer>
  );
}
