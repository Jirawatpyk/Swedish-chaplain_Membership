/**
 * EditMemberClient orchestration (UAT 2026-06-30 fix + /speckit-review Imp-C and
 * round-2 Gap-B/C). Stubs MemberForm + fetch like create-member-client.test.tsx.
 *
 * next-intl is mocked to return `${namespace}.${key}` (not a bare echo) so a
 * toast assertion can DISTINGUISH the create-namespace `tCreate` resolution from
 * the edit-namespace `t` — the round-2 reviewer noted a bare echo can't.
 *
 * The submit payload is read from the mutable `h.values` so each test can target
 * a single edit step (company → field PATCH, email/phone → contact PATCH) by
 * diffing only the relevant field from MEMBER/CONTACT.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

const h = vi.hoisted(() => ({
  push: vi.fn(),
  refresh: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  values: {} as Record<string, unknown>,
}));

vi.mock('next-intl', () => ({
  useTranslations: (ns: string) => (k: string) => `${ns}.${k}`,
}));
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
      <button type="button" onClick={() => props.onSubmit(h.values)}>
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
  dateOfBirth: null,
};
const PLANS = [{ plan_id: 'premium', plan_year: 2026, display_name: 'Premium' }];

// A payload matching MEMBER/CONTACT exactly (no diff → no step fires).
const MATCH = {
  company_name: 'Old Co',
  country: 'TH',
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
};
const COMPANY_DIFF = { ...MATCH, company_name: 'New Co' }; // → field PATCH
const EMAIL_DIFF = {
  ...MATCH,
  primary_contact: { ...MATCH.primary_contact, email: 'new@b.com' },
}; // → contact email PATCH
const PHONE_DIFF = {
  ...MATCH,
  primary_contact: { ...MATCH.primary_contact, phone: '+66811111111' },
}; // → contact fields PATCH

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
    h.values = COMPANY_DIFF;
    fetchMock.mockResolvedValueOnce(
      res(400, {
        error: { code: 'validation_error', details: { type: 'invalid_tax_id' } },
      }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await screen.findByText('tax_id');
    // The CREATE-namespaced message proves the field was resolved via tCreate,
    // not the edit-namespace `t` (which would yield admin.members.edit.*).
    expect(h.toast.error).toHaveBeenCalledWith(
      'admin.members.create.errors.taxIdInvalid',
    );
  });

  it('a 404 plan_not_found (field PATCH) shows the plan-unavailable message', async () => {
    h.values = COMPANY_DIFF;
    fetchMock.mockResolvedValueOnce(res(404, { error: { code: 'plan_not_found' } }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        'admin.members.create.errors.planUnavailable',
      ),
    );
    expect(h.toast.error).not.toHaveBeenCalledWith('admin.members.edit.errors.notFound');
  });

  it('a contact-email 400 invalid_email highlights the email field', async () => {
    h.values = EMAIL_DIFF;
    fetchMock.mockResolvedValueOnce(
      res(400, { error: { code: 'validation_error', details: { field: 'email' } } }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await screen.findByText('primary_contact.email');
    expect(h.toast.error).toHaveBeenCalledWith(
      'admin.members.create.fields.errors.emailFormat',
    );
  });

  it('a contact-email 409 conflict highlights the email field (edit-namespace toast)', async () => {
    h.values = EMAIL_DIFF;
    fetchMock.mockResolvedValueOnce(res(409, { error: { code: 'conflict' } }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await screen.findByText('primary_contact.email');
    expect(h.toast.error).toHaveBeenCalledWith('admin.members.edit.errors.emailTaken');
  });

  it('a contact-save 503 outage maps to the retryable serverBusy toast (parity with the member-field step) — G23', async () => {
    h.values = EMAIL_DIFF;
    fetchMock.mockResolvedValueOnce(
      res(503, { error: { code: 'idempotency_reservation_failed' } }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith(
        'admin.members.create.errors.serverBusy',
      ),
    );
    // Must NOT read as a permanent failure (the pre-fix generic dead-end).
    expect(h.toast.error).not.toHaveBeenCalledWith(
      'admin.members.edit.errors.generic',
    );
  });

  it('a contact-fields 400 invalid_phone highlights the phone field', async () => {
    h.values = PHONE_DIFF;
    fetchMock.mockResolvedValueOnce(
      res(400, {
        error: { code: 'validation_error', details: { type: 'invalid_phone' } },
      }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await screen.findByText('primary_contact.phone');
    expect(h.toast.error).toHaveBeenCalledWith(
      'admin.members.edit.errors.invalidPhone',
    );
  });
});
