/**
 * AuthPageControls unit test — renders both header controls.
 * Mocks the client-hook deps of the two child controls.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { AuthPageControls } from '@/components/shell/auth-page-controls';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('next-themes', () => ({ useTheme: () => ({ setTheme: vi.fn() }) }));

afterEach(cleanup);

describe('<AuthPageControls>', () => {
  it('renders both the language switcher and the theme toggle', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <AuthPageControls />
      </NextIntlClientProvider>,
    );
    expect(
      screen.getByRole('button', { name: /change language/i }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /toggle theme/i }),
    ).toBeInTheDocument();
  });
});
