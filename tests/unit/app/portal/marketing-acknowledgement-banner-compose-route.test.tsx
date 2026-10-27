// @vitest-environment jsdom
/**
 * Spec 122 PR C — the compose page states the E-Blast sending rules itself,
 * so the portal-wide acknowledgement banner stays out of it: the rules are
 * never shown twice on one page. Every other portal page is unchanged.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AcknowledgementBannerClient } from '@/app/(member)/portal/_components/marketing-acknowledgement-banner-client';

const pathname = vi.hoisted(() => ({ current: '/portal/benefits' }));
vi.mock('next/navigation', () => ({ usePathname: () => pathname.current }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => cleanup());

const copy = en.portal.broadcasts.banner.acknowledgement;

function renderBanner(): void {
  render(
    <NextIntlClientProvider locale="en" messages={en as Record<string, unknown>}>
      <AcknowledgementBannerClient
        title={copy.title}
        body={copy.body}
        acknowledge={copy.acknowledge}
        remindLater={copy.remindLater}
        locale="en"
      />
    </NextIntlClientProvider>,
  );
}

describe('the portal acknowledgement banner on the compose page', () => {
  it('is not shown on /portal/broadcasts/new', () => {
    pathname.current = '/portal/broadcasts/new';
    renderBanner();
    expect(screen.queryByTestId('broadcasts-acknowledge-banner')).toBeNull();
  });

  it.each(['/portal/benefits', '/portal', '/portal/broadcasts/b-1'])('is shown on %s', (path) => {
    pathname.current = path;
    renderBanner();
    expect(screen.getByTestId('broadcasts-acknowledge-banner')).toBeInTheDocument();
  });
});

describe('after the compose page records the acknowledgement', () => {
  it('the banner hides on the next page without a refresh', async () => {
    const { announceBroadcastsAcknowledged, resetAcknowledgedForTests } = await import(
      '@/components/broadcast/acknowledgement/use-acknowledge-broadcasts-terms'
    );
    pathname.current = '/portal/benefits';
    renderBanner();
    expect(screen.getByTestId('broadcasts-acknowledge-banner')).toBeInTheDocument();
    act(() => announceBroadcastsAcknowledged());
    expect(screen.queryByTestId('broadcasts-acknowledge-banner')).toBeNull();
    resetAcknowledgedForTests();
  });
});
