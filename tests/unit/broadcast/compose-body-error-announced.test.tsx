/**
 * F119 T136 (US6-AS4, FR-048).
 *
 * A validation error on the message must be announced ON THE EDITOR. Both
 * compose forms hang `aria-invalid` + `aria-describedby` on the wrapper
 * `<div tabIndex={-1}>` around the editor (`compose-form.tsx:536-550`,
 * `proxy-compose-form.tsx:450-469`), which is not the control the user is
 * typing in — the `contenteditable` is. `TiptapEditor` already accepts
 * `invalid` and `describedById` and forwards both onto the `contenteditable`
 * (`tiptap-editor.tsx:106,113`); `admin/template-form.tsx:283-286` is the
 * call site that already does it right.
 *
 * The editor is doubled so the props the forms pass are directly observable —
 * `tiptap-editor.tsx` itself is covered by its own suites.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import { ComposeForm } from '@/components/broadcast/compose-form';
import { ProxyComposeForm } from '@/components/broadcast/proxy-compose-form';

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
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <section aria-label="Preview" />,
}));

/** The member combobox popup deadlocks in jsdom; the double keeps the contract. */
vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: ({
    onSelect,
  }: {
    onSelect: (m: {
      memberId: string;
      companyName: string;
      primaryContactName: string | null;
      hasPrimaryContactEmail: boolean;
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        onSelect({
          memberId: '22222222-2222-4222-8222-222222222222',
          companyName: 'Acme AB',
          primaryContactName: 'Jo',
          hasPrimaryContactEmail: true,
        })
      }
    >
      pick-member
    </button>
  ),
}));

vi.mock('@/components/ui/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub(props: {
      initialHtml: string;
      onChange: (html: string) => void;
      describedById?: string;
      invalid?: boolean;
    }): React.ReactElement {
      return (
        <div
          data-testid="tiptap-editor"
          data-invalid={props.invalid === true ? 'true' : 'false'}
          data-describedby={props.describedById ?? ''}
        >
          <textarea
            aria-label="Message body"
            defaultValue={props.initialHtml}
            onChange={(e) => props.onChange(e.target.value)}
          />
        </div>
      );
    },
}));

/** The wrapper `<div tabIndex={-1}>` the forms use to focus the body area. */
function bodyWrapper(): HTMLElement {
  const wrapper = screen
    .getByTestId('tiptap-editor')
    .closest('[tabindex="-1"]');
  expect(wrapper).not.toBeNull();
  return wrapper as HTMLElement;
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
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('T136 — the message error is associated with the editor, not the wrapper', () => {
  it('member compose: the body error reaches TiptapEditor through `invalid` + `describedById`', () => {
    const tooLarge = `<p>${'x'.repeat(200 * 1024)}</p>`;
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ComposeForm
          audienceCeiling={5000}
          audienceMode="primary_only"
          initialSubject="Spring mixer"
          initialBodyHtml={tooLarge}
        />
      </NextIntlClientProvider>,
    );

    const editor = screen.getByTestId('tiptap-editor');
    expect(editor).toHaveAttribute('data-invalid', 'true');
    expect(editor).toHaveAttribute('data-describedby', 'broadcast-body-error');
    expect(document.getElementById('broadcast-body-error')).not.toBeNull();

    // The wrapper must no longer claim the association for itself.
    expect(bodyWrapper()).not.toHaveAttribute('aria-invalid');
    expect(bodyWrapper()).not.toHaveAttribute('aria-describedby');
  });

  it('staff compose-on-behalf: the body error reaches TiptapEditor through `invalid` + `describedById`', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 422,
        json: async () => ({ error: { code: 'broadcast_body_too_large' } }),
      }),
    );
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ProxyComposeForm audienceCeiling={5000} />
      </NextIntlClientProvider>,
    );

    await user.click(screen.getByRole('button', { name: 'pick-member' }));
    await user.type(screen.getByLabelText('Subject'), 'Spring mixer');
    await user.type(screen.getByLabelText('Message body'), '<p>Hello</p>');
    await user.click(screen.getByRole('button', { name: /Submit for review/ }));

    await waitFor(() =>
      expect(screen.getByTestId('tiptap-editor')).toHaveAttribute(
        'data-invalid',
        'true',
      ),
    );
    expect(screen.getByTestId('tiptap-editor')).toHaveAttribute(
      'data-describedby',
      'proxy-broadcast-body-error',
    );
    expect(document.getElementById('proxy-broadcast-body-error')).not.toBeNull();

    expect(bodyWrapper()).not.toHaveAttribute('aria-invalid');
    expect(bodyWrapper()).not.toHaveAttribute('aria-describedby');
  });
});
