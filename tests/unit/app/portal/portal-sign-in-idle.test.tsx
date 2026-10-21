/**
 * The sign-in reasons — `?reason=` on both sign-in pages. The page reads the
 * allow-listed reason and hands its message to the form, which shows it as a
 * standing notice that describes the email field (so the focused field reads
 * it) and gives way to the error after a failed sign-in.
 *
 * `idle`: the idle warning signed the user out for inactivity (board
 * `Portal-idle-signed-out`). `session-ended`: "Stay signed in" found the
 * session already gone (signed out in another tab, revoked, past its cap).
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
  SignInForm: ({ notice }: { notice?: string }) => (
    <form data-testid="sign-in-form" data-notice={notice ?? ''} />
  ),
}));
vi.mock('@/components/shell/auth-page-controls', () => ({
  AuthPageControls: () => null,
}));
vi.mock('@/components/shell/brand-mark', () => ({
  BrandMark: () => null,
  CHAMBER_FULL_NAME: 'Thai-Swedish Chamber of Commerce',
}));

const { default: MemberSignInPage } = await import('@/app/(auth-public)/portal/sign-in/page');
const { default: StaffSignInPage } = await import('@/app/(auth-public)/admin/sign-in/page');

describe.each([
  ['/portal/sign-in', MemberSignInPage],
  ['/admin/sign-in', StaffSignInPage],
] as const)('%s', (_path, Page) => {
  async function noticeFor(reason?: string) {
    const ui = await Page({ searchParams: Promise.resolve(reason === undefined ? {} : { reason }) });
    render(ui);
    return screen.getByTestId('sign-in-form').getAttribute('data-notice');
  }

  it.each([
    ['idle', 'auth.idleWarning.signedOutInactive'],
    ['session-ended', 'auth.idleWarning.signedOutEnded'],
    ['security-update', 'auth.signIn.securityUpdateBanner'],
  ])('?reason=%s hands the form its notice', async (reason, message) => {
    expect(await noticeFor(reason)).toBe(message);
  });

  it.each([undefined, 'idle-ish', 'IDLE', 'Session-Ended'])('reason %s hands the form no notice', async (reason) => {
    expect(await noticeFor(reason)).toBe('');
  });

  it('?reason=link_invalid is the member page\'s alone — the staff page shows nothing', async () => {
    expect(await noticeFor('link_invalid')).toBe(_path === '/portal/sign-in' ? 'auth.signIn.linkInvalidBanner' : '');
  });

  it('renders no reason banner of its own beside the form (one place for the reason)', async () => {
    const ui = await Page({ searchParams: Promise.resolve({ reason: 'idle' }) });
    render(ui);
    expect(screen.queryByRole('status')).toBeNull();
  });
});
