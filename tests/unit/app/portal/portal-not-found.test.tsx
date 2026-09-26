// @vitest-environment jsdom
/**
 * Portal error states #3 — a portal 404 stays inside the portal.
 *
 * There was no `not-found.tsx` at the portal root and no catch-all route, so
 * an unmatched `/portal/*` URL — and every `notFound()` from `change-requests`,
 * `profile/directory`, `account`, `account/data-export` and `renewal/**` —
 * fell through to Next.js's built-in English-only "404 — This page could not be
 * found", outside the member shell, with no way back.
 *
 * Also pins the one-line fix in `broadcasts/[id]/not-found.tsx`, which printed
 * `errors.notFound` as its heading AND its paragraph.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import enMessages from '@/i18n/messages/en.json';

type Messages = Record<string, unknown>;

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>(
      (acc, k) => (acc && typeof acc === 'object' ? (acc as Messages)[k] : undefined),
      obj,
    );
}

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string): string => {
    const val = getPath(getPath(enMessages as unknown, ns), key);
    return typeof val === 'string' ? val : `MISSING_KEY:${ns}.${key}`;
  }),
}));

const notFound = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  }),
);
vi.mock('next/navigation', () => ({ notFound }));

afterEach(() => {
  cleanup();
  notFound.mockClear();
});

describe('an unknown /portal/* route', () => {
  it('is caught by the portal catch-all, which answers notFound()', async () => {
    const { default: UnknownPortalRoute } = await import(
      '@/app/(member)/portal/[...unknown]/page'
    );

    expect(() => UnknownPortalRoute()).toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(notFound).toHaveBeenCalledTimes(1);
  });

  it('renders the portal not-found page: title, body and a way back', async () => {
    const { default: PortalNotFound } = await import('@/app/(member)/portal/not-found');
    render(await PortalNotFound());

    expect(
      screen.getByRole('heading', { name: "We couldn't find what you were looking for." }),
    ).toBeInTheDocument();
    expect(screen.getByText('The link may be old, or the page was moved.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveAttribute(
      'href',
      '/portal',
    );
    expect(document.body.textContent).not.toContain('MISSING_KEY');
  });

  it('is an AURA empty state whose way back is an AURA button link (spec 122 US3)', async () => {
    const { default: PortalNotFound } = await import('@/app/(member)/portal/not-found');
    render(await PortalNotFound());

    expect(screen.getByTestId('portal-not-found')).toHaveClass('aura-empty');
    expect(screen.getByRole('link', { name: 'Back to dashboard' })).toHaveClass('aura-btn', 'aura-btn--primary');
  });
});

describe('broadcast detail not-found', () => {
  it('says "not found" once, not as heading and paragraph', async () => {
    const { default: BroadcastNotFound } = await import(
      '@/app/(member)/portal/broadcasts/[id]/not-found'
    );
    render(await BroadcastNotFound());

    // F119 T086a V6 fixed the same duplicate on the F119 branch with the
    // E-Blast's own keys (#388 used `errors.notFoundHint`); the merge kept
    // those, so this pins the heading once and a distinct body under it.
    const detail = enMessages.portal.broadcasts.detail.notFound;
    expect(detail.title).not.toBe(detail.body);
    expect(screen.getAllByText(detail.title)).toHaveLength(1);
    expect(screen.getByRole('heading', { name: detail.title })).toBeInTheDocument();
    expect(screen.getByText(detail.body)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('MISSING_KEY');
  });
});
