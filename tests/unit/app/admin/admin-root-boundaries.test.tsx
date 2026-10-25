/**
 * Spec 122 US12d-1 (T1232) — the staff root boundaries on AURA: the
 * `/admin/**` error boundary shows the shared `RouteErrorPanel` (generic
 * copy, error id, a working Retry), and the staff not-found boundary keeps
 * its cause-neutral copy with the way back as an AURA button link.
 *
 * An unmatched `/admin/*` URL never reached that page: a segment
 * `not-found.tsx` only catches `notFound()`, so Next served its bare 404
 * (R84). The staff catch-all answers `notFound()` for those URLs, the way
 * `portal/[...unknown]` does for the portal.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

const notFound = vi.hoisted(() =>
  vi.fn((): never => {
    throw new Error('NEXT_HTTP_ERROR_FALLBACK;404');
  }),
);
vi.mock('next/navigation', () => ({ notFound }));

vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn(async (ns: string) => (key: string) => `${ns}.${key}`),
}));

import AdminError from '@/app/(staff)/admin/error';
import StaffNotFound from '@/app/(staff)/admin/not-found';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

describe('staff root error boundary', () => {
  it('renders the shared AURA RouteErrorPanel with the error id and a working Retry', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'd1g3st' });
    render(
      <NextIntlClientProvider locale="en" messages={en}>
        <AdminError error={error} reset={reset} />
      </NextIntlClientProvider>,
    );
    const alert = screen.getByRole('alert');
    expect(alert.querySelector('.aura-empty')).not.toBeNull();
    expect(screen.getByText(/d1g3st/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.buttons.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });
});

describe('staff not-found boundary', () => {
  it('keeps the cause-neutral copy and links back to /admin as an AURA button', async () => {
    render(await StaffNotFound());
    expect(screen.getByText('admin.notFound.body')).toBeInTheDocument();
    expect(screen.getByText('admin.notFound.roleHint')).toBeInTheDocument();
    const back = screen.getByRole('link', { name: 'admin.notFound.back' });
    expect(back).toHaveAttribute('href', '/admin');
    expect(back).toHaveClass('aura-btn');
  });
});

describe('an unknown /admin/* route', () => {
  it('is caught by the staff catch-all, which answers notFound()', async () => {
    const { default: UnknownStaffRoute } = await import('@/app/(staff)/admin/[...unknown]/page');
    expect(() => UnknownStaffRoute()).toThrow('NEXT_HTTP_ERROR_FALLBACK;404');
    expect(notFound).toHaveBeenCalledTimes(1);
  });
});
