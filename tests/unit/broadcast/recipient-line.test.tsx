// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1267) — one recipients line under the choices (the
 * maintainer, 26 Oct 2026; board `Proposal-compose`): "128 recipients · the
 * primary contact of each active member, not your own company". The estimate
 * note and the self-exclusion hint used to be two more lines above the count;
 * the line now says both, for the segment and audience leg in force. The
 * custom list keeps its own instructions (it has a textarea to explain).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ComposeAudienceMode } from '@/components/broadcast/submit-feedback';

vi.mock('@/components/broadcast/segment-picker', () => ({
  SegmentPicker: () => <div data-testid="segment-picker" />,
}));
vi.mock('@/components/broadcast/recipient-count', async (orig) => ({
  ...(await orig<typeof import('@/components/broadcast/recipient-count')>()),
  useRecipientCount: () => ({ status: 'ready', count: 128, ceiling: 500, exceeds: false }),
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

const { ComposeForm } = await import('@/components/broadcast/compose-form');
const c = enMessages.portal.broadcasts.compose;

function renderForm(audienceMode: ComposeAudienceMode = 'primary_only'): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ComposeForm audienceCeiling={500} audienceMode={audienceMode} initialSubject="Hi" />
    </NextIntlClientProvider>,
  );
}

const line = (): HTMLElement =>
  document.querySelector<HTMLElement>('[data-compose-feature="recipient-count"]')!;

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('member compose — one recipients line (T1267)', () => {
  it('states the count and who they are on one line', () => {
    renderForm();
    expect(line()).toHaveTextContent(
      '128 recipients · the primary contact of each active member, not your own company',
    );
  });

  it('the count alone is the live status; the explanation is not re-announced', () => {
    renderForm();
    expect(screen.getByRole('status')).toHaveTextContent(/^128 recipients$/);
  });

  it('says "every contact" when the all-contacts leg is in force', () => {
    renderForm('all_contacts');
    expect(line()).toHaveTextContent(
      '128 recipients · every contact of each active member who hasn’t opted out, not your own company',
    );
  });

  it('the two lines above the count are gone', () => {
    renderForm();
    expect(screen.queryByText(c.selfExclusionHint)).toBeNull();
    expect(screen.queryByText(/^Recipients: the primary contact/)).toBeNull();
  });
});
