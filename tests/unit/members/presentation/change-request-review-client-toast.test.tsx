/**
 * `ChangeRequestReviewClient` — the decide response handling (round 7, tests N1).
 * A COMMITTED decision must always toast a success: the outcome-specific copy
 * when the body names one, the neutral "recorded" copy when the body is
 * unparseable or carries no outcome — never a guessed outcome, never a thrown
 * parse error inside the dialog.
 */
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestReviewFieldView, StaffChangeRequestView } from '@/lib/change-request-staff-view';
import { ChangeRequestReviewClient } from '@/components/members/change-requests/change-request-review-client';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const toastSuccess = vi.fn();
vi.mock('sonner', () => ({ toast: { success: (...a: unknown[]) => toastSuccess(...a), error: vi.fn(), info: vi.fn() } }));

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

const fields: ChangeRequestReviewFieldView[] = [
  { key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: null, appliedAt: null, current: '+66812345678', changedSinceSubmitted: false, alreadyCurrent: false, taxHint: null, undecidable: null },
];

function renderClient() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ChangeRequestReviewClient request={request} fields={fields} canDecide />
    </NextIntlClientProvider>,
  );
}

async function decideWith(body: BodyInit, contentType = 'application/json') {
  vi.useRealTimers();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status: 200, headers: { 'content-type': contentType } })));
  renderClient();
  fireEvent.click(screen.getByTestId('confirm-decision'));
  const dialog = await screen.findByRole('alertdialog');
  const { within } = await import('@testing-library/react');
  fireEvent.click(within(dialog).getByRole('button', { name: /^approve all/i }));
}

describe('ChangeRequestReviewClient — success toasts', () => {
  it('a body naming the outcome toasts that outcome', async () => {
    try {
      await decideWith(JSON.stringify({ repeated: false, request: { ...request, state: 'decided', outcome: 'approved' } }));
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(enMessages.admin.changeRequests.decision.toast.approved));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('an unparseable 200 (or one with no outcome) toasts the neutral "recorded" copy — never a guessed outcome', async () => {
    try {
      await decideWith('<html>interstitial</html>', 'text/html');
      await waitFor(() => expect(toastSuccess).toHaveBeenCalledWith(enMessages.admin.changeRequests.decision.toast.recorded));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
