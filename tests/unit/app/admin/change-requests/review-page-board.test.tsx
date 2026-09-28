/**
 * 122 US5a — the change-request review page as the `Admin-change-request*`
 * boards draw it: the read-only notice carries its "View only" title, a
 * phone gets a "Change requests" back link, and the confirm bar is AURA's
 * sticky ActionBar with the selection summary as its status.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { ReactElement } from 'react';
import { NextIntlClientProvider, createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestReviewFieldView, StaffChangeRequestView } from '@/lib/change-request-staff-view';

vi.mock('next-intl/server', () => ({
  getTranslations: async (namespace: string) => createTranslator({ locale: 'en', messages: enMessages, namespace: namespace as never }),
  getLocale: async () => 'en',
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }), notFound: vi.fn() }));
vi.mock('next/headers', () => ({ headers: vi.fn() }));
vi.mock('@/lib/env', () => ({ env: { features: { memberChangeApproval: true } } }));
vi.mock('@/lib/rbac', () => ({ canPerform: vi.fn(), requirePagePermission: vi.fn() }));
vi.mock('@/lib/members-change-request-deps', () => ({ asMembersUserId: vi.fn(), buildChangeRequestDeps: vi.fn() }));
vi.mock('@/modules/members', () => ({ getChangeRequestReview: vi.fn() }));
vi.mock('@/lib/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const { renderChangeRequestReviewView } = await import('@/app/(staff)/admin/change-requests/[id]/page');

const REVIEW = enMessages.admin.changeRequests.review;

const request = {
  id: '00000000-0000-4000-8000-000000000001',
  memberId: '11111111-1111-4111-8111-111111111111',
  scope: 'own_contact',
  state: 'pending',
  outcome: null,
  withdrawnReason: null,
  replacedByRequestId: null,
  submittedAt: '2026-09-11T08:00:00.000Z',
  staffNotifiedAt: null,
  submittedBy: { contactId: 'c-1', displayName: 'Anna Svensson', roleAtSubmission: 'primary' },
  decidedBy: null,
  decidedAt: null,
  decisionReason: null,
  decisionNote: null,
  member: { companyName: 'Nordic Co', memberNumber: 152, status: 'active', archived: false },
  fields: [],
} as unknown as StaffChangeRequestView;

const fields = [
  {
    key: 'phone',
    target: 'contact',
    affectsTaxDocuments: false,
    outcome: null,
    appliedAt: null,
    changedSinceSubmitted: false,
    alreadyCurrent: false,
    taxHint: null,
    seen: '+66812345678',
    proposed: '+66899999999',
    current: '+66812345678',
    undecidable: null,
  },
] as unknown as ChangeRequestReviewFieldView[];

async function renderView(canWrite: boolean) {
  const tree = await renderChangeRequestReviewView({
    request,
    fields,
    member: { companyName: 'Nordic Co', erasing: false, archived: false },
    canWrite,
    canDecide: canWrite,
  });
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages} timeZone="Asia/Bangkok">
      {tree as ReactElement}
    </NextIntlClientProvider>,
  );
}

describe('change-request review page as on the board (US5a)', () => {
  it('titles the read-only notice "View only"', async () => {
    await renderView(false);
    const notice = screen.getByTestId('review-notice');
    expect(notice).toHaveTextContent(REVIEW.readOnlyTitle);
    expect(notice).toHaveTextContent(REVIEW.readOnly);
  });

  it('gives a phone a back link to the queue', async () => {
    await renderView(true);
    const back = screen.getByRole('link', { name: enMessages.admin.changeRequests.queue.title });
    expect(back).toHaveAttribute('href', '/admin/change-requests');
    expect(back).toHaveClass('sm:hidden');
  });

  it('puts the summary and Confirm in AURA’s sticky ActionBar', async () => {
    await renderView(true);
    const bar = screen.getByTestId('confirm-decision').closest('.aura-actionbar');
    expect(bar).not.toBeNull();
    expect(bar?.querySelector('[role="status"]')?.querySelector('[data-testid="selection-summary"]')).not.toBeNull();
  });
});
