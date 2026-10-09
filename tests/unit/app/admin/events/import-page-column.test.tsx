/**
 * Spec 122 US9b-2 parity (decided 2026-10-09, comment "ปุ่มเลยมาไหม"): the
 * import page is one 720px form column, as the `Admin-events-import` board
 * draws it — the header's "View import history" ends at the card's edge
 * instead of the far edge of a wide table container.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
}));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/env', () => ({ env: { features: { f6EventCreate: true } } }));
vi.mock('@/lib/rbac', () => ({ requirePagePermission: vi.fn().mockResolvedValue(undefined) }));
vi.mock('@/components/events/csv-mapping-form', () => ({
  CsvMappingForm: () => <div data-testid="csv-mapping-form-stub" />,
}));

import CsvImportPage from '@/app/(staff)/admin/events/import/page';

describe('/admin/events/import page column', () => {
  it('renders the header and the form inside the form (720px) container', async () => {
    const html = renderToStaticMarkup(await CsvImportPage());
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const column = doc.querySelector('[data-slot="layout-container"]');
    expect(column?.getAttribute('data-variant')).toBe('form');
    expect(column?.querySelector('[data-testid="csv-mapping-form-stub"]')).not.toBeNull();
    expect(column?.querySelector('a[href="/admin/events/import/history"]')).not.toBeNull();
  });
});
