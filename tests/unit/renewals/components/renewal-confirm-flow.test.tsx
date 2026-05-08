/**
 * Unit tests for `<RenewalConfirmFlow>` — Round 4 review-fix R4-I1.
 *
 * Round 3's R3-S3 fix introduced a distinct `malformed_response`
 * client-side error code for the case where the confirm POST returns
 * 200 but the body fails JSON.parse (proxy injecting an HTML error
 * page on a mid-deploy edge race, server bug emitting non-JSON 200).
 * That branch had ZERO test coverage at K20 ship — a refactor that
 * flipped `await r.json()` outside the inner try/catch would silently
 * regress to mislabelling the failure as `network_error`.
 *
 * This file covers:
 *   1. Happy path — 200 with `{ pay_url }` redirects via window.location
 *   2. Malformed response — 200 with non-JSON body → setError('malformed_response')
 *      + sendBeacon dispatched with the distinct code (the R3-S3 lock)
 *   3. Missing pay_url — 200 with `{}` → setError('missing_pay_url')
 *      (regression cover for the partner branch in the same control flow)
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';

import { RenewalConfirmFlow } from '@/app/(member)/portal/renewal/[memberId]/_components/renewal-confirm-flow';

const messages = {
  portal: {
    renewal: {
      confirm: {
        cta: 'Confirm renewal',
        busy: 'Confirming…',
        errorGeneric: 'Something went wrong',
        errorCycleNotFound: 'Cycle not found',
        errorCycleNotPayable: 'Cycle not payable',
        errorPlanUnavailable: 'Plan unavailable',
        errorInvoiceFailed: 'Could not issue invoice',
        errorNetwork: 'Network problem',
      },
      planChange: {
        label: 'Membership plan',
        placeholder: '{defaultLabel}',
        currentSuffix: 'current',
        changeNotice: 'Plan change locks the new price.',
      },
    },
  },
};

function renderFlow() {
  return render(
    <NextIntlClientProvider locale="en" messages={messages}>
      <RenewalConfirmFlow
        memberId="member-1"
        cycleId="00000000-0000-0000-0000-000000000001"
        planYear={2026}
        currentPlanId="plan-current"
        currentPlanLabel="Current plan"
        availablePlans={[
          {
            planId: 'plan-current',
            label: 'Current plan',
            annualFeeMinorUnits: 1_500_000,
          },
        ]}
      />
    </NextIntlClientProvider>,
  );
}

const fetchMock = vi.fn();
const sendBeaconMock = vi.fn();
const locationAssignMock = vi.fn();

beforeEach(() => {
  // tests/setup.ts pins fake timers globally (so timer-driven UIs like
  // the idle-warning-dialog can be advanced deterministically). This
  // file exercises real fetch + Promise microtasks + React useTransition
  // — all of which deadlock under fake timers — so we override locally.
  vi.useRealTimers();

  fetchMock.mockReset();
  sendBeaconMock.mockReset();
  locationAssignMock.mockReset();

  // Stub global fetch and navigator.sendBeacon. jsdom defines
  // `navigator` but not `sendBeacon` — define-property is required
  // because the property is non-configurable on some platforms.
  vi.stubGlobal('fetch', fetchMock);
  Object.defineProperty(navigator, 'sendBeacon', {
    configurable: true,
    value: sendBeaconMock,
  });
  // Stub window.location.assign so the happy-path doesn't
  // navigate the test runner away.
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
  // Restore fake timers so the next test file inherits the global default.
  vi.useFakeTimers({ shouldAdvanceTime: false });
});

async function blobToObject(blob: Blob): Promise<Record<string, unknown>> {
  // jsdom's `Blob.prototype.text()` is missing in the version this
  // project uses; FileReader is universally supported. The Blob's
  // text payload is the JSON string we wrote in `reportClientError`.
  const text = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error);
    reader.readAsText(blob);
  });
  return JSON.parse(text) as Record<string, unknown>;
}

describe('<RenewalConfirmFlow> — Round 4 R4-I1', () => {
  it('happy path: 200 + { pay_url } → window.location.assign(pay_url)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ pay_url: 'https://example.test/pay/123' }),
    });

    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    await waitFor(() => {
      expect(locationAssignMock).toHaveBeenCalledWith(
        'https://example.test/pay/123',
      );
    });
    // No beacon should fire on the happy path — the endpoint is for
    // failure correlation only.
    expect(sendBeaconMock).not.toHaveBeenCalled();
  });

  it('R3-S3 lock: 200 with non-JSON body → setError("malformed_response") + beacon with that distinct code', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON at position 0');
      },
    });

    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    // User-visible error: malformed_response is NOT in the
    // ERROR_CODE_TO_I18N_KEY map → falls through to errorGeneric.
    // The state distinction is preserved at the beacon level so
    // support can correlate; the user just sees the generic message.
    // Use findByText (built-in async polling) + verify it's rendered
    // inside the [data-testid='confirm-error'] container; avoids
    // depending on @testing-library/jest-dom matchers.
    const errorEl = await screen.findByText('Something went wrong');
    expect(errorEl.getAttribute('data-testid')).toBe('confirm-error');

    // The R3-S3 lock: beacon ships the precise tag so SRE can
    // distinguish a malformed-body incident from a generic
    // network_error in /api/internal/client-error logs.
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

    // window.location must NOT have been navigated — the failure
    // path returns before the pay_url check.
    expect(locationAssignMock).not.toHaveBeenCalled();
  });

  it('partner branch: 200 + {} → setError("missing_pay_url") (no beacon — partner branch is a server bug, not a parse failure)', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({}),
    });

    renderFlow();
    fireEvent.click(screen.getByRole('button', { name: /confirm renewal/i }));

    // missing_pay_url ALSO falls through to errorGeneric (not in the
    // ERROR_CODE_TO_I18N_KEY map). This regression-locks the partner
    // branch alongside the R4-I1 malformed_response branch — both are
    // server-emitted-200-but-broken cases.
    // Use findByText (built-in async polling) + verify it's rendered
    // inside the [data-testid='confirm-error'] container; avoids
    // depending on @testing-library/jest-dom matchers.
    const errorEl = await screen.findByText('Something went wrong');
    expect(errorEl.getAttribute('data-testid')).toBe('confirm-error');

    // Partner branch (R3-S3 fix only added beacon to malformed-JSON
    // path; missing pay_url is a different server contract violation
    // that doesn't beacon — server-side log already covers it).
    expect(sendBeaconMock).not.toHaveBeenCalled();
    expect(locationAssignMock).not.toHaveBeenCalled();
  });
});
