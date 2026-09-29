/**
 * 122 US5a (T508) — the staff change-request review on AURA (boards
 * `Admin-change-request`, `-confirm`).
 *
 * - Each field row has an AURA checkbox named "Approve <field>" and, as on the
 *   board, the row's state in words — "Will be approved" / "Will be rejected"
 *   — so the decision never rests on the tick alone.
 * - A contact-removed row stays reachable but inert (aria-disabled, explained
 *   by aria-describedby).
 * - The decision dialog's reason and note are AURA textareas with visible
 *   labels.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestReviewFieldView, StaffChangeRequestView } from '@/lib/change-request-staff-view';
import { ChangeRequestReviewClient } from '@/components/members/change-requests/change-request-review-client';
import { DECISION_REASON_MAX_LENGTH } from '@/modules/members/domain/change-request/change-request';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

afterEach(cleanup);

const REVIEW = enMessages.admin.changeRequests.review;
const DECISION = enMessages.admin.changeRequests.decision;

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

const base = {
  target: 'contact',
  affectsTaxDocuments: false,
  outcome: null,
  appliedAt: null,
  changedSinceSubmitted: false,
  alreadyCurrent: false,
  taxHint: null,
} as const;

const fields = [
  { ...base, key: 'phone', seen: '+66812345678', proposed: '+66899999999', current: '+66812345678', undecidable: null },
  { ...base, key: 'role_title', seen: 'CFO', proposed: 'CEO', current: 'CFO', undecidable: 'contact_removed' },
] as unknown as ChangeRequestReviewFieldView[];

function renderClient() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <ChangeRequestReviewClient request={request} fields={fields} canDecide />
    </NextIntlClientProvider>,
  );
}

const phoneLabel = enMessages.portal.changeRequests.diff.labels.phone;
const roleLabel = enMessages.portal.changeRequests.diff.labels.role_title;
const approveName = (field: string) => REVIEW.approveCheckbox.replace('{field}', field);

describe('change-request review on AURA (T508)', () => {
  it('each row is an AURA checkbox with the row state in words, as on the board', () => {
    renderClient();
    const phone = screen.getByRole('checkbox', { name: approveName(phoneLabel) });
    expect(phone.closest('.aura-check')).not.toBeNull();
    const row = phone.closest('[data-field-key="phone"]') as HTMLElement;
    expect(within(row).getByText(REVIEW.willApprove)).toBeInTheDocument();
    fireEvent.click(phone);
    expect(within(row).getByText(REVIEW.willReject)).toBeInTheDocument();
  });

  it('a contact-removed row is reachable but inert and explained', () => {
    renderClient();
    const email = screen.getByRole('checkbox', { name: approveName(roleLabel) });
    expect(email).toHaveAttribute('aria-disabled', 'true');
    expect(email).not.toBeDisabled();
    expect(email).toHaveAccessibleDescription(REVIEW.markers.contactRemoved);
    const row = email.closest('[data-field-key="role_title"]') as HTMLElement;
    expect(within(row).getByText(REVIEW.willReject)).toBeInTheDocument();
  });

  it('the decision dialog has AURA textareas with visible labels', () => {
    renderClient();
    fireEvent.click(screen.getByTestId('confirm-decision'));
    const dialog = screen.getByRole('alertdialog');
    const reason = within(dialog).getByTestId('decision-reason');
    expect(reason.closest('.aura-field')?.querySelector('label')).toHaveTextContent(DECISION.reasonLabel);
    const note = within(dialog).getByTestId('decision-note');
    expect(note.closest('.aura-field')?.querySelector('label')).toHaveTextContent(DECISION.noteLabel);
  });

  it('the reason keeps its counter, invalid state and an alert when too long, as before AURA', () => {
    renderClient();
    fireEvent.click(screen.getByTestId('confirm-decision'));
    const dialog = screen.getByRole('alertdialog');
    const reason = within(dialog).getByTestId('decision-reason');
    expect(reason.getAttribute('aria-describedby')?.split(' ')).toContain('decision-reason-counter');
    // One row is rejected, so a reason is required: whitespace alone is invalid.
    fireEvent.change(reason, { target: { value: '   ' } });
    expect(reason).toHaveAttribute('aria-invalid', 'true');
    fireEvent.change(reason, { target: { value: 'x'.repeat(DECISION_REASON_MAX_LENGTH + 1) } });
    const tooLong = DECISION.errors.tooLong.replace('{max}', String(DECISION_REASON_MAX_LENGTH));
    expect(within(dialog).getAllByRole('alert').some((a) => a.textContent?.includes(tooLong))).toBe(true);
  });
});

describe('change-request review — board content (US5a parity)', () => {
  it('bolds the counts in the selection summary', () => {
    renderClient();
    const summary = screen.getByTestId('selection-summary');
    expect(summary.querySelectorAll('strong').length).toBe(2);
  });

  it('a viewer who cannot decide sees no "Will be approved / rejected" words', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <ChangeRequestReviewClient request={request} fields={fields} canDecide={false} />
      </NextIntlClientProvider>,
    );
    expect(screen.queryByText(REVIEW.willApprove)).toBeNull();
    expect(screen.queryByText(REVIEW.willReject)).toBeNull();
  });

  it('shows the current value muted and the proposed value in semibold', () => {
    renderClient();
    const row = document.querySelector('[data-field-key="phone"]') as HTMLElement;
    expect(row.querySelector('[data-value="current"]')).toHaveClass('text-[var(--aura-fg-secondary)]');
    expect(row.querySelector('[data-value="proposed"]')).toHaveClass('font-semibold');
  });
});
