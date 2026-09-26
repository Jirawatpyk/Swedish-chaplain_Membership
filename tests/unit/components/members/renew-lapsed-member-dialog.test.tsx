/**
 * 106-void-on-reissue follow-up — `<RenewLapsedMemberDialog>` surfaces the
 * route's `supersede_issues` (an older unpaid bill the reactivation could not
 * auto-void) as the SAME translated, linked warning toast the auto-renewal
 * queue uses — never a raw server string.
 *
 * Real `NextIntlClientProvider` + shipped messages; `fetch`, `sonner` and
 * `next/navigation` mocked (mirrors `auto-renewal-queue-actions.test.tsx`).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import th from '@/i18n/messages/th.json';
import { toast } from '@/lib/toast';

vi.mock('@/lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

const refreshSpy = vi.fn();
const pushSpy = vi.hoisted(() => vi.fn());
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: refreshSpy, push: pushSpy }) }));

const { RenewLapsedMemberDialog } = await import(
  '@/components/members/renew-lapsed-member-dialog'
);

type Messages = typeof en;

function renderDialog(locale: 'en' | 'th', messages: Messages) {
  return render(
    <NextIntlClientProvider
      locale={locale}
      messages={messages as unknown as Record<string, unknown>}
    >
      <RenewLapsedMemberDialog memberId="mem-1" />
    </NextIntlClientProvider>,
  );
}

async function confirmRenew(messages: Messages) {
  const t = messages.admin.members.detail.renewLapsed;
  fireEvent.click(screen.getByRole('button', { name: t.trigger }));
  fireEvent.click(await screen.findByRole('button', { name: t.confirm }));
}

function mockRenewResponse(body: Record<string, unknown>) {
  vi.spyOn(globalThis, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => body,
  } as Response);
}

beforeEach(() => {
  vi.useRealTimers();
  vi.mocked(toast.success).mockClear();
  vi.mocked(toast.warning).mockClear();
  refreshSpy.mockReset();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useFakeTimers();
});

describe('<RenewLapsedMemberDialog> — supersede-void warning', () => {
  it('shows a persistent, translated warning naming the old bill + a link to it (never the raw server string)', async () => {
    mockRenewResponse({
      cycle_id: 'cyc-1',
      invoice_id: 'inv-1',
      cycle_status: 'awaiting_payment',
      supersede_issues: [
        {
          kind: 'void_failed',
          invoice_id: 'inv-old-1',
          bill_document_number: 'SC-2026-000123',
          error_code: 'refund_in_progress',
        },
      ],
    });
    const w = en.admin.invoices.supersedeWarning;
    renderDialog('en', en);
    await confirmRenew(en);

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith(
        en.admin.members.detail.renewLapsed.toast.success,
      ),
    );
    expect(toast.warning).toHaveBeenCalledWith(
      w.title,
      expect.objectContaining({ duration: Infinity, closeButton: true }),
    );
    // Plain-text description + one action (spec 122 R4; AURA handoff #53).
    const opts = vi.mocked(toast.warning).mock.calls[0]![1] as {
      description: string;
      action: { label: string; onClick: () => void };
    };
    expect(opts.description).toContain(w.voidFailed.replace('{number}', 'SC-2026-000123'));
    expect(opts.description).not.toMatch(/supersede:|inv-old-1/);
    expect(opts.action.label).toBe(w.openBill.replace('{number}', 'SC-2026-000123'));
    opts.action.onClick();
    expect(pushSpy).toHaveBeenCalledWith('/admin/invoices/inv-old-1');
  });

  it('renders the warning in Thai for a TH admin', async () => {
    mockRenewResponse({
      cycle_id: 'cyc-1',
      invoice_id: 'inv-1',
      cycle_status: 'awaiting_payment',
      supersede_issues: [{ kind: 'list_failed' }],
    });
    const w = th.admin.invoices.supersedeWarning;
    renderDialog('th', th as unknown as Messages);
    await confirmRenew(th as unknown as Messages);

    await waitFor(() => expect(toast.warning).toHaveBeenCalled());
    const [title, opts] = vi.mocked(toast.warning).mock.calls[0]! as [
      string,
      { description: string; action?: unknown },
    ];
    expect(title).toBe(w.title);
    expect(opts.description).toBe(w.listFailed);
    expect(opts.action).toBeUndefined();
  });

  it('no supersede issues → success toast only', async () => {
    mockRenewResponse({
      cycle_id: 'cyc-1',
      invoice_id: 'inv-1',
      cycle_status: 'awaiting_payment',
      supersede_issues: [],
    });
    renderDialog('en', en);
    await confirmRenew(en);

    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(toast.warning).not.toHaveBeenCalled();
  });
});
