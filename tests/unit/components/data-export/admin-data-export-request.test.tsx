// @vitest-environment jsdom
/**
 * Admin GDPR export for one named contact (PDPA §30 / GDPR Art. 15).
 *
 * The admin card lets staff choose whom the archive is prepared for — the
 * whole company (colleagues by name and role) or one contact, including a
 * former one — sends that choice to the admin route, and labels each past
 * archive with whom it was prepared for.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AdminDataExportRequest } from '@/components/data-export/admin-data-export-request';
import type { DataExportLabels } from '@/components/data-export/data-export-panel';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() } }));

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 202 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const LABELS: DataExportLabels = {
  requestButton: 'Request export',
  requesting: 'Requesting…',
  requestedTitle: 'Requested',
  requestedBody: 'Preparing',
  statusHeading: 'Recent requests',
  empty: 'None yet',
  download: 'Download',
  errorTitle: 'Failed',
  errorBody: 'Try again',
  expiresHint: 'Links expire',
  colStatus: 'Status',
  colRequested: 'Requested',
  caption: 'Recent requests',
  alreadyPending: 'Already preparing',
  colFor: 'Prepared for',
};

const CONTACTS = [
  { contactId: 'c-nils', label: 'Nils Berg — Accountant' },
  { contactId: 'c-gone', label: 'Gone Person — Staff (removed)' },
];

function renderIt(initialContactId?: string) {
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AdminDataExportRequest
        contacts={CONTACTS}
        {...(initialContactId !== undefined ? { initialContactId } : {})}
        rows={[
          {
            jobId: 'j-1',
            status: 'ready',
            statusLabel: 'Ready',
            downloadable: true,
            requestedAt: '29 May 2026',
            forLabel: 'For: Nils Berg',
          },
        ]}
        labels={LABELS}
        baseUrl="/api/admin/members/m-1/data-export"
      />
    </NextIntlClientProvider>,
  );
}

describe('AdminDataExportRequest', () => {
  it('defaults to the whole-company archive and sends no contact', async () => {
    renderIt();
    expect(screen.getByText(en.dataExport.adminScopeCompany)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Request export' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({});
  });

  it('sends the chosen contact to the admin route', async () => {
    renderIt('c-gone');
    fireEvent.click(screen.getByRole('button', { name: 'Request export' }));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/admin/members/m-1/data-export');
    expect(JSON.parse(fetchMock.mock.calls[0]![1].body as string)).toEqual({ subjectContactId: 'c-gone' });
  });

  it('shows whom each past archive was prepared for', () => {
    renderIt();
    expect(screen.getByText('For: Nils Berg')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'Prepared for' })).toBeTruthy();
  });
});
