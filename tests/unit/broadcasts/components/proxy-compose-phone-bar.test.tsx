// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1271 parity) — staff compose on behalf on a phone keeps
 * Submit in a sticky bar with the count, as the member form does (board
 * `Admin-broadcast-new-mobile`). Save as draft stays in the form. Desktop
 * keeps Submit in the card.
 */
import { act, cleanup, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en.json';
import type { MemberPickerOption } from '@/components/broadcast/member-picker';

const bp = vi.hoisted(() => ({ current: 'base' as 'base' | 'lg' }));
vi.mock('@jirawatpyk/aura-react', async (orig) => ({
  ...(await orig<typeof import('@jirawatpyk/aura-react')>()),
  useBreakpoint: () => bp.current,
}));
let capturedOnSelect: ((m: MemberPickerOption) => void) | null = null;
vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: ({ onSelect }: { onSelect: (m: MemberPickerOption) => void }) => {
    capturedOnSelect = onSelect;
    return <div data-testid="member-picker" />;
  },
}));
vi.mock('@/components/broadcast/recipient-count', async (orig) => ({
  ...(await orig<typeof import('@/components/broadcast/recipient-count')>()),
  useRecipientCount: () => ({ status: 'ready', count: 130, ceiling: 500, exceeds: false }),
}));
vi.mock('@/components/broadcast/preview-pane', () => ({ PreviewPane: () => null }));
vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(): React.ReactElement {
      return <textarea aria-label="Message body" />;
    },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { ProxyComposeForm } = await import('@/components/broadcast/proxy-compose-form');
const c = en.portal.broadcasts.compose;

function renderPicked(): void {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ProxyComposeForm audienceCeiling={500} />
    </NextIntlClientProvider>,
  );
  act(() =>
    capturedOnSelect?.({
      memberId: 'm-1',
      companyName: 'Bangkok Freight Nordic Co., Ltd.',
      primaryContactName: 'Malin Berg',
      hasPrimaryContactEmail: true,
    } as MemberPickerOption),
  );
}

beforeEach(() => {
  vi.useRealTimers();
  bp.current = 'base';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  capturedOnSelect = null;
  vi.unstubAllGlobals();
});

describe('staff compose on a phone', () => {
  it('keeps Submit in a bar with the count, and only there; Save as draft stays in the form', () => {
    renderPicked();
    const bar = screen.getByRole('region', { name: c.views.actions });
    expect(bar).toHaveTextContent('130 recipients');
    expect(within(bar).getByRole('button', { name: c.button.submit })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: c.button.submit })).toHaveLength(1);
    expect(within(bar).queryByRole('button', { name: en.admin.broadcasts.proxySubmitDialog.saveDraftButton })).toBeNull();
  });
});

describe('staff compose on a desktop', () => {
  it('has no bar', () => {
    bp.current = 'lg';
    renderPicked();
    expect(screen.queryByRole('region', { name: c.views.actions })).toBeNull();
    expect(screen.getAllByRole('button', { name: c.button.submit })).toHaveLength(1);
  });
});

describe('staff compose at 320 px', () => {
  // Measured at 320 px (fixture `aura-admin?view=broadcast-new`): with no
  // track below `lg` the grid's implicit column took the cards' min-content,
  // 322 px in a 288 px column, and the page scrolled sideways by 18 px.
  it('sizes its one column to the page below lg, so nothing pushes it wider', () => {
    renderPicked();
    const grid = screen.getByTestId('proxy-compose-grid');
    expect(grid.className).toContain('grid-cols-[minmax(0,1fr)]');
  });
});
