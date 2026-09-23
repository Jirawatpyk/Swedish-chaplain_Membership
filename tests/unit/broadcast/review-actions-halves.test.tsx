// @vitest-environment jsdom
/**
 * F119 B1 — `ReviewActions` offers each half of the Approve / Reject pair on
 * its own. The staff detail page asks for Reject alone on every stage past
 * `submitted` that can still be rejected (Approve there is approve-AS-
 * SUBMITTED, which only `submitted` has); the queue rows keep both (the
 * defaults). An absent half is ABSENT — no trigger, not a disabled one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';
import { ReviewActions } from '@/components/broadcast/admin/review-actions';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

afterEach(cleanup);

const ID = '11111111-1111-4111-8111-111111111111';

function renderActions(props: { showApprove?: boolean; showReject?: boolean }) {
  return render(
    <NextIntlClientProvider locale="en" messages={en}>
      <ReviewActions broadcastId={ID} {...props} />
    </NextIntlClientProvider>,
  );
}

const approve = () => screen.queryByRole('button', { name: en.admin.broadcasts.approveDialog.confirm });
const reject = () => screen.queryByRole('button', { name: en.admin.broadcasts.rejectDialog.confirm });

describe('ReviewActions — each half on its own (F119 B1)', () => {
  it('by default (the queue rows) both halves are offered', () => {
    renderActions({});
    expect(approve()).not.toBeNull();
    expect(reject()).not.toBeNull();
  });

  it('showApprove={false} → Reject only; Approve is absent, not disabled', () => {
    renderActions({ showApprove: false, showReject: true });
    expect(approve()).toBeNull();
    expect(reject()).not.toBeNull();
  });

  it('showReject={false} → Approve only', () => {
    renderActions({ showApprove: true, showReject: false });
    expect(approve()).not.toBeNull();
    expect(reject()).toBeNull();
  });
});
