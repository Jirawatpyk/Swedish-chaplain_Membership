/**
 * Spec 122 US1 — the staff frame keeps `<main id="main-content">` focusable
 * (`tabindex="-1"`), as the legacy layout did: skip-link targets and every
 * "focus the page after this row left" fallback (`focusMainContent()` in the
 * user list, the change-request banner, the E-Blast bulk bar, …) call
 * `.focus()` on it, which is a no-op on a plain `<main>`.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { StaffShell } from '@/components/layout/staff-shell';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));

afterEach(() => cleanup());

describe('StaffShell (spec 122 US1)', () => {
  it('renders <main id="main-content"> that can take focus', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <StaffShell
          nav={{ tenantName: 'SweCham', allowedHrefs: ['/admin'] }}
          user={{ displayName: 'Malin Berg', email: 'malin@example.com', role: 'admin' }}
        >
          <p>Page</p>
        </StaffShell>
      </NextIntlClientProvider>,
    );
    const main = document.getElementById('main-content');
    expect(main?.tagName).toBe('MAIN');
    expect(main).toHaveAttribute('tabindex', '-1');
    main!.focus();
    expect(main).toHaveFocus();
  });
});
