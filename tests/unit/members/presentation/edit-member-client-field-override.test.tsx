/**
 * 127 — a 422 on the member-FIELD step (a legal entity type outside the plan
 * scope) opens the override dialog, and confirming re-submits the FIELD patch
 * with the reason. Before 127 the override dialog only ever re-sent the plan
 * payload, so a field-step 422 would have sent a plan change the admin never
 * asked for.
 *
 * Dialogs + MemberForm are stubbed to avoid Base UI jsdom hangs (D7).
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
  useLocale: () => 'en',
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: h.push, refresh: h.refresh }),
}));
vi.mock('@/lib/toast', () => ({ toast: h.toast }));
vi.mock('@/components/members/member-form', () => ({
  MemberForm: (props: { onSubmit: (v: unknown) => void }) => (
    <button type="button" onClick={() => props.onSubmit(h.values)}>
      stub-submit
    </button>
  ),
}));
vi.mock('@/components/members/plan-change-confirm-dialog', () => ({
  PlanChangeConfirmDialog: () => null,
}));
vi.mock('@/components/members/bundle-change-warning-dialog', () => ({
  BundleChangeWarningDialog: () => null,
}));
vi.mock('@/components/members/override-reason-dialog', () => ({
  OverrideReasonDialog: (props: {
    open: boolean;
    onConfirm: (r: { code: string; note: string | null }) => void;
  }) =>
    props.open ? (
      <button
        type="button"
        onClick={() => props.onConfirm({ code: 'board_approved', note: 'Sole trader' })}
      >
        confirm-override
      </button>
    ) : null,
}));

import { EditMemberClient } from '@/components/members/edit-member-client';

const MEMBER = {
  memberId: 'm1',
  companyName: 'Old Co',
  legalEntityType: 'limited_company',
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

const TYPE_CHANGE = {
  company_name: 'Old Co',
  legal_entity_type: 'individual',
  country: 'TH',
  notes: null,
  plan_id: 'premium',
  plan_year: 2026,
  registration_date: '2026-01-01',
  primary_contact: { first_name: 'A', last_name: 'B', email: 'a@b.com', preferred_language: 'en' },
};

function res(status: number, body: unknown): Response {
  return { status, ok: status >= 200 && status < 300, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('EditMemberClient — override on the member-field step (127)', () => {
  it('re-submits the FIELD patch with the override reason, never a plan payload', async () => {
    h.values = TYPE_CHANGE;
    fetchMock
      .mockResolvedValueOnce(
        res(422, {
          error: {
            code: 'member_type_warning',
            details: { type: 'member_type_out_of_scope', legalEntityType: 'individual', memberTypeScope: 'company' },
          },
        }),
      )
      .mockResolvedValueOnce(res(200, { member_id: 'm1' }));

    render(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      <EditMemberClient member={MEMBER as any} plans={PLANS} primaryContact={CONTACT} />,
    );
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(await screen.findByText('confirm-override'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const second = JSON.parse((fetchMock.mock.calls[1]![1] as { body: string }).body);
    expect(second.legal_entity_type).toBe('individual');
    expect(second.override_reason_code).toBe('board_approved');
    expect(second).not.toHaveProperty('new_plan_id');
  });
});
