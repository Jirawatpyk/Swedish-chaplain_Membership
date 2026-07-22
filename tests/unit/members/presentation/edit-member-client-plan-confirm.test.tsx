/**
 * WP7 — EditMemberClient plan-change confirm-gate orchestration (BP3, D7).
 *
 * Pins the state-machine ordering: an unconditional plan-change confirm gates
 * BEFORE any request; a non-plan edit submits immediately; confirming fires the
 * PATCH sequence with the plan change LAST; and the server-driven 409 bundle /
 * 422 override dialogs open post-request WITHOUT re-prompting the plan gate.
 *
 * Downstream dialogs (plan-confirm, bundle, override) + MemberForm are stubbed
 * to avoid Base UI jsdom hangs (D7) — the orchestration is what's under test.
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
vi.mock('sonner', () => ({ toast: h.toast }));
vi.mock('@/components/members/member-form', () => ({
  MemberForm: (props: { onSubmit: (v: unknown) => void }) => (
    <button type="button" onClick={() => props.onSubmit(h.values)}>
      stub-submit
    </button>
  ),
}));
vi.mock('@/components/members/plan-change-confirm-dialog', () => ({
  PlanChangeConfirmDialog: (props: {
    open: boolean;
    onConfirm: () => void;
    onOpenChange: (next: boolean) => void;
  }) =>
    props.open ? (
      <div data-testid="plan-confirm">
        <button type="button" onClick={props.onConfirm}>
          confirm-plan
        </button>
        <button type="button" onClick={() => props.onOpenChange(false)}>
          cancel-plan
        </button>
      </div>
    ) : null,
}));
vi.mock('@/components/members/bundle-change-warning-dialog', () => ({
  BundleChangeWarningDialog: (props: { open: boolean }) =>
    props.open ? <div data-testid="bundle-dialog" /> : null,
}));
vi.mock('@/components/members/override-reason-dialog', () => ({
  OverrideReasonDialog: (props: { open: boolean }) =>
    props.open ? <div data-testid="override-dialog" /> : null,
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
const PLANS = [
  { plan_id: 'premium', plan_year: 2026, display_name: 'Premium — 2026' },
  { plan_id: 'regular', plan_year: 2026, display_name: 'Regular — 2026' },
  { plan_id: 'premium', plan_year: 2027, display_name: 'Premium — 2027' },
];

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
const COMPANY_ONLY = { ...MATCH, company_name: 'New Co' };
const PLAN_ONLY = { ...MATCH, plan_id: 'regular' };
const YEAR_ONLY = { ...MATCH, plan_year: 2027 };
const COMPANY_AND_PLAN = { ...MATCH, company_name: 'New Co', plan_id: 'regular' };

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.useRealTimers();
  h.push.mockClear();
  h.refresh.mockClear();
  h.toast.success.mockClear();
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
    <EditMemberClient
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      member={MEMBER as any}
      plans={PLANS}
      primaryContact={CONTACT}
    />,
  );
}

describe('EditMemberClient — plan-change confirm gate', () => {
  it('gates a plan change behind the confirm dialog before any request', () => {
    h.values = PLAN_ONLY;
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    expect(screen.getByTestId('plan-confirm')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gates a plan_year-only change too', () => {
    h.values = YEAR_ONLY;
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    expect(screen.getByTestId('plan-confirm')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gates a combined company+plan change before ANY request', () => {
    h.values = COMPANY_AND_PLAN;
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    expect(screen.getByTestId('plan-confirm')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('submits a non-plan edit immediately (no gate)', async () => {
    h.values = COMPANY_ONLY;
    fetchMock.mockResolvedValueOnce(res(200, {}));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    expect(screen.queryByTestId('plan-confirm')).toBeNull();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  it('Cancel on the gate is a true no-op — nothing persisted', () => {
    h.values = PLAN_ONLY;
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('cancel-plan'));
    expect(screen.queryByTestId('plan-confirm')).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('on confirm fires the PATCH sequence with the plan change LAST', async () => {
    h.values = COMPANY_AND_PLAN;
    fetchMock.mockResolvedValue(res(200, {}));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('confirm-plan'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const firstBody = JSON.parse(
      (fetchMock.mock.calls[0]![1] as RequestInit).body as string,
    );
    const secondBody = JSON.parse(
      (fetchMock.mock.calls[1]![1] as RequestInit).body as string,
    );
    // Company field PATCH first, plan change PATCH last.
    expect(firstBody).toHaveProperty('company_name', 'New Co');
    expect(firstBody).not.toHaveProperty('new_plan_id');
    expect(secondBody).toHaveProperty('new_plan_id', 'regular');
  });

  it('a 409 opens the bundle dialog without re-prompting the plan gate', async () => {
    h.values = PLAN_ONLY;
    fetchMock.mockResolvedValueOnce(
      res(409, {
        error: {
          code: 'bundle_change_requires_confirmation',
          details: {
            oldBundleCorporatePlanId: 'corp-a',
            newBundleCorporatePlanId: 'corp-b',
          },
        },
      }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('confirm-plan'));

    await vi.waitFor(() =>
      expect(screen.getByTestId('bundle-dialog')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('plan-confirm')).toBeNull();
  });

  it('a 422 opens the override dialog without re-prompting the plan gate', async () => {
    h.values = PLAN_ONLY;
    fetchMock.mockResolvedValueOnce(res(422, { error: { details: {} } }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('confirm-plan'));

    await vi.waitFor(() =>
      expect(screen.getByTestId('override-dialog')).toBeInTheDocument(),
    );
    expect(screen.queryByTestId('plan-confirm')).toBeNull();
  });
});

/**
 * Phase 2 UI wiring — the PATCH response for a plan change now carries a
 * server-computed `billing_effect` discriminator (applied-now vs
 * applies-next-cycle). The post-success toast description must reflect the
 * ACTUAL outcome. Copy is asserted via the sonner mock (base-ui toasts render
 * in a portal — the sonner mock is the reliable assertion surface, not the DOM).
 */
describe('EditMemberClient — plan-change billing-effect toast', () => {
  it('surfaces the applied-now effect on a successful plan change', async () => {
    h.values = PLAN_ONLY;
    fetchMock.mockResolvedValueOnce(
      res(200, {
        member_id: 'm1',
        billing_effect: { effect: 'applied_to_open_cycle' },
      }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('confirm-plan'));

    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith('admin.members.edit.success', {
        description: 'admin.members.planChangeResult.applied_to_open_cycle',
      }),
    );
  });

  it('surfaces the deferred effect (flag-off default) on a successful plan change', async () => {
    h.values = PLAN_ONLY;
    fetchMock.mockResolvedValueOnce(
      res(200, {
        member_id: 'm1',
        billing_effect: { effect: 'deferred_immediate_not_enabled' },
      }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('confirm-plan'));

    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith('admin.members.edit.success', {
        description:
          'admin.members.planChangeResult.deferred_immediate_not_enabled',
      }),
    );
  });

  it('falls back to the plain success toast when billing_effect is absent (no regression)', async () => {
    h.values = PLAN_ONLY;
    fetchMock.mockResolvedValueOnce(res(200, { member_id: 'm1' }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('confirm-plan'));

    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith('admin.members.edit.success'),
    );
    // No effect → no description argument (the pre-Phase-2 plain toast).
    expect(h.toast.success).not.toHaveBeenCalledWith(
      'admin.members.edit.success',
      expect.anything(),
    );
  });

  it('falls back to the plain success toast for an unknown effect string', async () => {
    h.values = PLAN_ONLY;
    fetchMock.mockResolvedValueOnce(
      res(200, { member_id: 'm1', billing_effect: { effect: 'something_new' } }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    fireEvent.click(screen.getByText('confirm-plan'));

    await vi.waitFor(() =>
      expect(h.toast.success).toHaveBeenCalledWith('admin.members.edit.success'),
    );
    expect(h.toast.success).not.toHaveBeenCalledWith(
      'admin.members.edit.success',
      expect.anything(),
    );
  });
});
