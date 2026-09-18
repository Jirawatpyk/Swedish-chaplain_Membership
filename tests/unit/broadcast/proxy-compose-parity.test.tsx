/**
 * F119 T137 (US6-AS5, FR-039).
 *
 * "The writing tool MUST be the same for members writing an original and for
 * marketing formatting a version" — so the staff compose-on-behalf screen has
 * to offer what the member screen offers. Today `proxy-compose-form.tsx` has
 * none of it except the preview.
 *
 * The last three parity items — draft save/resume, inline images and the
 * proxied member's allowance — were `it.todo` until T145 added the two thin
 * staff routes they each need (`POST | PUT /api/admin/broadcasts/draft` and
 * `GET /api/admin/broadcasts/quota?memberId=`, contract § the two new
 * sections). They are asserted here now; absent was the defect, not the
 * contract.
 *
 * Rendered under `NextIntlClientProvider` with the REAL `en.json`.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
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

const MEMBER_ID = '22222222-2222-2222-2222-222222222222';
const DRAFT_ID = '99999999-9999-9999-9999-999999999999';

vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: (props: {
    onSelect: (m: {
      memberId: string;
      companyName: string;
      hasPrimaryContactEmail: boolean;
    }) => void;
  }) => (
    <button
      type="button"
      onClick={() =>
        props.onSelect({
          memberId: MEMBER_ID,
          companyName: 'Acme Co',
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
      imagesEnabled?: boolean;
      draftId?: string | null;
      imageUploadUrl?: string;
    }): React.ReactElement {
      return (
        <textarea
          aria-label="Message body"
          data-images-enabled={String(props.imagesEnabled ?? false)}
          data-draft-id={props.draftId ?? ''}
          data-image-upload-url={props.imageUploadUrl ?? ''}
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

function renderForm(props?: { imagesEnabled?: boolean }): void {
  render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ProxyComposeForm
        audienceCeiling={5000}
        templates={[TEMPLATE]}
        {...(props?.imagesEnabled !== undefined
          ? { imagesEnabled: props.imagesEnabled }
          : {})}
      />
    </NextIntlClientProvider>,
  );
}

/** URLs the component fetched, in call order. */
function fetchedUrls(): string[] {
  return (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls.map(
    (c) => String(c[0]),
  );
}

function fetchCallFor(url: string): { url: string; init: RequestInit } | null {
  const calls = (globalThis.fetch as unknown as { mock: { calls: unknown[][] } }).mock
    .calls;
  const hit = calls.find((c) => String(c[0]).startsWith(url));
  return hit ? { url: String(hit[0]), init: (hit[1] ?? {}) as RequestInit } : null;
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
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ broadcastId: DRAFT_ID }),
    }),
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

  it('offers draft save/resume — saves the named member against the STAFF draft route and clears the guard', async () => {
    const user = userEvent.setup();
    renderForm();

    await user.click(screen.getByRole('button', { name: 'pick-member' }));
    await user.type(screen.getByLabelText('Subject'), 'Spring mixer');
    expect(beforeUnloadWouldPrompt()).toBe(true);

    await user.click(screen.getByRole('button', { name: 'Save as draft' }));

    const call = fetchCallFor('/api/admin/broadcasts/draft');
    expect(call).not.toBeNull();
    expect(call!.init.method).toBe('POST');
    expect(JSON.parse(String(call!.init.body))).toMatchObject({
      memberId: MEMBER_ID,
      subject: 'Spring mixer',
    });

    // The receipt the member form shows, and the guard it clears (FR-045).
    await waitFor(() =>
      expect(screen.getByTestId('compose-saved-at')).toBeInTheDocument(),
    );
    expect(beforeUnloadWouldPrompt()).toBe(false);

    // A second save updates rather than creating a second row.
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));
    await waitFor(() => {
      const puts = (
        globalThis.fetch as unknown as { mock: { calls: unknown[][] } }
      ).mock.calls.filter(
        (c) =>
          String(c[0]) === '/api/admin/broadcasts/draft' &&
          (c[1] as RequestInit | undefined)?.method === 'PUT',
      );
      expect(puts).toHaveLength(1);
      expect(JSON.parse(String((puts[0]![1] as RequestInit).body))).toMatchObject({
        draftId: DRAFT_ID,
      });
    });
  });

  it('offers inline images — the editor gets imagesEnabled, the saved draft id and the STAFF upload endpoint', async () => {
    const user = userEvent.setup();
    renderForm({ imagesEnabled: true });

    const editor = screen.getByLabelText('Message body');
    expect(editor).toHaveAttribute('data-images-enabled', 'true');
    // No draft yet → no id to own an image.
    expect(editor).toHaveAttribute('data-draft-id', '');

    await user.click(screen.getByRole('button', { name: 'pick-member' }));
    await user.type(screen.getByLabelText('Subject'), 'Spring mixer');
    await user.click(screen.getByRole('button', { name: 'Save as draft' }));

    await waitFor(() =>
      expect(screen.getByLabelText('Message body')).toHaveAttribute(
        'data-draft-id',
        DRAFT_ID,
      ),
    );
    expect(screen.getByLabelText('Message body')).toHaveAttribute(
      'data-image-upload-url',
      `/api/admin/broadcasts/${DRAFT_ID}/images`,
    );
  });

  it("offers the proxied member's allowance — nothing before a member is picked, then the STAFF quota route for that member", async () => {
    const user = userEvent.setup();
    renderForm();

    expect(screen.queryByTestId('quota-display')).not.toBeInTheDocument();
    expect(fetchedUrls().some((u) => u.includes('/quota'))).toBe(false);

    await user.click(screen.getByRole('button', { name: 'pick-member' }));

    await waitFor(() =>
      expect(screen.getByTestId('quota-display')).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(
        fetchedUrls().some(
          (u) => u === `/api/admin/broadcasts/quota?memberId=${MEMBER_ID}`,
        ),
      ).toBe(true),
    );
  });
});
