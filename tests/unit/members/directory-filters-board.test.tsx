/**
 * 122 US5a — the members filters as the `Admin-members` boards draw them:
 * the needs-invite chip carries a plain envelope, and a phone shows a visible
 * "Search members" label over a shorter placeholder that fits the box.
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

  it('labels the search visibly on a phone only', () => {
    phone(true);
    renderFilters();
    const label = screen.getByText(D.searchSrLabel);
    expect(label).toHaveClass('sm:hidden');
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
