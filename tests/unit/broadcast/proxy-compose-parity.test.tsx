/**
 * F119 T137 (US6-AS5, FR-039).
 *
 * "The writing tool MUST be the same for members writing an original and for
 * marketing formatting a version" — so the staff compose-on-behalf screen has
 * to offer what the member screen offers. Today `proxy-compose-form.tsx` has
 * none of it except the preview.
 *
 * Three of the seven parity items — draft save/resume, inline images and the
 * proxied member's allowance — cannot be built in PR-1: each needs a staff API
 * route that neither the code nor `contracts/admin-eblast-formatting-api.md`
 * defines (see the `it.todo`s at the bottom, which name the exact missing
 * endpoint). They are TODO here rather than asserted-absent, because absent is
 * the defect, not the contract.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ProxyComposeForm } from '@/components/broadcast/proxy-compose-form';
import type { ComposeTemplateOption } from '@/components/broadcast/compose/template-picker-field';

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}));

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => ({ status: 'idle' }),
  RecipientCountLine: () => null,
}));

vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: () => <button type="button">pick-member</button>,
}));

vi.mock('@/components/ui/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: {
      initialHtml: string;
      onChange: (html: string) => void;
    }): React.ReactElement {
      return (
        <textarea
          aria-label="Message body"
          defaultValue={props.initialHtml}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

const TEMPLATE: ComposeTemplateOption = {
  id: 't1',
  name: 'Welcome',
  locale: 'en',
  isSeeded: false,
  subject: 'Template subject',
  bodyHtml: '<p>Template body</p>',
};

function beforeUnloadWouldPrompt(): boolean {
  const event = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(event);
  return event.defaultPrevented;
}

function renderForm(): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ProxyComposeForm audienceCeiling={5000} templates={[TEMPLATE]} />
    </NextIntlClientProvider>,
  );
}

beforeAll(() => {
  if (typeof globalThis.PointerEvent === 'undefined') {
    // @ts-expect-error — minimal polyfill for jsdom
    globalThis.PointerEvent = class PointerEvent extends MouseEvent {
      readonly pointerId: number;
      constructor(type: string, params?: PointerEventInit) {
        super(type, params);
        this.pointerId = params?.pointerId ?? 0;
      }
    };
  }
});

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) }),
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T137 — the staff compose-on-behalf form offers what the member form offers', () => {
  it('offers the template picker', () => {
    renderForm();
    expect(screen.getByText('Start from a template')).toBeInTheDocument();
  });

  it('offers the subject counter', () => {
    renderForm();
    expect(screen.getByText('0 / 200 characters')).toBeInTheDocument();
  });

  it('offers the preview', () => {
    renderForm();
    expect(screen.getByLabelText('Preview')).toBeInTheDocument();
  });

  it('offers the unsaved-changes guard', async () => {
    const user = userEvent.setup();
    renderForm();

    // Nothing typed → leaving is silent.
    expect(beforeUnloadWouldPrompt()).toBe(false);

    await user.type(screen.getByLabelText('Subject'), 'Spring mixer');

    expect(beforeUnloadWouldPrompt()).toBe(true);
  });

  it.todo(
    'offers draft save/resume — BLOCKED: no staff draft endpoint exists ' +
      '(`/api/broadcasts/draft` is `requireMemberContext`-gated and ' +
      '`contracts/admin-eblast-formatting-api.md` defines no staff equivalent)',
  );

  it.todo(
    'offers inline images — BLOCKED: `POST /api/admin/broadcasts/[id]/images` ' +
      'needs a staff-owned `draft` broadcast id, which nothing in PR-1 can create',
  );

  it.todo(
    "offers the proxied member's allowance — BLOCKED: `/api/broadcasts/quota` " +
      'is member-session-scoped and no admin `…/quota?memberId=` route exists',
  );
});
