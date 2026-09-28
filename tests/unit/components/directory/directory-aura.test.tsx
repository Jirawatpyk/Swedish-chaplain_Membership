/**
 * 122 US5a (T506) — the member directory on AURA (board `Admin-directory`).
 *
 * - The results are an AURA DataTable grid named after the caption; the
 *   company name links to the member; "Listed" is a text badge (not colour
 *   alone — WCAG 1.4.1).
 * - Recent exports show their status as an AURA StatusPill and keep the
 *   contextual download label (WCAG 2.4.6).
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { DirectoryTable, type DirectoryTableRow } from '@/components/directory/directory-table';
import { RecentExports } from '@/components/directory/recent-exports';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn() }),
  usePathname: () => '/admin/directory',
  useSearchParams: () => new URLSearchParams(),
}));

afterEach(cleanup);

const labels = {
  caption: 'Members and their directory listing status',
  company: 'Company',
  tier: 'Tier',
  industry: 'Industry',
  location: 'Location',
  listed: 'Listed',
  logo: 'Logo',
  contact: 'Contact',
  hasLogo: 'Has logo',
  yes: 'Yes',
  no: 'No',
  emptyTitle: 'No members found',
  empty: 'Try adjusting your search or filters.',
};

const rows: DirectoryTableRow[] = [
  {
    memberId: 'm-1',
    companyName: 'Andaman Marine Tech Co., Ltd.',
    tier: 'Diamond Partnership',
    industry: 'Marine engineering',
    location: 'Phuket, TH',
    listed: true,
    hasLogo: true,
    contactName: 'Karin Lund',
  },
  {
    memberId: 'm-2',
    companyName: 'Kiruna Mining Services',
    tier: null,
    industry: null,
    location: null,
    listed: false,
    hasLogo: false,
    contactName: null,
  },
];

describe('DirectoryTable on AURA DataTable (T506)', () => {
  it('renders a named grid with the company as the row link', () => {
    render(<DirectoryTable rows={rows} labels={labels} />);
    const grid = screen.getByRole('grid', { name: labels.caption });
    expect(within(grid).getByRole('link', { name: 'Andaman Marine Tech Co., Ltd.' })).toHaveAttribute(
      'href',
      '/admin/members/m-1',
    );
  });

  it('shows "Listed" as an AURA text badge, Yes and No', () => {
    render(<DirectoryTable rows={rows} labels={labels} />);
    const yes = screen.getByText('Yes').closest('.aura-badge');
    const no = screen.getAllByText('No').map((el) => el.closest('.aura-badge')).find(Boolean);
    expect(yes).toHaveClass('aura-badge--success');
    expect(no).toHaveClass('is-outline');
  });

  it('shows the empty state when there are no rows', () => {
    render(<DirectoryTable rows={[]} labels={labels} />);
    expect(screen.getByText(labels.emptyTitle)).toBeInTheDocument();
  });
});

describe('RecentExports on AURA (T506)', () => {
  const exportLabels = {
    heading: 'Recent exports',
    empty: 'No exports yet.',
    caption: 'Recently generated directory exports',
    kindLabel: 'Type',
    statusLabel: 'Status',
    requestedLabel: 'Requested',
    download: 'Download',
  };

  it('shows each status as an AURA StatusPill and a contextual download', () => {
    render(
      <RecentExports
        labels={exportLabels}
        rows={[
          {
            jobId: 'j-1',
            kindLabel: 'Directory JSON',
            status: 'ready',
            statusLabel: 'Ready',
            downloadable: true,
            requestedAt: '20 Sep 2026, 16:40',
          },
          {
            jobId: 'j-2',
            kindLabel: 'Directory E-Book (PDF)',
            status: 'processing',
            statusLabel: 'Generating…',
            downloadable: false,
            requestedAt: '24 Sep 2026, 10:12',
          },
        ]}
      />,
    );
    expect(screen.getByText('Ready').closest('.aura-pill')).toHaveClass('aura-pill--ready');
    expect(screen.getByText('Generating…').closest('.aura-pill')).toHaveClass('aura-pill--progress');
    expect(
      screen.getByRole('link', { name: 'Download — Directory JSON, 20 Sep 2026, 16:40' }),
    ).toHaveAttribute('href', '/api/admin/directory/exports/j-1/download');
  });
});
