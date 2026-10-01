/**
 * Unit tests for `<RenewalConfirmFlow>`.
 *
 * Covers the R4-I1 client error-handling contract (malformed 200, missing
 * pay_url), the WP5 plan-change UX (always-on price panel, grouped priced
 * options, the downgrade acknowledgement gate, the 409 downgrade mapping)
 * and, since spec 122 US7c, the AURA confirm card: the board's stepper,
 * the full-width CTA, the next-step line, AURA alerts and the AURA select.
 *
 * The confirm request is a money request, so the POST is asserted
 * byte-for-byte for no change, an upgrade and an acknowledged downgrade.
 *
 * Rendered against the REAL en.json (G2) so the copy the member sees is what
 * ships. AURA's Select keeps a real <select> under its listbox, so a plan is
 * picked by changing that element (US5a precedent).
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
  waitFor,
  within,
} from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

import {
  RenewalConfirmFlow,
  type RenewalPlanOption,
} from '@/app/(member)/portal/renewal/[memberId]/_components/renewal-confirm-flow';

const CURRENT: RenewalPlanOption = {
  planId: 'plan-current',
  label: 'Current plan',
  annualFeeMinorUnits: 1_500_000, // ฿15,000.00
};
const HIGHER: RenewalPlanOption = {
  planId: 'plan-higher',
  label: 'Higher plan',
  annualFeeMinorUnits: 3_000_000, // ฿30,000.00
};
const LOWER: RenewalPlanOption = {
  planId: 'plan-lower',
  label: 'Lower plan',
  annualFeeMinorUnits: 800_000, // ฿8,000.00
};

type FlowBenefitUsage = {
  eblast: { used: number; quota: number | null };
  culturalTickets: { used: number; quota: number | null };
};

function renderFlow(opts?: {
  plans?: RenewalPlanOption[];
  frozenPriceMinorUnits?: number;
  benefitUsage?: FlowBenefitUsage;
}) {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <RenewalConfirmFlow
        memberId="member-1"
        cycleId="00000000-0000-0000-0000-000000000001"
        currentPlanId="plan-current"
        currentPlanLabel="Current plan"
        availablePlans={opts?.plans ?? [CURRENT]}
        frozenPriceMinorUnits={opts?.frozenPriceMinorUnits ?? 1_500_000}
        benefitUsage={
          opts?.benefitUsage ?? {
            eblast: { used: 0, quota: null },
            culturalTickets: { used: 0, quota: null },
          }
        }
      />
    </NextIntlClientProvider>,
  );
}

const fetchMock = vi.fn();
const sendBeaconMock = vi.fn();
const locationAssignMock = vi.fn();

beforeEach(() => {
  // This file exercises real fetch + Promise microtasks + React useTransition +
  // base-ui portals — all deadlock under the global fake timers.
  vi.useRealTimers();

  fetchMock.mockReset();
  sendBeaconMock.mockReset();
  locationAssignMock.mockReset();

  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: sendBeaconMock,
  });
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: {
      ...window.location,
      assign: locationAssignMock,
      pathname: '/portal/renewal/member-1',
    },
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

async function blobToObject(blob: Blob): Promise<Record<string, unknown>> {
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  return JSON.parse(text) as Record<string, unknown>;
}

/** The real <select> AURA keeps under its listbox. */
function nativePlanSelect(): HTMLSelectElement {
  const native = screen
    .getByRole('combobox', { name: 'Choose a plan' })
    .closest('.aura-select')
    ?.querySelector('select');
  if (!native) throw new Error('no native plan select');
  return native;
}

/** Pick the plan whose option text matches. */
async function pickPlan(optionMatcher: RegExp) {
  const native = nativePlanSelect();
  const option = [...native.options].find((o) => optionMatcher.test(o.textContent ?? ''));
  if (!option) throw new Error(`no plan option matching ${optionMatcher}`);
  fireEvent.change(native, { target: { value: option.value } });
}

const CYCLE_ID = '00000000-0000-0000-0000-000000000001';
const okPay = (url: string) => ({ ok: true, status: 200, json: async () => ({ pay_url: url }) });

/** The confirm POST exactly as sent: URL, method, headers and the raw body string. */
function sentRequest(i = 0) {
  const [url, init] = fetchMock.mock.calls[i]! as [string, RequestInit];
  return { url, method: init.method, headers: init.headers, body: init.body };
}

const GENERIC_ERROR =
  "We couldn't process your renewal. Please try again or contact support.";

describe('<RenewalConfirmFlow> — client error handling (R4-I1)', () => {
  it('happy path: 200 + { pay_url } → window.location.assign(pay_url)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ pay_url: 'https://example.test/pay/123' }),
    });

    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => {
      expect(locationAssignMock).toHaveBeenCalledWith('https://example.test/pay/123');
    });
    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  it('malformed 200 body → generic error inside confirm-error + beacon with the distinct code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    // DEFECT-1 fix — the message now lives in <InlineAlertDescription>, so
    // assert it inside the confirm-error container rather than reading a
    // data-testid off the text node.
    await waitFor(() => {
      expect(
        within(screen.getByTestId('confirm-error')).getByText(GENERIC_ERROR),
      ).toBeInTheDocument();
    });

    expect(sendBeaconMock).toHaveBeenCalledTimes(1);
    const [url, blob] = sendBeaconMock.mock.calls[0]!;
    expect(url).toBe('/api/internal/client-error');
    const payload = await blobToObject(blob as Blob);
    expect(payload).toMatchObject({
      tag: 'renewal-confirm',
      code: 'malformed_response',
      status: 200,
      path: '/portal/renewal/member-1',
    });
    expect(locationAssignMock).not.toHaveBeenCalled();
  });

  it('missing pay_url (200 + {}) → generic error inside confirm-error, no beacon', async () => {
    fetchMock.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) });

    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId('confirm-error')).getByText(GENERIC_ERROR),
      ).toBeInTheDocument();
    });
    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(locationAssignMock).not.toHaveBeenCalled();
  });
});

describe('<RenewalConfirmFlow> — price visibility (WP5)', () => {
  it('renders the current price in the diff panel AT REST with a single plan (locks C-6)', () => {
    renderFlow({ plans: [CURRENT], frozenPriceMinorUnits: 1_500_000 });
    // No select at all (single plan) — the panel still shows the price.
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.getByTestId('price-current').textContent).toContain('15,000.00');
    // At rest, new === current, delta zero.
    expect(screen.getByTestId('price-new').textContent).toContain('15,000.00');
  });

  it('groups the options as the code does and writes them as the board does (US7c)', () => {
    renderFlow({ plans: [CURRENT, HIGHER, LOWER] });
    const groups = [...nativePlanSelect().querySelectorAll('optgroup')].map((g) => ({
      label: g.label,
      options: [...g.querySelectorAll('option')].map((o) => o.textContent),
    }));
    expect(groups).toEqual([
      { label: 'Higher-priced plans', options: ['Higher plan — ฿30,000.00'] },
      { label: 'Your current plan', options: ['Current plan — ฿15,000.00 (current)'] },
      { label: 'Lower-priced plans', options: ['Lower plan — ฿8,000.00'] },
    ]);
    expect(nativePlanSelect().value).toBe('plan-current');
  });

  it('selecting a higher-priced plan updates the New + Difference rows', async () => {
    renderFlow({ plans: [CURRENT, HIGHER], frozenPriceMinorUnits: 1_500_000 });
    await pickPlan(/Higher plan/);
    await waitFor(() => {
      expect(screen.getByTestId('price-new').textContent).toContain('30,000.00');
    });
    // Difference = +15,000.00 (higher − current).
    expect(screen.getByTestId('price-delta').textContent).toContain('15,000.00');
  });
});

describe('<RenewalConfirmFlow> — downgrade gate (WP5)', () => {
  it('Confirm on a LOWER-priced plan opens the dialog and fires NO fetch', async () => {
    renderFlow({ plans: [CURRENT, LOWER], frozenPriceMinorUnits: 1_500_000 });
    await pickPlan(/Lower plan/);
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    // The downgrade dialog opens (title) and the money path is NOT hit.
    expect(await screen.findByText('Confirm a lower-priced plan')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('Confirm on a HIGHER-priced plan POSTs with NO acknowledgeDowngrade key', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ pay_url: 'https://example.test/pay/9' }),
    });
    renderFlow({ plans: [CURRENT, HIGHER], frozenPriceMinorUnits: 1_500_000 });
    await pickPlan(/Higher plan/);
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const body = JSON.parse(fetchMock.mock.calls[0]![1].body as string) as Record<string, unknown>;
    expect(body.newPlanId).toBe('plan-higher');
    expect('acknowledgeDowngrade' in body).toBe(false);
  });

  it('a 409 downgrade_not_acknowledged renders the mapped message', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 409,
      json: async () => ({ error: { code: 'downgrade_not_acknowledged' } }),
    });
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId('confirm-error')).getByText(
          'Please confirm the lower-priced plan change before continuing.',
        ),
      ).toBeInTheDocument();
    });
  });
});

describe('<RenewalConfirmFlow> — AURA alerts (WP5, US7c)', () => {
  it('the change notice is an AURA warning alert with role="status"', async () => {
    renderFlow({ plans: [CURRENT, HIGHER], frozenPriceMinorUnits: 1_500_000 });
    await pickPlan(/Higher plan/);
    const notice = await screen.findByText(
      /Switching to a different plan will lock the new price/,
    );
    const alert = notice.closest('.aura-alert');
    expect(alert?.getAttribute('role')).toBe('status');
    expect(alert?.className ?? '').toMatch(/aura-alert--warning/);
  });

  it('the error alert is an AURA danger alert with role="alert", NO aria-live, and receives focus', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => {
      const errorEl = screen.getByTestId('confirm-error');
      expect(errorEl.getAttribute('role')).toBe('alert');
      expect(errorEl.getAttribute('aria-live')).toBeNull();
      expect(errorEl.className).toMatch(/aura-alert--danger/);
      expect(document.activeElement).toBe(errorEl);
    });
  });
});

describe('<RenewalConfirmFlow> — confirm card (board Portal-renewal, US7c)', () => {
  it('shows the two-step stepper with "Confirm renewal" as the current step', () => {
    renderFlow();
    const steps = screen.getByRole('list', { name: 'Renewal steps' });
    const items = within(steps).getAllByRole('listitem');
    expect(items.map((li) => li.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '1 Confirm renewal',
      '2 Pay invoice',
    ]);
    expect(items[0]).toHaveAttribute('aria-current', 'step');
    expect(items[1]).not.toHaveAttribute('aria-current');
  });

  it('the CTA is a full-width primary AURA button, and says where the member goes next', () => {
    renderFlow();
    const cta = screen.getByRole('button', { name: 'Confirm renewal' });
    expect(cta.className).toMatch(/aura-btn--primary/);
    expect(cta.className).toMatch(/w-full/);
    expect(
      screen.getByText('Next, you go straight to the invoice to pay by card or PromptPay.'),
    ).toBeInTheDocument();
  });

  it('while the request runs, the CTA is busy and the plan select is disabled', async () => {
    let resolve!: (v: unknown) => void;
    fetchMock.mockReturnValueOnce(new Promise((r) => { resolve = r; }));
    renderFlow({ plans: [CURRENT, HIGHER] });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm renewal' }));
    const busy = await screen.findByRole('button', { name: /Confirming/ });
    expect(busy).toHaveAttribute('aria-busy', 'true');
    expect(nativePlanSelect()).toBeDisabled();
    resolve(okPay('https://example.test/pay/1'));
    await waitFor(() => expect(locationAssignMock).toHaveBeenCalled());
  });
});

describe('<RenewalConfirmFlow> — the confirm request, byte-for-byte (money, US7c)', () => {
  it('no change: only the cycle id', async () => {
    fetchMock.mockResolvedValueOnce(okPay('https://example.test/pay/1'));
    renderFlow({ plans: [CURRENT, HIGHER] });
    fireEvent.click(screen.getByRole('button', { name: 'Confirm renewal' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentRequest()).toEqual({
      url: '/api/portal/renewal/member-1/confirm',
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: `{"cycleId":"${CYCLE_ID}"}`,
    });
  });

  it('an upgrade: the cycle id and the new plan, no acknowledgement', async () => {
    fetchMock.mockResolvedValueOnce(okPay('https://example.test/pay/2'));
    renderFlow({ plans: [CURRENT, HIGHER] });
    await pickPlan(/Higher plan/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm renewal' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentRequest().body).toBe(`{"cycleId":"${CYCLE_ID}","newPlanId":"plan-higher"}`);
  });

  it('a downgrade: nothing until the dialog is confirmed, then the acknowledgement rides along', async () => {
    fetchMock.mockResolvedValueOnce(okPay('https://example.test/pay/3'));
    renderFlow({ plans: [CURRENT, LOWER] });
    await pickPlan(/Lower plan/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm renewal' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm a lower-priced plan' });
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Yes, switch to this plan' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    expect(sentRequest().body).toBe(
      `{"cycleId":"${CYCLE_ID}","newPlanId":"plan-lower","acknowledgeDowngrade":true}`,
    );
    await waitFor(() => expect(locationAssignMock).toHaveBeenCalledWith('https://example.test/pay/3'));
  });

  it('a downgrade cancelled in the dialog sends nothing', async () => {
    renderFlow({ plans: [CURRENT, LOWER] });
    await pickPlan(/Lower plan/);
    fireEvent.click(screen.getByRole('button', { name: 'Confirm renewal' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Confirm a lower-priced plan' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep my current plan' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('<RenewalConfirmFlow> — downgrade quota delta (C4)', () => {
  // The TARGET (lower-priced) plan now carries per-year quotas (populated on
  // the page from `listPlans`' `benefit_matrix` projection). This locks the
  // whole chain: benefitUsage (`from`/`used`) + target quota (`to`) → the
  // dialog's quota-delta row + over-quota warning.
  const LOWER_WITH_QUOTAS: RenewalPlanOption = {
    planId: 'plan-lower',
    label: 'Lower plan',
    annualFeeMinorUnits: 800_000, // ฿8,000.00 (a downgrade from ฿15,000.00)
    quotas: { eblast: 4, culturalTickets: 2 },
  };

  it('builds the delta from benefitUsage + target quota; over-quota warning shows when used > to', async () => {
    renderFlow({
      plans: [CURRENT, LOWER_WITH_QUOTAS],
      frozenPriceMinorUnits: 1_500_000,
      benefitUsage: {
        eblast: { used: 6, quota: 12 }, // used 6 > new-plan eblast quota 4
        culturalTickets: { used: 0, quota: 6 },
      },
    });

    await pickPlan(/Lower plan/);
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    // The downgrade dialog opens with the concrete "current → target" rows…
    expect(await screen.findByText('Confirm a lower-priced plan')).toBeInTheDocument();
    expect(screen.getByText(/E-Blasts per year: 12 → 4/)).toBeInTheDocument();
    expect(screen.getByText(/Cultural event tickets per year: 6 → 2/)).toBeInTheDocument();
    // …and the over-quota warning because 6 already used > the new plan's 4.
    expect(screen.getByText(/You have already used 6 of/)).toBeInTheDocument();
    // Still gated behind the two-step ack — no money path yet.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows the quota-delta row WITHOUT an over-quota warning when used <= to', async () => {
    renderFlow({
      plans: [CURRENT, LOWER_WITH_QUOTAS],
      frozenPriceMinorUnits: 1_500_000,
      benefitUsage: {
        eblast: { used: 2, quota: 12 }, // used 2 <= new-plan eblast quota 4
        culturalTickets: { used: 0, quota: 6 },
      },
    });

    await pickPlan(/Lower plan/);
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    expect(await screen.findByText(/E-Blasts per year: 12 → 4/)).toBeInTheDocument();
    expect(screen.queryByText(/You have already used/)).toBeNull();
  });
});

describe('<RenewalConfirmFlow> — the read-only 503 (portal error states follow-up)', () => {
  it("names the maintenance freeze, not the generic failure, for the proxy's flat refusal", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: 'read-only-mode' }), {
        status: 503,
        headers: { 'content-type': 'application/json', 'Retry-After': '300' },
      }),
    );

    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => {
      expect(
        within(screen.getByTestId('confirm-error')).getByText(
          enMessages.portal.renewal.confirm.errorReadOnly,
        ),
      ).toBeInTheDocument();
    });
    expect(screen.queryByText(GENERIC_ERROR)).toBeNull();
  });
});
