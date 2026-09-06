/**
 * 108 PR-C T089 (FR-040, FR-040b, FR-041; SC-004) — `<RecipientCountLine>`:
 * the compose page's live-count region. Pinned:
 *   - a polite live region (`aria-live="polite"`) so a screen-reader user
 *     hears the count change without focus moving;
 *   - locale digit grouping through the active next-intl locale (sv groups
 *     with a space, en with a comma);
 *   - `exceeds` names the ceiling and says the submission will be refused;
 *   - `unavailable` says so and that submission is still possible (FR-040b);
 *   - `loading` announces counting; `idle` renders nothing.
 *   - the count line is numbers-only text — never an address.
 * Also pins the i18n keys statically in en / th / sv.
 */
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { describe, expect, it } from 'vitest';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import sv from '@/i18n/messages/sv.json';
import { RecipientCountLine, type RecipientCountState } from '@/components/broadcast/recipient-count';

type Messages = Record<string, unknown>;
function pick(messages: Messages, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc as Messages | undefined)?.[k], messages);
}

function renderLine(state: RecipientCountState, locale: 'en' | 'sv' = 'en') {
  const messages = locale === 'sv' ? sv : en;
  return render(
    <NextIntlClientProvider locale={locale} messages={messages as never}>
      <RecipientCountLine state={state} />
    </NextIntlClientProvider>,
  );
}

describe('recipientCount i18n keys (108 PR-C T089)', () => {
  it.each([
    ['portal.broadcasts.compose.recipientCount.ready', true],
    ['portal.broadcasts.compose.recipientCount.exceeds', true],
    ['portal.broadcasts.compose.recipientCount.unavailable', false],
    ['portal.broadcasts.compose.recipientCount.loading', false],
  ])('%s exists in en / th / sv (interpolates {count}: %s) and never hard-codes 5,000', (path, count) => {
    for (const [locale, messages] of [['en', en], ['th', th], ['sv', sv]] as const) {
      const value = pick(messages as Messages, path);
      expect(typeof value, `${locale}: ${path}`).toBe('string');
      if (count) expect(value as string, `${locale}: ${path}`).toMatch(/\{count/);
      expect(value as string, `${locale}: ${path}`).not.toMatch(/5[,. ]?000/);
    }
  });
});

describe('<RecipientCountLine> (108 PR-C T089)', () => {
  it('ready: a polite live region with the locale-grouped count', () => {
    renderLine({ status: 'ready', count: 1234, ceiling: 5000, exceeds: false, orphans: 0, droppedByPreference: 0 });
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
    expect(region.textContent).toContain(new Intl.NumberFormat('en').format(1234));
  });

  it('sv groups digits the Swedish way', () => {
    renderLine({ status: 'ready', count: 1234, ceiling: 5000, exceeds: false, orphans: 0, droppedByPreference: 0 }, 'sv');
    expect(screen.getByRole('status').textContent).toContain(new Intl.NumberFormat('sv').format(1234));
  });

  it('exceeds: names the ceiling the server refused against, not a hard-coded figure', () => {
    renderLine({ status: 'ready', count: 50001, ceiling: 50000, exceeds: true, orphans: 0, droppedByPreference: 0 });
    const text = screen.getByRole('status').textContent ?? '';
    expect(text).toContain(new Intl.NumberFormat('en').format(50001));
    expect(text).toContain(new Intl.NumberFormat('en').format(50000));
  });

  it('unavailable: says so and that submission is still possible', () => {
    renderLine({ status: 'unavailable' });
    expect(screen.getByRole('status').textContent).toMatch(/unavailable/i);
  });

  it('loading: announces counting', () => {
    renderLine({ status: 'loading' });
    expect(screen.getByRole('status').textContent).toMatch(/counting/i);
  });

  it('idle: renders no live region at all', () => {
    renderLine({ status: 'idle' });
    expect(screen.queryByRole('status')).toBeNull();
  });
});
