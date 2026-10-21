// @vitest-environment jsdom
/**
 * F119 T086a V6 — `/portal/broadcasts/[id]`'s not-found state printed the SAME
 * sentence twice: `errors.notFound` was both the `<h2>` and the paragraph under
 * it. It now has a title and a body of its own, in EN + TH + SV.
 *
 * The body must not tell "absent" from "someone else's" — the page 404s both
 * alike (anti-enumeration, see the file's docblock).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';

vi.mock('next/link', () => ({
  default: ({ children, href, className }: { children?: React.ReactNode; href: string; className?: string }) => (
    <a href={href} className={className}>
      {children}
    </a>
  ),
}));
// Echo the full key, so the test reads WHICH key each element renders.
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string) => `${ns}.${key}`),
}));

// The Back link follows the member's standing, as the page's does (UX review
// M5): a terminated member cannot open the E-Blast list, so theirs leads home.
const getCurrentSessionMock = vi.hoisted(() => vi.fn());
const findByLinkedUserIdMock = vi.hoisted(() => vi.fn());
const loadMembershipAccessMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/auth-session', () => ({ getCurrentSession: getCurrentSessionMock }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromRequest: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/modules/members/members-deps', () => ({
  buildMembersDeps: () => ({ memberRepo: { findByLinkedUserId: findByLinkedUserIdMock } }),
}));
vi.mock('@/lib/load-membership-access', () => ({ loadMembershipAccess: loadMembershipAccessMock }));
const loggerWarnMock = vi.hoisted(() => vi.fn());
vi.mock('@/lib/logger', () => ({ logger: { warn: loggerWarnMock, error: vi.fn(), debug: vi.fn() } }));

beforeEach(() => {
  getCurrentSessionMock.mockReset().mockResolvedValue({ user: { id: 'user-1', role: 'member' } });
  findByLinkedUserIdMock.mockReset().mockResolvedValue({ ok: true, value: { memberId: 'member-1' } });
  loadMembershipAccessMock.mockReset().mockResolvedValue({ access: 'full' });
  loggerWarnMock.mockReset();
});

async function backLink() {
  const { default: NotFound } = await import('@/app/(member)/portal/broadcasts/[id]/not-found');
  render(await NotFound());
  return screen.getByTestId('broadcast-not-found').querySelector('a')!;
}

describe('portal E-Blast not-found (T086a V6)', () => {
  it('renders a title and a DIFFERENT body, each from its own key', async () => {
    const { default: NotFound } = await import('@/app/(member)/portal/broadcasts/[id]/not-found');
    render(await NotFound());

    const state = screen.getByTestId('broadcast-not-found');
    const title = state.querySelector('h2')!;
    const body = state.querySelector('p')!;
    expect(title).toHaveTextContent('portal.broadcasts.detail.notFound.title');
    expect(body).toHaveTextContent('portal.broadcasts.detail.notFound.body');
    // Spec 122 US12c-2 — the way back is an AURA button on the AURA surface.
    expect(state.querySelector('a')?.className).toContain('aura-btn');
    expect(state.className).toContain('--aura-border-default');
  });

  it.each([
    ['full', '/portal/benefits?tab=broadcasts', 'portal.broadcasts.detail.back'],
    ['suspended', '/portal/benefits?tab=broadcasts', 'portal.broadcasts.detail.back'],
    ['terminated', '/portal', 'portal.broadcasts.detail.backToDashboard'],
  ])('a %s member goes back to %s', async (access, href, label) => {
    loadMembershipAccessMock.mockResolvedValue({ access });
    const link = await backLink();
    expect(link).toHaveAttribute('href', href);
    expect(link).toHaveTextContent(label);
    expect(loadMembershipAccessMock).toHaveBeenCalledWith('tenant-a', 'member-1');
  });

  it.each([
    ['no session', () => getCurrentSessionMock.mockResolvedValue(null)],
    ['no member row', () => findByLinkedUserIdMock.mockResolvedValue({ ok: false, error: { code: 'repo.not_found' } })],
    ['a failing read', () => findByLinkedUserIdMock.mockRejectedValue(new Error('db down'))],
  ])('with %s it falls back to the E-Blast list', async (_case, arrange) => {
    arrange();
    const link = await backLink();
    expect(link).toHaveAttribute('href', '/portal/benefits?tab=broadcasts');
    expect(link).toHaveTextContent('portal.broadcasts.detail.back');
  });

  it('a failing read is logged (error kind only), not swallowed', async () => {
    findByLinkedUserIdMock.mockRejectedValue(new TypeError('db down'));
    await backLink();
    expect(loggerWarnMock).toHaveBeenCalledWith(
      { err: 'TypeError' },
      'broadcasts.detail_not_found.back_link_fallback',
    );
  });

  it.each([
    ['en', en],
    ['th', th],
    ['sv', sv],
  ])('%s carries both keys, and they differ', (_, messages) => {
    const notFound = (messages.portal.broadcasts.detail as { notFound?: { title?: string; body?: string } }).notFound;
    expect(notFound?.title).toBeTruthy();
    expect(notFound?.body).toBeTruthy();
    expect(notFound?.title).not.toBe(notFound?.body);
  });
});
