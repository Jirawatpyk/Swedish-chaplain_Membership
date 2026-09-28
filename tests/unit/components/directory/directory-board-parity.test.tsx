/**
 * 122 US5a — the staff directory as the `Admin-directory` boards draw it: an
 * open-book icon on "Generate E-Book". The search box carries no separate
 * visible label: its search icon and hint already say what it is, and its
 * accessible name is "Search directory" (maintainer, 28 Sep).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { DirectorySearchFilters } from '@/components/directory/directory-search-filters';
import { GenerateExportActions } from '@/components/directory/generate-export-actions';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/admin/directory',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function withIntl(ui: React.ReactElement) {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      {ui}
    </NextIntlClientProvider>,
  );
}

describe('directory as on the board (US5a)', () => {
  it('shows an open book on Generate E-Book', () => {
    withIntl(<GenerateExportActions />);
    const ebook = screen.getByRole('button', { name: messages.admin.directory.generate.ebook });
    expect(ebook.querySelector('svg.lucide-book-open')).not.toBeNull();
  });

  it('names the search box without a duplicate visible label over it', () => {
    withIntl(<DirectorySearchFilters />);
    expect(screen.getByRole('searchbox', { name: messages.admin.directory.search.label })).toBeInTheDocument();
    expect(screen.queryByText('Search', { exact: true })).toBeNull();
  });
});
