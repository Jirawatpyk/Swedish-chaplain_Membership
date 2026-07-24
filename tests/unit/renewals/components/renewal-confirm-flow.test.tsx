/**
 * Unit tests for `<RenewalConfirmFlow>`.
 *
 * Covers the original R4-I1 client error-handling contract (malformed 200 +
 * missing pay_url) PLUS the WP5 plan-change UX: the always-on price panel
 * (C-6), grouped priced options, the downgrade acknowledgement gate, the
 * inline-alert polish, and the 409 downgrade error mapping.
 *
 * Rendered against the REAL en.json (G2) so the copy the member sees is what
 * ships. The base-ui Select + AlertDialog portals open reliably here under
 * real timers (`vi.useRealTimers()` in beforeEach).
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

// jsdom cannot drive Base UI's pointer-based Select popup selection (same
// precedent as tests/unit/components/schedules/step-card.test.tsx). Mock the
// Select so a click on a `role="option"` genuinely fires `onValueChange`; the
// real grouped popup + prices are covered by the e2e spec. Options render
// eagerly (no portal) so they are always queryable.
vi.mock('@/components/ui/select', async () => {
  const React = await import('react');
  const OnChange = React.createContext<(v: string) => void>(() => {});
  return {
    Select: ({ onValueChange, children }: { onValueChange: (v: string) => void; children: React.ReactNode }) =>
      React.createElement(OnChange.Provider, { value: onValueChange }, children),
    SelectTrigger: ({ id, children }: { id?: string; children: React.ReactNode }) =>
      React.createElement('button', { type: 'button', role: 'combobox', id }, children),
    SelectContent: ({ children }: { children: React.ReactNode }) => React.createElement(React.Fragment, null, children),
    SelectGroup: ({ children }: { children: React.ReactNode }) => React.createElement('div', { role: 'group' }, children),
    SelectLabel: ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => {
      const onChange = React.useContext(OnChange);
      return React.createElement('div', { role: 'option', tabIndex: 0, onClick: () => onChange(value) }, children);
    },
    TranslatedSelectValue: ({ placeholder }: { placeholder?: string }) => React.createElement('span', null, placeholder),
  };
});

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

/** Pick the plan option whose text matches (mocked Select renders options eagerly). */
async function pickPlan(optionMatcher: RegExp) {
  const option = await screen.findByRole('option', { name: optionMatcher });
  fireEvent.click(option);
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

  it('each option in the open list contains its formatted price', async () => {
    renderFlow({ plans: [CURRENT, HIGHER, LOWER] });
    fireEvent.click(screen.getByRole('combobox', { name: 'Choose a plan' }));
    expect(await screen.findByRole('option', { name: /Higher plan/ })).toHaveTextContent(
      /30,000\.00/,
    );
    expect(screen.getByRole('option', { name: /Lower plan/ })).toHaveTextContent(/8,000\.00/);
    expect(screen.getByRole('option', { name: /Current plan/ })).toHaveTextContent(/15,000\.00/);
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

describe('<RenewalConfirmFlow> — inline-alert polish (WP5)', () => {
  it('the change-notice is an InlineAlert with role="status" and no muted-foreground', async () => {
    renderFlow({ plans: [CURRENT, HIGHER], frozenPriceMinorUnits: 1_500_000 });
    await pickPlan(/Higher plan/);
    const notice = await screen.findByText(
      /Switching to a different plan will lock the new price/,
    );
    const alert = notice.closest('[data-slot="inline-alert"]');
    expect(alert?.getAttribute('role')).toBe('status');
    expect(alert?.className ?? '').not.toContain('text-muted-foreground');
  });

  it('the error alert has role="alert", NO aria-live, and receives focus', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => {
      const errorEl = screen.getByTestId('confirm-error');
      expect(errorEl.getAttribute('role')).toBe('alert');
      expect(errorEl.getAttribute('aria-live')).toBeNull();
      expect(document.activeElement).toBe(errorEl);
    });
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
