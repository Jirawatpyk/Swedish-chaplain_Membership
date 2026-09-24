// @vitest-environment jsdom
/**
 * F119 T086a V6 — `/portal/broadcasts/[id]`'s not-found state printed the SAME
 * sentence twice: `errors.notFound` was both the `<h2>` and the paragraph under
 * it. It now has a title and a body of its own, in EN + TH + SV.
 *
 * The body must not tell "absent" from "someone else's" — the page 404s both
 * alike (anti-enumeration, see the file's docblock).
 */
import { describe, expect, it, vi } from 'vitest';
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

describe('portal E-Blast not-found (T086a V6)', () => {
  it('renders a title and a DIFFERENT body, each from its own key', async () => {
    const { default: NotFound } = await import('@/app/(member)/portal/broadcasts/[id]/not-found');
    render(await NotFound());

    const state = screen.getByTestId('broadcast-not-found');
    const title = state.querySelector('h2')!;
    const body = state.querySelector('p')!;
    expect(title).toHaveTextContent('portal.broadcasts.detail.notFound.title');
    expect(body).toHaveTextContent('portal.broadcasts.detail.notFound.body');
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
