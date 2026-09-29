/**
 * 122 US5a — the members filters as the `Admin-members` boards draw them:
 * the needs-invite chip carries a plain envelope, and a phone gets a shorter
 * placeholder that fits the box. No separate visible label over the search:
 * its icon and hint already say what it is (maintainer, 28 Sep).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import messages from '@/i18n/messages/en.json';
import { DirectoryFilters } from '@/components/members/directory-filters';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/admin/members',
  useSearchParams: () => new URLSearchParams(),
}));

const D = messages.admin.members.directory;

function phone(matches: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => vi.unstubAllGlobals());

function renderFilters() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <DirectoryFilters plans={[]} portalInviteCount={7} />
    </NextIntlClientProvider>,
  );
}

describe('members filters as on the board (US5a)', () => {
  it('puts a plain envelope on the needs-invite chip', () => {
    phone(false);
    renderFilters();
    const chip = screen.getByRole('button', { name: new RegExp(D.portalChip.label.split(' ')[0]!, 'i') });
    expect(chip.querySelector('svg.lucide-mail')).not.toBeNull();
  });

  it('names the search box without a duplicate visible label over it', () => {
    phone(true);
    renderFilters();
    expect(screen.getByRole('searchbox', { name: D.searchSrLabel })).toBeInTheDocument();
    expect(screen.queryByText(D.searchSrLabel)).toBeNull();
  });

  it('uses the short placeholder on a phone and the full one on wider screens', () => {
    phone(true);
    const { unmount } = renderFilters();
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', D.searchPlaceholderShort);
    unmount();
    phone(false);
    renderFilters();
    expect(screen.getByRole('searchbox')).toHaveAttribute('placeholder', D.searchPlaceholder);
  });
});
