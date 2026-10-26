// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1269) — the member compose page on a phone (the
 * maintainer, 26 Oct 2026; boards `Proposal-compose-mobile-write`,
 * `-mobile-preview`): Write / Preview tabs, and a sticky bar with the count
 * and Submit for review above the bottom nav. Save as draft stays in the form.
 * Desktop keeps the side-by-side editor and preview, with no tabs and no bar.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

const bp = vi.hoisted(() => ({ current: 'base' as 'base' | 'lg' }));
vi.mock('@jirawatpyk/aura-react', async (orig) => ({
  ...(await orig<typeof import('@jirawatpyk/aura-react')>()),
  useBreakpoint: () => bp.current,
}));
vi.mock('@/components/broadcast/recipient-count', async (orig) => ({
  ...(await orig<typeof import('@/components/broadcast/recipient-count')>()),
  useRecipientCount: () => ({ status: 'ready', count: 128, ceiling: 500, exceeds: false }),
}));
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Email preview" />,
}));
vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(): React.ReactElement {
      return <textarea aria-label="Message body" />;
    },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { ComposeForm } = await import('@/components/broadcast/compose-form');
const c = enMessages.portal.broadcasts.compose;

function renderForm(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm audienceCeiling={500} audienceMode="primary_only" initialSubject="Breakfast" />
    </NextIntlClientProvider>,
  );
}

beforeEach(() => {
  vi.useRealTimers();
  bp.current = 'base';
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('member compose on a phone (T1269)', () => {
  it('has Write and Preview tabs; Write shows the form, Preview the email', () => {
    renderForm();
    const write = screen.getByRole('tab', { name: c.views.write });
    expect(write).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByLabelText(c.fields.subject)).toBeVisible();
    expect(screen.getByLabelText('Email preview')).not.toBeVisible();

    fireEvent.click(screen.getByRole('tab', { name: c.views.preview }));
    expect(screen.getByLabelText('Email preview')).toBeVisible();
    expect(screen.getByLabelText(c.fields.subject)).not.toBeVisible();
  });

  it('keeps Submit in a bar with the count, and only there', () => {
    renderForm();
    const bar = screen.getByRole('region', { name: c.views.actions });
    expect(bar).toHaveTextContent('128 recipients');
    expect(within(bar).getByRole('button', { name: c.button.submit })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: c.button.submit })).toHaveLength(1);
    expect(screen.getByRole('button', { name: c.button.saveDraft })).toBeInTheDocument();
  });
});

describe('member compose on a desktop', () => {
  it('has no tabs and no bar', () => {
    bp.current = 'lg';
    renderForm();
    expect(screen.queryByRole('tab')).toBeNull();
    expect(screen.queryByRole('region', { name: c.views.actions })).toBeNull();
    expect(screen.getByLabelText('Email preview')).toBeVisible();
  });
});
