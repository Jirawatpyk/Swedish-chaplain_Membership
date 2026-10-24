/**
 * Spec 122 US12d-1 (T1233) — the compose routes' frames on AURA:
 *   - staff `/admin/broadcasts/new` error: the shared `RouteErrorPanel` under
 *     the page's own title (T155 U10), with a working Retry;
 *   - member `/portal/broadcasts/new` error: the "back to E-Blasts" escape is
 *     an AURA button link;
 *   - member `/portal/broadcasts/new` loading: the header bars are the shared
 *     skeleton blocks, not the legacy kit's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('@/lib/env', () => ({
  env: { features: { f71aUs2Images: true } },
}));

import AdminComposeError from '@/app/(staff)/admin/broadcasts/new/error';
import PortalComposeError from '@/app/(member)/portal/broadcasts/new/error';
import PortalComposeLoading from '@/app/(member)/portal/broadcasts/new/loading';

let errSpy: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
});

const withIntl = (ui: React.ReactElement) => (
  <NextIntlClientProvider locale="en" messages={en}>
    {ui}
  </NextIntlClientProvider>
);

describe('compose route frames on AURA', () => {
  it('staff compose error: RouteErrorPanel under the page title, with a working Retry', () => {
    const reset = vi.fn();
    const error = Object.assign(new Error('boom'), { digest: 'abc123' });
    render(withIntl(<AdminComposeError error={error} reset={reset} />));
    expect(
      screen.getByRole('heading', { name: en.admin.broadcasts.proxySubmitDialog.title }),
    ).toBeInTheDocument();
    expect(screen.getByRole('alert').querySelector('.aura-empty')).not.toBeNull();
    expect(screen.getByText(/abc123/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: en.buttons.retry }));
    expect(reset).toHaveBeenCalledTimes(1);
  });

  it('member compose error: the back link to the E-Blast tab is an AURA button', () => {
    const error = Object.assign(new Error('boom'), { digest: 'abc123' });
    render(withIntl(<PortalComposeError error={error} reset={vi.fn()} />));
    const back = screen.getByRole('link', { name: en.portal.broadcasts.detail.back });
    expect(back).toHaveAttribute('href', '/portal/benefits?tab=broadcasts');
    expect(back).toHaveClass('aura-btn', 'aura-btn--secondary', 'aura-btn--touch');
  });

  it('member compose loading: the header bars are the shared skeleton blocks', () => {
    const { container } = render(<PortalComposeLoading />);
    const header = container.querySelector('header')!;
    expect(header.querySelectorAll('[data-slot="skeleton-block"]')).toHaveLength(2);
    expect(header.querySelector('[data-slot="skeleton"]')).toBeNull();
  });
});
