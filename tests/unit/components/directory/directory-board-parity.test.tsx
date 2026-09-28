/**
 * 122 US5a — the staff directory as the `Admin-directory` boards draw it: an
 * open-book icon on "Generate E-Book" and a visible "Search" label over the
 * search box (its accessible name stays "Search directory").
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

  it('labels the search box visibly, keeping its accessible name', () => {
    withIntl(<DirectorySearchFilters />);
    expect(screen.getByText(messages.admin.directory.search.fieldLabel)).toBeVisible();
    expect(screen.getByRole('searchbox', { name: messages.admin.directory.search.label })).toBeInTheDocument();
  });
});
