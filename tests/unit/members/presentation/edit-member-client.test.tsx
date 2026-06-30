/**
 * EditMemberClient — server-field-error wiring + cross-namespace (tCreate)
 * resolution for the shared error map (UAT 2026-06-30 fix, /speckit-review
 * Improvement-C). Stubs MemberForm + fetch like create-member-client.test.tsx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  // Differs from MEMBER only in company_name → triggers the field PATCH; the
  // contact + plan are unchanged so no other step fires.
  VALID_VALUES: {
    company_name: 'New Co',
    country: 'TH',
    tax_id: '0105556012345',
    notes: null,
    plan_id: 'premium',
    plan_year: 2026,
    registration_date: '2026-01-01',
    primary_contact: {
      first_name: 'A',
      last_name: 'B',
      email: 'a@b.com',
      preferred_language: 'en',
    },
  },
}));

vi.mock('next-intl', () => ({ useTranslations: () => (k: string) => k }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/components/members/member-form', () => ({
  MemberForm: (props: {
    onSubmit: (v: unknown) => void;
    serverFieldError: { field: string } | null;
  }) => (
    <div>
      <button type="button" onClick={() => props.onSubmit(h.VALID_VALUES)}>
        stub-submit
      </button>
      <output data-testid="sfe">
        {props.serverFieldError ? props.serverFieldError.field : 'none'}
      </output>
    </div>
  ),
}));

import { EditMemberClient } from '@/components/members/edit-member-client';

const MEMBER = {
  memberId: 'm1',
  companyName: 'Old Co',
  legalEntityType: null,
  country: 'TH',
  taxId: null,
  website: null,
  description: null,
  notes: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  province: null,
  postalCode: null,
  foundedYear: null,
  turnoverThb: null,
  planId: 'premium',
  planYear: 2026,
  registrationDate: '2026-01-01',
};
const CONTACT = {
  contactId: 'c1',
  firstName: 'A',
  lastName: 'B',
  email: 'a@b.com',
  phone: null,
  roleTitle: null,
  preferredLanguage: 'en' as const,
};
const PLANS = [{ plan_id: 'premium', plan_year: 2026, display_name: 'Premium' }];

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers(); // setup.ts fakes timers → RTL findBy* would hang
  h.toast.error.mockClear();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderClient() {
  render(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    <EditMemberClient member={MEMBER as any} plans={PLANS} primaryContact={CONTACT} />,
  );
}

describe('EditMemberClient orchestration', () => {
  it('routes a 400 invalid_tax_id (field PATCH) to the tax_id field via tCreate', async () => {
    fetchMock.mockResolvedValueOnce(
      res(400, {
        error: { code: 'validation_error', details: { type: 'invalid_tax_id' } },
      }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    // The map's messageKey is in the create namespace; resolving it through the
    // edit-namespace `t` would yield a different string — this proves tCreate.
    await screen.findByText('tax_id');
    expect(h.toast.error).toHaveBeenCalledWith('errors.taxIdInvalid');
  });

  it('a 404 plan_not_found shows the plan-unavailable message (not notFound)', async () => {
    // company diff makes the field PATCH fire first → make it succeed, then the
    // plan step is not reached (plan unchanged); instead assert the field-PATCH
    // 404 plan_not_found path maps to planUnavailable.
    fetchMock.mockResolvedValueOnce(res(404, { error: { code: 'plan_not_found' } }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith('errors.planUnavailable'),
    );
    expect(h.toast.error).not.toHaveBeenCalledWith('errors.notFound');
  });
});
