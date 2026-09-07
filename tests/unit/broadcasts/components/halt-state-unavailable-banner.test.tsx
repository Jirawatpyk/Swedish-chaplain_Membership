/**
 * Review 2026-09-07 round 2 (UX M-2) — the "halt state could not be read"
 * notice on the admin queue was a bare `<p role="alert">` with a different
 * background, no icon and no heading, in the SAME slot as `HaltStateBanner`
 * (`role="region"` + `aria-label` + ShieldAlert + h2). Two red boxes of
 * different anatomy alternated in one place. A server-rendered
 * `role="alert"` is also not announced on load (a live region must exist
 * before its content changes), so the heading is what a screen-reader user
 * navigates to. Same anatomy as its sibling now.
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';
import { HaltStateUnavailableBanner } from '@/components/broadcast/admin/halt-state-unavailable-banner';

type Messages = Record<string, unknown>;
function pick(messages: Messages, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Messages | undefined)?.[k], messages);
}

describe('<HaltStateUnavailableBanner>', () => {
  it.each([
    ['admin.broadcasts.queue.haltStateUnavailableTitle'],
    ['admin.broadcasts.queue.haltStateUnavailable'],
  ])('%s exists in en / th / sv', (path) => {
    for (const [locale, messages] of [['en', en], ['th', th], ['sv', sv]] as const) {
      const value = pick(messages as Messages, path);
      expect(typeof value, `${locale}: ${path}`).toBe('string');
      expect((value as string).length).toBeGreaterThan(0);
    }
  });

  it('is a labelled region with an h2 and the body, never a bare role=alert', () => {
    render(
      <NextIntlClientProvider locale="en" messages={en as never}>
        <HaltStateUnavailableBanner />
      </NextIntlClientProvider>,
    );
    const region = screen.getByRole('region');
    expect(region).toHaveAccessibleName(/halt state/i);
    expect(screen.getByRole('heading', { level: 2 }).textContent).toMatch(/halt state/i);
    expect(region.textContent).toMatch(/refresh before approving/i);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
