/**
 * Phase 5 Round 1 R2.1 H-test-4 — Unit tests for
 * <AdminTemplateLibrary> (T112 filter pills).
 *
 * Covers FR-018 + critique P6:
 *   - 3 filter pills: All / Starter only / Admin-authored
 *   - aria-pressed flips correctly per active filter
 *   - Filtered tbody row count matches the seeded/authored split
 *   - Live region announces filtered count
 *
 * Test fixture: 3 seeded ("Monthly Newsletter" + 2 others) + 2 admin-
 * authored templates. Total visible rows per filter must match.
 */
import { describe, it, expect, vi } from 'vitest';
import {
  render,
  screen,
  fireEvent,
  within,
  waitFor,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
  AdminTemplateLibrary,
  type TemplateLibraryRow,
} from '@/components/broadcast/admin/template-library';
import enMessages from '@/i18n/messages/en.json';

const FIXTURE_ROWS: readonly TemplateLibraryRow[] = [
  {
    id: '11111111-1111-1111-1111-111111111111',
    name: 'Monthly Newsletter',
    subjectPreview: 'Your monthly chamber update',
    locale: 'en',
    startedFromCount: 12,
    isSeeded: true,
    updatedAtIso: '2026-05-01T00:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Event Reminder',
    subjectPreview: 'Reminder: chamber event tomorrow',
    locale: 'en',
    startedFromCount: 8,
    isSeeded: true,
    updatedAtIso: '2026-05-02T00:00:00Z',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Welcome Package',
    subjectPreview: 'Welcome to the chamber',
    locale: 'en',
    startedFromCount: 3,
    isSeeded: true,
    updatedAtIso: '2026-05-03T00:00:00Z',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'Custom Quarterly Update',
    subjectPreview: 'Q2 newsletter from your chamber',
    locale: 'en',
    startedFromCount: 5,
    isSeeded: false,
    updatedAtIso: '2026-05-04T00:00:00Z',
  },
  {
    id: '55555555-5555-5555-5555-555555555555',
    name: 'Custom Member Spotlight',
    subjectPreview: 'Member spotlight: meet our newest',
    locale: 'en',
    startedFromCount: 2,
    isSeeded: false,
    updatedAtIso: '2026-05-05T00:00:00Z',
  },
];

function renderLibrary(rows = FIXTURE_ROWS) {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages as Record<string, unknown>}
    >
      <AdminTemplateLibrary rows={rows} />
    </NextIntlClientProvider>,
  );
}

function countDataRows(): number {
  const table = screen.getByRole('table');
  // tbody rows only (skip thead) — every data row carries the
  // <tr className="border-b ..."> with a name + locale cell.
  return within(table).getAllByRole('row').length - 1; // -1 for thead row
}

describe('<AdminTemplateLibrary> — R2.1 H-test-4', () => {
  it('defaults to "All" filter → renders all 5 rows', () => {
    renderLibrary();
    expect(countDataRows()).toBe(5);
    const allButton = screen.getByRole('button', { name: /^all$/i });
    expect(allButton).toHaveAttribute('aria-pressed', 'true');
  });

  it('"Starter only" pill → 3 rows, aria-pressed flips', () => {
    renderLibrary();
    const starterButton = screen.getByRole('button', {
      name: /starter only/i,
    });
    fireEvent.click(starterButton);
    expect(starterButton).toHaveAttribute('aria-pressed', 'true');
    expect(
      screen.getByRole('button', { name: /^all$/i }),
    ).toHaveAttribute('aria-pressed', 'false');
    expect(countDataRows()).toBe(3);
  });

  it('"Admin-authored" pill → 2 rows', () => {
    renderLibrary();
    const authoredButton = screen.getByRole('button', {
      name: /admin-authored/i,
    });
    fireEvent.click(authoredButton);
    expect(authoredButton).toHaveAttribute('aria-pressed', 'true');
    expect(countDataRows()).toBe(2);
  });

  it('switching filters resets row count correctly', () => {
    renderLibrary();
    const starter = screen.getByRole('button', { name: /starter only/i });
    const all = screen.getByRole('button', { name: /^all$/i });
    fireEvent.click(starter);
    expect(countDataRows()).toBe(3);
    fireEvent.click(all);
    expect(countDataRows()).toBe(5);
  });

  it('Starter badge renders next to seeded row names', () => {
    renderLibrary();
    const tbody = within(screen.getByRole('table'));
    // Seeded rows have a Starter badge labelled "Seeded by the platform"
    expect(
      tbody.getAllByLabelText(/seeded by the platform/i),
    ).toHaveLength(3);
  });

  it('R3.4 M-3: filter pill click updates live-region count text after settle delay', async () => {
    // Global Vitest fake timers (tests/setup.ts) break waitFor's
    // polling cadence; switch to real timers for this test only.
    //
    // R4.3 M-11 — fake-timer state is restored by the explicit
    // `vi.useFakeTimers()` call in the local `finally` block below;
    // the global `afterEach` only clears mock call history via
    // `vi.clearAllMocks()`, which does NOT toggle the timer mode.
    //
    // R6.8 (R5 senior-tester L-3 close) — the try/finally pattern is
    // safe against `it.skip(...)`: if a future contributor `.skip`s
    // this test, the WHOLE function body (including
    // `vi.useRealTimers()`) is never executed, so global fake timers
    // remain intact. No need to refactor to a nested-`describe` +
    // `beforeEach`/`afterEach` pair — that adds boilerplate for the
    // single test in this file that needs real timers.
    vi.useRealTimers();
    try {
      renderLibrary();
      // Initial mount: live region announces total of 5
      expect(screen.getByRole('status').textContent).toMatch(/5/);

      // Click Starter pill → 3 visible rows. Live-region updates via
      // setTimeout(0) (template-library.tsx L4 settle delay).
      fireEvent.click(screen.getByRole('button', { name: /starter only/i }));
      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toMatch(/3/);
      });

      // Click Admin-authored → 2 rows
      fireEvent.click(
        screen.getByRole('button', { name: /admin-authored/i }),
      );
      await waitFor(() => {
        expect(screen.getByRole('status').textContent).toMatch(/2/);
      });
    } finally {
      vi.useFakeTimers({
        now: new Date('2026-04-09T12:00:00.000Z'),
        shouldAdvanceTime: false,
        toFake: [
          'Date',
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
        ],
      });
    }
  });
});
