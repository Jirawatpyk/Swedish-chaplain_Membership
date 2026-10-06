/**
 * Spec 122 US9a (T901) — the events list page's view, shared by the page and
 * the no-DB preview route (`/test-fixtures/aura-admin?view=events`), so the
 * screenshots show the page itself. Board `Admin-events` (+ `-mobile`): the
 * header with "Erase by email" and "Import CSV", then the filters, table and
 * pager in one list card (docs/aura-adoption.md § List card). The page wraps it
 * in its own `TableContainer` (check:layout reads the page file).
 */
import type { ReactNode } from 'react';
import Link from 'next/link';
import { getTranslations } from 'next-intl/server';
import { EraserIcon, UploadCloudIcon } from 'lucide-react';
import { Card, buttonClass } from '@jirawatpyk/aura-react/server';
import { PageHeader } from '@/components/layout/page-header';
import { EventsHeaderMenu } from './events-header-menu';

export const ERASE_BY_EMAIL_HREF = '/admin/events/erasure';

export interface EventsListViewProps {
  /** `events.write`: the "Import CSV" action (the import page and API admit it). */
  readonly canImport: boolean;
  /** `events.erasure`: "Erase by email" (the key its destination page admits). */
  readonly canEraseByEmail: boolean;
  /** The filters, table and pager — or the empty state, or the load error. */
  readonly children: ReactNode;
}

export async function renderEventsListView({ canImport, canEraseByEmail, children }: EventsListViewProps) {
  const t = await getTranslations('admin.events');
  const actions =
    canImport || canEraseByEmail ? (
      <>
        {canEraseByEmail ? (
          <>
            <Link href={ERASE_BY_EMAIL_HREF} className={buttonClass({ variant: 'secondary', className: 'max-sm:hidden' })}>
              <EraserIcon aria-hidden="true" className="size-4" />
              {t('erasure.discoverabilityCta')}
            </Link>
            <EventsHeaderMenu eraseByEmailHref={ERASE_BY_EMAIL_HREF} />
          </>
        ) : null}
        {canImport ? (
          <Link href="/admin/events/import" className={buttonClass({ variant: 'primary', className: 'max-sm:order-first' })}>
            <UploadCloudIcon aria-hidden="true" className="size-4" />
            {t('list.importCsvCta')}
          </Link>
        ) : null}
      </>
    ) : null;

  return (
    <>
      <PageHeader title={t('list.title')} subtitle={t('list.subtitle')} actions={actions} />
      {/* One card on a desktop; on a phone the rows are cards of their own, so
          this one drops its frame and padding (the list-card rule). */}
      <Card flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
        {children}
      </Card>
    </>
  );
}
