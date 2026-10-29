// @vitest-environment jsdom
/**
 * Spec 122 PR D (spec-compliance review) — the tier option on both compose
 * forms: the categories show on member and staff compose, and Submit stays
 * off, with its reason, until one is ticked.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';
import { ProxyComposeForm } from '@/components/broadcast/proxy-compose-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => ({ status: 'idle' }),
  RecipientCountLine: () => null,
}));
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Preview" />,
}));
vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: (props: {
    onSelect: (m: { memberId: string; companyName: string; hasPrimaryContactEmail: boolean }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        props.onSelect({
          memberId: '22222222-2222-2222-2222-222222222222',
          companyName: 'Acme Co',
          hasPrimaryContactEmail: true,
        })
      }
    >
      pick-member
    </button>
  ),
}));
vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: { initialHtml: string; onChange: (html: string) => void }): React.ReactElement {
      return (
        <textarea
          aria-label="Message body"
          defaultValue={props.initialHtml}
          onChange={(e) => props.onChange(e.target.value)}
        />
      );
    },
}));

const c = enMessages.portal.broadcasts.compose;
const cat = enMessages.portal.broadcasts.list.tierCode;

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
    vi.fn().mockResolvedValue({ ok: true, status: 200, headers: new Headers(), json: async () => ({}) }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** The form's Submit for review (the phone bar's copy is not rendered at desktop width). */
function submitButton(): HTMLElement {
  return screen.getByRole('button', { name: c.button.submit });
}

async function chooseCategoriesAndCheckGate(): Promise<void> {
  const user = userEvent.setup();
  await user.click(screen.getByRole('radio', { name: c.segmentOption.tier }));
  // None ticked: Submit is off and says why.
  expect(submitButton()).toBeDisabled();
  expect(submitButton()).toHaveAccessibleDescription(expect.stringContaining(c.submitBlocked.tierRequired));
  await user.click(screen.getByRole('checkbox', { name: cat.corporate }));
  expect(submitButton()).not.toHaveAccessibleDescription(expect.stringContaining(c.submitBlocked.tierRequired));

  // Unticking the last one: the group says it in full, and the line by Submit
  // shortens rather than repeating the sentence.
  await user.click(screen.getByRole('checkbox', { name: cat.corporate }));
  expect(screen.getAllByText(c.submitBlocked.tierRequired)).toHaveLength(1);
  expect(submitButton()).toHaveAccessibleDescription(expect.stringContaining(c.submitBlocked.tierChooseFirst));
  expect(submitButton()).not.toHaveAccessibleDescription(expect.stringContaining(c.submitBlocked.tierRequired));

  // Away and back: the group's error goes with it, so the full hint returns.
  await user.click(screen.getByRole('radio', { name: c.segmentOption.all_members }));
  await user.click(screen.getByRole('radio', { name: c.segmentOption.tier }));
  expect(screen.getAllByText(c.submitBlocked.tierRequired)).toHaveLength(1);
  expect(submitButton()).toHaveAccessibleDescription(expect.stringContaining(c.submitBlocked.tierRequired));
}

describe('the membership categories on both compose forms (PR D)', () => {
  it('member compose: Submit waits for a category', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposeForm
          audienceCeiling={500}
          audienceMode="primary_only"
          initialSubject="Nordic Leadership Breakfast"
          initialBodyHtml="<p>Seats are limited.</p>"
        />
      </NextIntlClientProvider>,
    );
    await chooseCategoriesAndCheckGate();
  });

  it('staff compose on behalf: the same categories, and Submit waits for one', async () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProxyComposeForm audienceCeiling={5000} templates={[]} />
      </NextIntlClientProvider>,
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'pick-member' }));
    await user.type(screen.getByRole('textbox', { name: c.fields.subject }), 'Nordic Leadership Breakfast');
    await user.type(screen.getByRole('textbox', { name: 'Message body' }), 'Seats are limited.');
    await chooseCategoriesAndCheckGate();
  });
});
