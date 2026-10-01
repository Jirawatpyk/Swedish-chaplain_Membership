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
import { RecentExports, type RecentExportRow } from '@/components/directory/recent-exports';

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
  listedPill: 'Listed',
  notListedPill: 'Not listed',
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

  it('orders the columns as the board: Company, Tier, Industry, Location, Listed, Logo, Contact', () => {
    render(<DirectoryTable rows={rows} labels={labels} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).toEqual(['Company', 'Tier', 'Industry', 'Location', 'Listed', 'Logo', 'Contact']);
  });

  it('a phone card says "Listed" / "Not listed" as a status pill with its icon (board Admin-directory-mobile)', () => {
    render(<DirectoryTable rows={rows} labels={labels} />);
    const listed = screen.getAllByText('Listed').find((el) => el.closest('.aura-pill'));
    expect(listed?.closest('.aura-pill')).toHaveClass('aura-pill--ready');
    expect(screen.getByText('Not listed').closest('.aura-pill')).toHaveClass('aura-pill--neutral');
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
    // The table's pills (the phone list repeats them below 640px).
    expect(screen.getByText('Ready').closest('.aura-pill')).toHaveClass('aura-pill--ready');
    expect(screen.getAllByText('Generating…')[0]?.closest('.aura-pill')).toHaveClass('aura-pill--progress');
    const [tableLink] = screen.getAllByRole('link', { name: 'Download — Directory JSON, 20 Sep 2026, 16:40' });
    expect(tableLink).toHaveAttribute('href', '/api/admin/directory/exports/j-1/download');
  });

  it('the board layouts: a table with an icon on Download, and a one-line list on a phone', () => {
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
    const links = screen.getAllByRole('link', { name: 'Download — Directory JSON, 20 Sep 2026, 16:40' });
    // One in the table (text + icon), one icon-only in the phone list.
    expect(links).toHaveLength(2);
    expect(links[0]).toHaveTextContent('Download');
    expect(links[0]?.querySelector('svg')).not.toBeNull();
    expect(links[1]).not.toHaveTextContent('Download');
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    // A ready export says its state in the line under the name; the rest keep the pill.
    expect(within(list).getByText(/20 Sep 2026, 16:40 · Ready/)).toBeInTheDocument();
    expect(within(list).getByText('Generating…').closest('.aura-pill')).not.toBeNull();
  });

  it('the table is frameless and centres each row through AURA props (#81), not its classes', () => {
    const { container } = render(
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
        ]}
      />,
    );
    const table = screen.getByRole('table');
    expect(table).toHaveClass('aura-tbl--middle');
    expect(table.closest('.aura-tbl-wrap')).toHaveClass('is-flush');
    // No reach into AURA's table internals is left.
    expect(container.innerHTML).not.toMatch(/\[&amp;_\.aura-tbl/);
  });

  const mixedRows: RecentExportRow[] = [
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
  ];

  // #117 (AURA 5.21.0): a row with Download (32px `sm` button) and a pill-only
  // row come out the same height through AURA's `rowHeight="density"`.
  it('#117: every row follows the density row height through an AURA Table prop', () => {
    render(<RecentExports labels={exportLabels} rows={mixedRows} />);
    expect(screen.getByRole('table')).toHaveClass('aura-tbl--row-density');
  });

  it('sets no row height by hand (AURA owns it, #117)', () => {
    render(<RecentExports labels={exportLabels} rows={mixedRows} />);
    const cells = within(screen.getByRole('table'))
      .getAllByRole('row')
      .flatMap((r) => [r, ...Array.from(r.children)]);
    for (const el of cells) {
      expect(el.className).not.toMatch(/(^|\s)(min-)?h-/);
      expect((el as HTMLElement).style.height).toBe('');
      expect((el as HTMLElement).style.minHeight).toBe('');
    }
  });
});
