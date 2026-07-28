/**
 * Wave 2 Task 8 — `<PipelineTable>` client density toggle.
 *
 * The toggle persists to `localStorage['renewals.pipeline.density']`
 * (default `comfortable`). Fix round 1 I-1: density now drives the shared
 * `--table-cell-padding-y` design token (globals.css, consumed by
 * `TableCell`'s `py-[var(--table-cell-padding-y)]`) via an inline CSS custom
 * property on `<Table>`, instead of hardcoded `[&_td]:py-*` classes — so
 * these assertions read the applied `style` value, not a class name.
 * Comfortable = `0.5rem` (the token's unchanged 8px baseline); compact =
 * `0.375rem` (6px). A remount reads the stored value so the admin's choice
 * survives navigation.
 *
 * Harness note: the shared `tests/setup.ts` installs FAKE timers; this suite
 * calls `vi.useRealTimers()` so the mount effect that reads localStorage
 * flushes under `waitFor` instead of spinning to the test timeout. Rendered
 * with `rows={[]}` (no `RowActions`, hence no Base UI DropdownMenu to mock).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { PipelineTable } from '@/app/(staff)/admin/renewals/_components/pipeline-table';
import en from '@/i18n/messages/en.json';
import type { PipelineRow } from '@/modules/renewals/client';

const EMPTY_ROWS: ReadonlyArray<PipelineRow> = [];
const DENSITY_KEY = 'renewals.pipeline.density';

function renderTable() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <PipelineTable rows={EMPTY_ROWS} canMutate />
    </NextIntlClientProvider>,
  );
}

describe('<PipelineTable> density toggle', () => {
  beforeEach(() => {
    vi.useRealTimers();
    localStorage.clear();
  });
  afterEach(() => {
    cleanup();
    localStorage.clear();
    vi.useFakeTimers();
  });

  it('defaults to comfortable padding with no stored preference', () => {
    renderTable();
    const table = screen.getByRole('table');
    // Comfortable === the token's unchanged 8px baseline (globals.css).
    expect(table.style.getPropertyValue('--table-cell-padding-y')).toBe(
      '0.5rem',
    );
    expect(localStorage.getItem(DENSITY_KEY)).toBeNull();
  });

  it('toggling to compact persists to localStorage and drives the token to 6px', async () => {
    renderTable();
    const toggle = screen.getByRole('button', {
      name: en.admin.renewals.table.density.comfortable,
    });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(localStorage.getItem(DENSITY_KEY)).toBe('compact'),
    );
    expect(
      screen.getByRole('table').style.getPropertyValue('--table-cell-padding-y'),
    ).toBe('0.375rem');
  });

  it('a remount reads the stored compact preference', async () => {
    localStorage.setItem(DENSITY_KEY, 'compact');
    renderTable();
    await waitFor(() =>
      expect(
        screen
          .getByRole('table')
          .style.getPropertyValue('--table-cell-padding-y'),
      ).toBe('0.375rem'),
    );
  });
});
