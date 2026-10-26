// @vitest-environment jsdom
/**
 * Spec 122 US12d-3 (T1265) — staff compose on behalf asks before it sends
 * (the maintainer, 26 Oct 2026): "Submit on behalf of {company}?", with the
 * member's own allowance, so an admin sees whose E-Blast is being spent.
 */
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '@/i18n/messages/en.json';
import type { MemberPickerOption } from '@/components/broadcast/member-picker';

let capturedOnSelect: ((m: MemberPickerOption) => void) | null = null;
vi.mock('@/components/broadcast/member-picker', () => ({
  MemberPicker: ({ onSelect }: { onSelect: (m: MemberPickerOption) => void }) => {
    capturedOnSelect = onSelect;
    return <div data-testid="member-picker" />;
  },
}));
vi.mock('@/components/broadcast/recipient-count', () => ({
  useRecipientCount: () => ({ status: 'ready', count: 130, ceiling: 500, exceeds: false }),
  RecipientCountLine: () => null,
}));
vi.mock('@/components/broadcast/preview-pane', () => ({
  PreviewPane: () => <div data-testid="preview-pane" />,
}));
vi.mock('@/components/shell/tiptap-loader', () => ({
  loadTiptapEditor: () =>
    function TiptapStub({ onChange }: { onChange: (html: string) => void }): React.ReactElement {
      return <textarea aria-label="Message body" onChange={(e) => onChange(e.target.value)} />;
    },
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { ProxyComposeForm } = await import('@/components/broadcast/proxy-compose-form');

const p = en.admin.broadcasts.proxySubmitDialog;
const MEMBER: MemberPickerOption = {
  memberId: 'm-1',
  companyName: 'Bangkok Freight Nordic Co., Ltd.',
  primaryContactName: 'Malin Berg',
  hasPrimaryContactEmail: true,
} as MemberPickerOption;

let fetchMock: ReturnType<typeof vi.fn>;
const submitCalls = (): unknown[][] =>
  fetchMock.mock.calls.filter(([input]) => String(input).includes('/proxy-submit'));

beforeEach(() => {
  vi.useRealTimers();
  fetchMock = vi.fn(async (input: unknown) => {
    if (String(input).includes('/proxy-submit')) {
      return new Response(JSON.stringify({ broadcastId: 'b-1' }), { status: 200 });
    }
    return new Response(
      JSON.stringify({ quotaYear: 2026, used: 1, reserved: 0, remaining: 5, cap: 6, planName: 'Premium Corporate' }),
      { status: 200 },
    );
  });
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  cleanup();
  capturedOnSelect = null;
  vi.unstubAllGlobals();
});

async function composeForMember(): Promise<ReturnType<typeof userEvent.setup>> {
  render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ProxyComposeForm audienceCeiling={500} />
    </NextIntlClientProvider>,
  );
  act(() => capturedOnSelect?.(MEMBER));
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: p.subjectLabel }), 'Warehouse open day');
  await user.type(screen.getByRole('textbox', { name: 'Message body' }), '<p>Tour</p>');
  await waitFor(() =>
    expect(fetchMock).toHaveBeenCalledWith('/api/admin/broadcasts/quota?memberId=m-1', expect.anything()),
  );
  return user;
}

describe('staff compose on behalf — Submit asks first (T1265)', () => {
  it('names the member and spends the member’s allowance', async () => {
    const user = await composeForMember();
    await user.click(screen.getByRole('button', { name: en.portal.broadcasts.compose.button.submit }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Submit on behalf of Bangkok Freight Nordic Co., Ltd.?',
    });
    const text = dialog.textContent ?? '';
    expect(text).toContain('Warehouse open day');
    expect(text).toContain('All members · 130 recipients');
    expect(text).toContain("Uses 1 of the member's 5 remaining E-Blasts for 2026");
    expect(submitCalls()).toHaveLength(0);

    await user.click(within(dialog).getByRole('button', { name: en.portal.broadcasts.compose.button.submit }));
    await waitFor(() => expect(submitCalls()).toHaveLength(1));
    expect(JSON.parse((submitCalls()[0]![1] as { body: string }).body)).toMatchObject({
      requestedByMemberId: 'm-1',
      subject: 'Warehouse open day',
    });
  });
});
