/**
 * F114 T061 — the resubmit mode of the portal change-request form (US3 AS3,
 * FR-023 "prefilled with exactly the rejected values").
 *
 *   - `overlayResubmit` (pure): only REJECTED proposed values replace the
 *     live record; approved fields keep their live (now applied) values; an
 *     address group substitutes every line; a pending request is not a
 *     resubmit source;
 *   - the form rendered with `resubmitOf`: the reviewer's reason is shown
 *     above the form (role=status), every Group B field is editable, and the
 *     rejected value is what the field starts with.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestView } from '@/lib/change-request-portal-view';
import { overlayResubmit, type ChangeRequestFormValues } from '@/lib/change-request-form-values';
import { PortalChangeRequestForm } from '@/components/members/change-requests/portal-change-request-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
const toastError = vi.fn();
vi.mock('sonner', () => ({ toast: { error: (...a: unknown[]) => toastError(...a), success: vi.fn(), info: vi.fn() } }));

const LIVE: ChangeRequestFormValues = {
  firstName: 'Anna',
  lastName: 'Svensson',
  phone: '+66899999999', // approved earlier → already applied live
  roleTitle: '',
  companyName: 'Nordic Co',
  website: '',
  description: 'Live description',
  regLine1: '1 Main Rd',
  regLine2: '',
  regSubDistrict: '',
  regCity: 'Bangkok',
  regProvince: '',
  regPostalCode: '10110',
  billLine1: '',
  billLine2: '',
  billSubDistrict: '',
  billCity: '',
  billProvince: '',
  billPostalCode: '',
  billCountry: '',
};

const DECIDED: ChangeRequestView = {
  id: '00000000-0000-4000-8000-000000000001',
  memberId: '11111111-1111-4111-8111-111111111111',
  scope: 'mixed',
  state: 'decided',
  outcome: 'partially_approved',
  withdrawnReason: null,
  submittedAt: '2026-09-11T08:00:00.000Z',
  submittedBy: { contactId: '22222222-2222-4222-8222-222222222222', displayName: 'Anna Svensson', isMe: true },
  decidedAt: '2026-09-11T09:00:00.000Z',
  decidedBy: 'organisation',
  decisionReason: 'Please use the registered description and a full billing address.',
  outcomeAcknowledgedAt: null,
  fields: [
    { key: 'phone', target: 'contact', seen: '+66812345678', proposed: '+66899999999', affectsTaxDocuments: false, outcome: 'approved', appliedAt: '2026-09-11T09:00:00.000Z' },
    { key: 'description', target: 'member', seen: 'Old', proposed: 'Proposed description', affectsTaxDocuments: false, outcome: 'rejected', appliedAt: null },
    {
      key: 'billing_address',
      target: 'member',
      seen: { line1: null, line2: null, sub_district: null, city: null, province: null, postal_code: null, country: null },
      proposed: { line1: 'Box 9', line2: null, sub_district: null, city: 'Stockholm', province: null, postal_code: '11122', country: 'SE' },
      affectsTaxDocuments: true,
      outcome: 'rejected',
      appliedAt: null,
    },
  ],
};

describe('overlayResubmit', () => {
  it('substitutes ONLY the rejected proposed values; approved fields keep the live value', () => {
    const out = overlayResubmit(LIVE, DECIDED);
    expect(out.phone).toBe('+66899999999'); // approved → live, untouched
    expect(out.description).toBe('Proposed description');
    expect(out.billLine1).toBe('Box 9');
    expect(out.billCity).toBe('Stockholm');
    expect(out.billPostalCode).toBe('11122');
    expect(out.billCountry).toBe('SE');
    expect(out.billLine2).toBe('');
    // everything else is the live record
    expect(out.companyName).toBe('Nordic Co');
    expect(out.regLine1).toBe('1 Main Rd');
  });

  it('a null / non-decided source leaves the values alone', () => {
    expect(overlayResubmit(LIVE, null)).toEqual(LIVE);
    expect(overlayResubmit(LIVE, { ...DECIDED, state: 'pending', outcome: null, fields: DECIDED.fields.map((f) => ({ ...f, outcome: null })) })).toEqual(LIVE);
  });
});

describe('PortalChangeRequestForm in resubmit mode', () => {
  it('shows the reason, starts from the rejected values, and keeps every Group B field editable', () => {
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PortalChangeRequestForm
          initialValues={overlayResubmit(LIVE, DECIDED)}
          canProposeCompanyFields
          pending={null}
          privacyNoticeHref="/privacy"
          resubmitOf={DECIDED}
        />
      </NextIntlClientProvider>,
    );
    const reason = screen.getByTestId('resubmit-reason');
    expect(reason).toHaveAttribute('role', 'status');
    expect(reason).toHaveTextContent('Please use the registered description and a full billing address.');

    const labels = enMessages.portal.changeRequests.form.fields;
    expect(screen.getByLabelText(labels.description, { exact: false })).toHaveValue('Proposed description');
    expect(screen.getByLabelText(labels.phone, { exact: false })).toHaveValue('+66899999999');
    // every Group B field is a live, enabled input (the approved ones too);
    // required fields carry a visual mark after the label text, hence exact: false
    for (const label of [labels.firstName, labels.lastName, labels.phone, labels.roleTitle, labels.companyName, labels.website, labels.description]) {
      expect(screen.getByLabelText(label, { exact: false })).toBeEnabled();
    }
    expect(screen.getAllByLabelText(labels.line1).every((el) => !(el as HTMLInputElement).disabled)).toBe(true);
  });
});

describe('PortalChangeRequestForm — a 2xx whose body cannot be parsed (round 5, silent-failure #4)', () => {
  it('is reported as an error, never announced as "nothing to submit" (the request may well exist)', async () => {
    const { fireEvent, waitFor } = await import('@testing-library/react');
    // the shared setup installs fake timers; `waitFor` needs real ones here
    // (the bulk-action-bar-enrol-toast precedent)
    vi.useRealTimers();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>edge interstitial</html>', { status: 201, headers: { 'content-type': 'text/html' } })));
    try {
      render(
        <NextIntlClientProvider locale="en" messages={enMessages}>
          <PortalChangeRequestForm initialValues={LIVE} canProposeCompanyFields pending={null} privacyNoticeHref="/privacy" resubmitOf={null} />
        </NextIntlClientProvider>,
      );
      fireEvent.click(screen.getByRole('button', { name: enMessages.portal.changeRequests.form.submit }));
      await waitFor(() => expect(toastError).toHaveBeenCalledWith(enMessages.portal.changeRequests.errors.generic));
      expect(screen.queryByText(enMessages.portal.changeRequests.status.nothingToSubmit)).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
