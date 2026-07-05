/**
 * #4 — command-palette localized-label search.
 *
 * The server now returns the whole role-filtered action/navigate registry
 * (no query filter); the client cmdk matches the typed query against each
 * item's `value`, which includes the RESOLVED, locale-specific label. This
 * pins that a TH admin typing the Thai label they SEE keeps the action visible
 * (the old value carried only the i18n key, so a Thai query hid it).
 */
import { describe, expect, it, vi, beforeAll } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import {
  Command,
  CommandInput,
  CommandList,
} from '@/components/ui/command';
import { PaletteGroups } from '@/components/command-palette/groups';
import type { PaletteSearchResponse } from '@/components/command-palette/registry';

// cmdk uses scrollIntoView + ResizeObserver, both absent in jsdom.
beforeAll(() => {
  if (!Element.prototype.scrollIntoView) {
    Element.prototype.scrollIntoView = vi.fn();
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

const THAI_NEW_PLAN = 'สร้างแพ็กเกจใหม่';

const messages = {
  palette: {
    groups: {
      plans: 'แผน',
      members: 'สมาชิก',
      refundableInvoices: 'ใบแจ้งหนี้ที่คืนเงินได้',
      actions: 'การกระทำ',
      navigate: 'ไปยัง',
    },
    actions: { newPlan: THAI_NEW_PLAN },
    navigate: {},
  },
};

const results: PaletteSearchResponse['results'] = {
  plans: [],
  members: [],
  refundableInvoices: [],
  actions: [
    {
      id: 'plan.new',
      label: 'palette.actions.newPlan',
      url: '/admin/plans/new',
      keywords: ['create', 'add'],
    },
  ],
  navigate: [],
};

function renderPalette() {
  return render(
    <NextIntlClientProvider locale="th" messages={messages}>
      <Command>
        <CommandInput placeholder="ค้นหา" />
        <CommandList>
          <PaletteGroups results={results} onAfterNavigate={() => {}} />
        </CommandList>
      </Command>
    </NextIntlClientProvider>,
  );
}

function typeQuery(container: HTMLElement, value: string) {
  const input = container.querySelector('input');
  if (!input) throw new Error('command input did not render');
  fireEvent.change(input, { target: { value } });
}

describe('command-palette localized-label search (#4)', () => {
  it('keeps a Thai-labelled action visible when the query is the Thai label', () => {
    const { container } = renderPalette();
    // Baseline: the resolved Thai label renders.
    expect(screen.getByText(THAI_NEW_PLAN)).toBeTruthy();

    // Typing a substring of the VISIBLE Thai label keeps the item — the cmdk
    // value now carries the resolved label, not just the i18n key.
    typeQuery(container, 'สร้าง');
    expect(screen.getByText(THAI_NEW_PLAN)).toBeTruthy();
  });

  it('still matches the English keyword synonym (BUG-024 preserved)', () => {
    const { container } = renderPalette();
    typeQuery(container, 'add');
    expect(screen.getByText(THAI_NEW_PLAN)).toBeTruthy();
  });

  it('filters the action out for a query matching neither label, id, nor keyword', () => {
    const { container } = renderPalette();
    typeQuery(container, 'zzzznomatch');
    expect(screen.queryByText(THAI_NEW_PLAN)).toBeNull();
  });
});
