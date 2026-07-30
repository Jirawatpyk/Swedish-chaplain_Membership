/**
 * `SuspendedBridgeStrip` — the suspended-population bridge on the renewals
 * pipeline (renewals-suspended-visibility-audit Task 2 + the Task 3 honest
 * link). Rendered with the REAL en.json (repo convention) so the ICU
 * message + <link> rich-tag wiring are exercised, not mocked.
 *
 * `vi.useRealTimers()` — the shared harness installs fake timers that hang
 * React rendering (memory: component test harness fake timers).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { SuspendedBridgeStrip } from '@/app/(staff)/admin/renewals/_components/suspended-bridge-strip';

beforeEach(() => vi.useRealTimers());

function renderStrip(inWindowCount: number, outsideWindowCount: number) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <SuspendedBridgeStrip
        inWindowCount={inWindowCount}
        outsideWindowCount={outsideWindowCount}
      />
    </NextIntlClientProvider>,
  );
}

describe('SuspendedBridgeStrip', () => {
  it('renders total = inWindow + outside with all three counts in the sentence (the 4-vs-15 bridge)', () => {
    renderStrip(4, 11);
    // The operator's real confusion case: Members page said 15, tab said 4.
    const strip = screen.getByText(/Suspended benefit access: 15 members in total/);
    expect(strip).toBeInTheDocument();
    expect(strip.textContent).toContain('4 in this renewal queue');
    expect(strip.textContent).toContain(
      '11 with an unpaid first bill (not yet in a renewal window)',
    );
  });

  it('renders NOTHING when no suspended cycles sit outside the window (no layout shift)', () => {
    const { container } = renderStrip(4, 0);
    expect(container).toBeEmptyDOMElement();
  });

  it('links ONLY the honest "view all unpaid membership bills" text to status=issued&subject=membership (Task 3 — counts stay outside the link)', () => {
    renderStrip(4, 11);
    const link = screen.getByRole('link', {
      name: 'View all unpaid membership bills',
    });
    expect(link).toHaveAttribute(
      'href',
      '/admin/invoices?status=issued&subject=membership',
    );
    // The link text promises what the page shows (every unpaid membership
    // bill) — the exact outside-window cohort is not URL-expressible, so
    // the counts must NOT sit inside the link where they would imply an
    // exact-N landing.
    expect(link.textContent).not.toMatch(/\d/);
  });

  it('keeps the link keyboard-focusable with the standard focus ring and a PERSISTENT underline (B1 — not hover-only)', () => {
    renderStrip(4, 11);
    const link = screen.getByRole('link', {
      name: 'View all unpaid membership bills',
    });
    link.focus();
    expect(link).toHaveFocus();
    expect(link.className).toContain('focus-visible:outline-2');
    // B1 — a mid-sentence link in muted body text needs a non-color
    // affordance at REST (WCAG 1.4.1); hover-only underline fails it.
    expect(link.className).toMatch(/\bunderline\b/);
    expect(link.className).not.toContain('hover:underline');
  });

  it('uses ICU singular for a lone member ("1 member", not "1 members")', () => {
    renderStrip(0, 1);
    expect(
      screen.getByText(/Suspended benefit access: 1 member in total/),
    ).toBeInTheDocument();
  });
});
