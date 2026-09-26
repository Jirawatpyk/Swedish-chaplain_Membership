/**
 * Spec 122 US2 T201 — the auth frame (`Sign-in`, `Admin-sign-in`, `Auth-*`
 * boards): from 1024px a mesh brand panel beside the form column; below
 * 1024px the brand sits above the form and there is no mesh. The page's own
 * title is the only h1, and the language and colour-scheme controls stay.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AuthFrame } from '@/components/auth/auth-frame';

vi.mock('next/navigation', () => ({
  usePathname: () => '/admin/sign-in',
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next-themes', () => ({ useTheme: () => ({ theme: 'system', setTheme: vi.fn() }) }));

function renderFrame() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <AuthFrame title="Sign in" description="Staff portal" portalLabel="Staff portal" tenantName="SweCham">
        <p>Form</p>
      </AuthFrame>
    </NextIntlClientProvider>,
  );
}

afterEach(() => cleanup());

describe('AuthFrame (spec 122 US2)', () => {
  it('is the page landmark with the page title as its only h1, the form below it', () => {
    renderFrame();
    const main = screen.getByRole('main');
    expect(main).toHaveAttribute('id', 'main-content');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading.parentElement).toHaveTextContent('Staff portal');
    expect(within(main).getByText('Form')).toBeInTheDocument();
  });

  it('draws the mesh brand panel from 1024px only: tenant, chamber name and portal', () => {
    const { container } = renderFrame();
    const panel = container.querySelector('.aura-mesh');
    expect(panel).not.toBeNull();
    expect(panel).toHaveClass('aura-surface', 'aura-grain', 'max-lg:hidden');
    expect(panel).toHaveTextContent('SweCham');
    expect(panel).toHaveTextContent('Thai-Swedish Chamber of Commerce');
    expect(panel).toHaveTextContent('Staff portal');
  });

  it('puts the brand above the form below 1024px, without the mesh', () => {
    const { container } = renderFrame();
    const phoneBrand = container.querySelector('[data-slot="auth-brand-compact"]');
    expect(phoneBrand).not.toBeNull();
    expect(phoneBrand).toHaveClass('lg:hidden');
    expect(phoneBrand?.closest('.aura-mesh')).toBeNull();
    expect(phoneBrand).toHaveTextContent('SweCham');
  });

  it('keeps the language and colour-scheme controls', () => {
    renderFrame();
    expect(screen.getByRole('button', { name: /change language/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Toggle theme' })).toBeInTheDocument();
  });
});
