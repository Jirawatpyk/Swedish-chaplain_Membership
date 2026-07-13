/**
 * CreateMemberClient orchestration (UAT 2026-06-30 fix).
 *
 * The risk-bearing wrapper logic — idempotency-key lifecycle (Bug-C), the
 * handleResponse branch ordering (soft_duplicate/422 win over the field-error
 * map), the server-error→field routing, and the success redirect — lives in a
 * closure inside the client and can't be extracted into a pure helper. We test
 * it by stubbing MemberForm to a button that fires `onSubmit` with a fixed valid
 * payload + reflecting `serverFieldError` into the DOM, and mocking `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

// Hoisted so the (hoisted) vi.mock factories can reference them safely.
const h = vi.hoisted(() => ({
  push: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
  VALID_VALUES: {
    company_name: 'Acme Co',
    country: 'TH',
    notes: 'Renewal handled by finance',
    sub_district: 'คลองตันเหนือ',
    registered_capital_thb: 5_000_000,
    plan_id: 'premium',
    plan_year: 2026,
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
  useRouter: () => ({ push: h.push, refresh: vi.fn() }),
}));
vi.mock('sonner', () => ({ toast: h.toast }));

// Stub the form: a submit button that fires the wrapper's onSubmit, plus a live
// readout of the serverFieldError prop so tests can assert field routing.
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

import { CreateMemberClient } from '@/components/members/create-member-client';

const PLANS = [{ plan_id: 'premium', plan_year: 2026, display_name: 'Premium' }];

function res(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

/** The idempotency-key header sent on the Nth (0-based) fetch call. */
function idemKeyOf(call: number): string {
  const init = fetchMock.mock.calls[call]?.[1] as RequestInit | undefined;
  const key = (init?.headers as Record<string, string> | undefined)?.[
    'idempotency-key'
  ];
  if (!key) throw new Error(`no idempotency-key on fetch call ${call}`);
  return key;
}

beforeEach(() => {
  // setup.ts installs fake timers globally; RTL's async findBy* + waitFor poll
  // on real timers, so they'd hang for the full 30s without this.
  vi.useRealTimers();
  h.push.mockClear();
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
  render(<CreateMemberClient plans={PLANS} defaultPlanYear={2026} />);
}

describe('CreateMemberClient orchestration', () => {
  it('Bug-C: refreshes the idempotency key after a failed (non-201) submit', async () => {
    fetchMock
      .mockResolvedValueOnce(
        res(400, {
          error: { code: 'validation_error', details: { type: 'invalid_tax_id' } },
        }),
      )
      .mockResolvedValueOnce(res(201, { member_id: 'm1' }));

    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));
    await screen.findByText('tax_id'); // serverFieldError routed to tax_id
    expect(idemKeyOf(0)).toBeTruthy();

    fireEvent.click(screen.getByText('stub-submit'));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // The corrected retry MUST carry a fresh key, else the server returns
    // idempotency_conflict (409) forever — the exact Bug-C regression.
    expect(idemKeyOf(1)).not.toBe(idemKeyOf(0));
  });

  it('Gap-B: a 409 soft_duplicate opens the dialog and does NOT highlight a field', async () => {
    fetchMock.mockResolvedValueOnce(
      res(409, {
        error: {
          code: 'soft_duplicate',
          details: { existingMemberId: 'm9', existingCompanyName: 'Dup' },
        },
      }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await screen.findByRole('dialog'); // SoftDuplicateDialog opened
    expect(screen.getByTestId('sfe').textContent).toBe('none');
  });

  it('a 409 conflict highlights the email field (not the dialog)', async () => {
    fetchMock.mockResolvedValueOnce(res(409, { error: { code: 'conflict' } }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await screen.findByText('primary_contact.email');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('a 201 redirects to the new member detail page', async () => {
    fetchMock.mockResolvedValueOnce(res(201, { member_id: 'm-new' }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() =>
      expect(h.push).toHaveBeenCalledWith('/admin/members/m-new'),
    );
    expect(screen.getByTestId('sfe').textContent).toBe('none');
  });

  it('a 404 plan_not_found shows the plan-unavailable message (not generic)', async () => {
    fetchMock.mockResolvedValueOnce(res(404, { error: { code: 'plan_not_found' } }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith('errors.planUnavailable'),
    );
    expect(h.toast.error).not.toHaveBeenCalledWith('errors.generic');
  });

  it('a 503 shows the retryable server-busy message (not generic)', async () => {
    fetchMock.mockResolvedValueOnce(
      res(503, { error: { code: 'idempotency_reservation_failed' } }),
    );
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() =>
      expect(h.toast.error).toHaveBeenCalledWith('errors.serverBusy'),
    );
    expect(h.toast.error).not.toHaveBeenCalledWith('errors.generic');
  });

  it('forwards notes into the create payload (Task 1: notes accepted on create)', async () => {
    fetchMock.mockResolvedValueOnce(res(201, { member_id: 'm-notes' }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.notes).toBe('Renewal handled by finance');
  });

  it('forwards sub_district into the create payload (PR-B task 6 — แขวง/ตำบล)', async () => {
    fetchMock.mockResolvedValueOnce(res(201, { member_id: 'm-sub-district' }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.sub_district).toBe('คลองตันเหนือ');
  });

  it('forwards registered_capital_thb into the create payload (PR-B task 7)', async () => {
    fetchMock.mockResolvedValueOnce(res(201, { member_id: 'm-registered-capital' }));
    renderClient();
    fireEvent.click(screen.getByText('stub-submit'));

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(
      (fetchMock.mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(body.registered_capital_thb).toBe(5_000_000);
  });
});
