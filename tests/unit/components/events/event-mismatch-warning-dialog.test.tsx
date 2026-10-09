/**
 * Spec 122 US9b-2 — R39 finding (relay doc rev 179): the prior-imports box
 * sat on `--aura-bg-surface-strong`, AURA's INVERTED surface (zinc-900 in
 * light), with ordinary text on it — captions measured 2.29:1 and the
 * event name rendered dark-on-dark (1:1). The box must use a normal
 * surface, so its text keeps the theme's contrast.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { EventMismatchWarningDialog } from '@/components/events/event-mismatch-warning-dialog';
import enMessages from '@/i18n/messages/en.json';
import { buildFormats } from '@/i18n/formats';

describe('<EventMismatchWarningDialog> prior-imports box', () => {
  it('does not put ordinary text on the inverted strong surface', () => {
    render(
      <NextIntlClientProvider
        locale="en"
        messages={enMessages}
        formats={buildFormats('en')}
        timeZone="Asia/Bangkok"
      >
        <EventMismatchWarningDialog
          open
          onOpenChange={vi.fn()}
          onContinue={vi.fn()}
          priorImports={[
            {
              recordId: 'r-1',
              eventId: 'ev-1',
              eventName: 'SweCham AGM 2026',
              uploadedAt: '2026-09-01T03:00:00.000Z',
            },
          ]}
        />
      </NextIntlClientProvider>,
    );
    const box = screen.getByText('SweCham AGM 2026').closest('ul')?.parentElement;
    expect(box).toBeTruthy();
    expect(box!.className).not.toMatch(/bg-surface-strong/);
    expect(box!.className).toMatch(/bg-\[var\(--aura-bg-canvas\)\]/);
  });
});
