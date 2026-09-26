// @vitest-environment jsdom
/**
 * F119 walk U36 — the E-Blast acknowledgement banner rendered an `<h2>` above the
 * page `<h1>` (outline h2 → h1 → h2) and sat inside `<main>`, so its three
 * controls were the first tab stops after "Skip to main content".
 *
 * The banner is now a named region with no heading of its own, mounted
 * between `</header>` and `<main>` so the skip link bypasses it (SC 2.4.1).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { AcknowledgementBannerClient } from '@/app/(member)/portal/_components/marketing-acknowledgement-banner-client';

vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(() => {
  cleanup();
});

const copy = en.portal.broadcasts.banner.acknowledgement;

function renderBanner(): HTMLElement {
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
  return screen.getByTestId('broadcasts-acknowledge-banner');
}

describe('marketing acknowledgement banner (U36)', () => {
  it('carries no heading, so the page <h1> stays first in the outline', () => {
    const banner = renderBanner();
    expect(within(banner).queryByRole('heading')).not.toBeInTheDocument();
  });

  it('is still a region named by its title', () => {
    renderBanner();
    expect(screen.getByRole('region', { name: copy.title })).toBeInTheDocument();
  });

  it('is mounted outside <main>, so the skip link bypasses it', () => {
    const layout = readFileSync(
      join(process.cwd(), 'src/app/(member)/portal/layout.tsx'),
      'utf8',
    );
    const banner = layout.indexOf('<MarketingAcknowledgementBanner />');
    expect(banner).toBeGreaterThan(layout.indexOf('</header>'));
    // The JSX element (`<main` + attributes), not a `<main>` in a comment.
    expect(banner).toBeLessThan(layout.search(/<main\s/));
  });
});
