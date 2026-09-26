/**
 * `/portal/sign-in?reason=link_invalid` — where the renewal redeem-link route
 * sends every failure (expired, used, tampered: deliberately not saying which).
 * The page used to ignore the reason, so the member landed on a bare sign-in
 * form with no idea why. It now shows a banner.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
}));
vi.mock('@/lib/auth-session', () => ({
  getCurrentSession: vi.fn().mockResolvedValue(null),
}));
vi.mock('next/navigation', () => ({ redirect: vi.fn() }));
vi.mock('@/components/auth/sign-in-form', () => ({
  SignInForm: () => <form data-testid="sign-in-form" />,
}));
vi.mock('@/components/shell/auth-page-controls', () => ({
  AuthPageControls: () => null,
}));
vi.mock('@/components/shell/brand-mark', () => ({
  BrandMark: () => null,
  CHAMBER_FULL_NAME: 'Thai-Swedish Chamber of Commerce',
}));
vi.mock('@/components/auth/security-update-banner', () => ({
  SecurityUpdateBanner: ({ message }: { message: string }) => (
    <div role="status">{message}</div>
  ),
}));

const { default: MemberSignInPage } = await import(
  '@/app/(auth-public)/portal/sign-in/page'
);

async function renderPage(reason?: string) {
  const ui = await MemberSignInPage({
    searchParams: Promise.resolve(reason === undefined ? {} : { reason }),
  });
  return render(ui);
}

describe('portal sign-in — reason=link_invalid', () => {
  it('shows the "link is no longer valid" banner', async () => {
    await renderPage('link_invalid');
    expect(screen.getByRole('status')).toHaveTextContent('linkInvalidBanner');
  });

  it('shows no banner without a reason', async () => {
    await renderPage();
    expect(screen.queryByRole('status')).toBeNull();
  });
});
