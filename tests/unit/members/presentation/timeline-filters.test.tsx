/**
 * Spec 122 US3 T308 — the timeline filters on AURA: a FilterBar region with
 * AURA selects for source and actor, labelled AURA date fields, and a Clear
 * button once a filter is set. Any change rewrites the URL and drops the
 * keyset cursor (FR-015).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { TimelineFilters } from '@/components/members/timeline-filters';

const replace = vi.fn();
let search = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useRouter: () => ({ replace, push: vi.fn(), refresh: vi.fn() }),
  useSearchParams: () => search,
  usePathname: () => '/portal/timeline',
}));

const copy = en.timeline.filters;

function renderFilters() {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <TimelineFilters />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  replace.mockClear();
  search = new URLSearchParams();
});
afterEach(cleanup);

describe('TimelineFilters on AURA (spec 122 US3)', () => {
  it('is an AURA filter bar with AURA selects, labelled AURA date pickers and a Clear that waits for a filter', () => {
    const { container } = renderFilters();
    const bar = screen.getByRole('region', { name: copy.title });
    expect(bar).toHaveClass('aura-filterbar', 'aura-filterbar--fill');
    for (const [name, label] of [['source', copy.source], ['actorKind', copy.actor]] as const) {
      const field = container.querySelector(`select[name="${name}"]`)?.closest('.aura-field');
      expect(field).not.toBeNull();
      // a visible label, like the date fields beside it (not an aria-label only)
      expect(field!.querySelector('label')).toHaveTextContent(label);
    }
    // AURA DatePicker: a typed date field with its calendar button
    expect(screen.getByLabelText(copy.from)).toHaveAttribute('inputmode', 'numeric');
    expect(screen.getByLabelText(copy.to).closest('.aura-field')).not.toBeNull();
    expect(screen.getByRole('button', { name: copy.clear })).toBeDisabled();
  });

  it('writes a date to the URL and drops the cursor', () => {
    search = new URLSearchParams('cursor=abc');
    renderFilters();
    const from = screen.getByLabelText(copy.from);
    fireEvent.change(from, { target: { value: '2026-09-01' } });
    fireEvent.blur(from);
    expect(replace).toHaveBeenCalledWith('/portal/timeline?from=2026-09-01');
  });

  it('writes a chosen source to the URL and drops the cursor', () => {
    search = new URLSearchParams('cursor=abc');
    const { container } = renderFilters();
    fireEvent.change(container.querySelector('select[name="source"]')!, { target: { value: 'invoice' } });
    expect(replace).toHaveBeenCalledWith('/portal/timeline?source=invoice');
  });

  it('offers an AURA Clear button once a filter is set, which clears them all', () => {
    search = new URLSearchParams('source=invoice&from=2026-09-01');
    renderFilters();
    const clear = screen.getByRole('button', { name: copy.clear });
    expect(clear).toHaveClass('aura-btn');
    fireEvent.click(clear);
    expect(replace).toHaveBeenCalledWith('/portal/timeline');
  });
});
