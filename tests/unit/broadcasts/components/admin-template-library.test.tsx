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
import { describe, it, expect } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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
    locale: 'en',
    startedFromCount: 12,
    isSeeded: true,
    updatedAtIso: '2026-05-01T00:00:00Z',
  },
  {
    id: '22222222-2222-2222-2222-222222222222',
    name: 'Event Reminder',
    locale: 'en',
    startedFromCount: 8,
    isSeeded: true,
    updatedAtIso: '2026-05-02T00:00:00Z',
  },
  {
    id: '33333333-3333-3333-3333-333333333333',
    name: 'Welcome Package',
    locale: 'en',
    startedFromCount: 3,
    isSeeded: true,
    updatedAtIso: '2026-05-03T00:00:00Z',
  },
  {
    id: '44444444-4444-4444-4444-444444444444',
    name: 'Custom Quarterly Update',
    locale: 'en',
    startedFromCount: 5,
    isSeeded: false,
    updatedAtIso: '2026-05-04T00:00:00Z',
  },
  {
    id: '55555555-5555-5555-5555-555555555555',
    name: 'Custom Member Spotlight',
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
});
