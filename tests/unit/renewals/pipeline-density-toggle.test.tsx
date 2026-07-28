/**
 * Wave 2 Task 8 — `<PipelineTable>` client density toggle.
 *
 * The toggle persists to `localStorage['renewals.pipeline.density']`
 * (default `comfortable`) and applies `[&_td]:py-3` (comfortable) vs
 * `[&_td]:py-1.5` (compact) to the table. A remount reads the stored value
 * so the admin's choice survives navigation.
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
      <PipelineTable rows={EMPTY_ROWS} />
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
    expect(screen.getByRole('table')).toHaveClass('[&_td]:py-3');
    expect(localStorage.getItem(DENSITY_KEY)).toBeNull();
  });

  it('toggling to compact persists to localStorage and applies the compact class', async () => {
    renderTable();
    const toggle = screen.getByRole('button', {
      name: en.admin.renewals.table.density.comfortable,
    });
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(localStorage.getItem(DENSITY_KEY)).toBe('compact'),
    );
    expect(screen.getByRole('table')).toHaveClass('[&_td]:py-1.5');
    expect(screen.getByRole('table')).not.toHaveClass('[&_td]:py-3');
  });

  it('a remount reads the stored compact preference', async () => {
    localStorage.setItem(DENSITY_KEY, 'compact');
    renderTable();
    await waitFor(() =>
      expect(screen.getByRole('table')).toHaveClass('[&_td]:py-1.5'),
    );
  });
});
