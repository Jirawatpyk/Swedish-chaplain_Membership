/**
 * `/portal/sign-in?reason=idle` — where the idle warning sends a member it
 * signed out for inactivity. The reason used to be a toast, which closed
 * itself while the member was away; the sign-in card now says it and keeps
 * saying it (board `Portal-idle-signed-out`).
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => (key: string) => `${ns}.${key}`),
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
  SecurityUpdateBanner: ({ message }: { message: string }) => <div role="status">{message}</div>,
}));

const { default: MemberSignInPage } = await import('@/app/(auth-public)/portal/sign-in/page');
const { default: StaffSignInPage } = await import('@/app/(auth-public)/admin/sign-in/page');

const IDLE = 'auth.idleWarning.signedOutInactive';

describe.each([
  ['/portal/sign-in', MemberSignInPage],
  ['/admin/sign-in', StaffSignInPage],
] as const)('%s', (_path, Page) => {
  async function renderPage(reason?: string) {
    const ui = await Page({ searchParams: Promise.resolve(reason === undefined ? {} : { reason }) });
    render(ui);
  }

  it('?reason=idle says the user was signed out for inactivity', async () => {
    await renderPage('idle');
    expect(screen.getByRole('status').textContent).toBe(IDLE);
  });

  it.each([undefined, 'idle-ish', 'IDLE'])('reason %s shows no inactivity banner', async (reason) => {
    await renderPage(reason);
    expect(screen.queryByText(IDLE)).toBeNull();
  });
});
