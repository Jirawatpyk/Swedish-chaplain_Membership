/**
 * F114 T122 (post-ship `/code-review` 2026-09-16, finding #3) — the portal
 * form must send ONE `Idempotency-Key` per submission ATTEMPT SEQUENCE.
 *
 * It used to mint `crypto.randomUUID()` inside `onSubmit`, so every attempt
 * carried a fresh key and the header bought nothing it was added for: a
 * double-click or a retry after a dropped response created a SECOND request
 * (the durable one-pending-per-submitter index turns that into a replace, so
 * the member's own resubmit silently burns one of their ten daily submissions
 * and replaces the request they just made).
 *
 * The rule: mint once per mounted form, reuse across double-clicks, network
 * drops, 429s and 5xx; mint a NEW one only after a TERMINAL outcome — a 2xx
 * (remembered under the key, so a replay would answer the old response) or a
 * validation 422 (also remembered).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestFormValues } from '@/lib/change-request-form-values';
import { PortalChangeRequestForm } from '@/components/members/change-requests/portal-change-request-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

const LIVE: ChangeRequestFormValues = {
  firstName: 'Anna',
  lastName: 'Svensson',
  phone: '+66812345678',
  roleTitle: '',
  companyName: 'Nordic Co',
  website: '',
  description: '',
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

const copy = enMessages.portal.changeRequests.form;
const fetchMock = vi.fn();

function keysSent(): string[] {
  return fetchMock.mock.calls.map((c) => {
    const init = c[1] as { headers: Record<string, string> };
    return init.headers['Idempotency-Key'] ?? '';
  });
}

function renderForm() {
  return render(
    <NextIntlClientProvider locale="en" messages={enMessages}>
      <PortalChangeRequestForm initialValues={LIVE} canProposeCompanyFields pending={null} privacyNoticeHref="/privacy" resubmitOf={null} />
    </NextIntlClientProvider>,
  );
}

function submitButton() {
  return screen.getByRole('button', { name: copy.submit });
}

beforeEach(() => {
  // the shared setup installs fake timers; `waitFor` needs real ones
  vi.useRealTimers();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('PortalChangeRequestForm — one Idempotency-Key per attempt sequence (T122)', () => {
  it('a 429 and the retry after it carry the SAME key (the server releases the reservation and re-evaluates)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'rate_limited', retryAfterSeconds: 3600 }), { status: 429, headers: { 'content-type': 'application/json' } }),
    );
    renderForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const keys = keysSent();
    expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
    expect(keys[1]).toBe(keys[0]);
  });

  it('a 500 and the retry after it carry the SAME key', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'server_error' }), { status: 500, headers: { 'content-type': 'application/json' } }));
    renderForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const keys = keysSent();
    expect(keys[1]).toBe(keys[0]);
  });

  it('after a 2xx the NEXT submission carries a DIFFERENT key (the old one now replays the stored response)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ outcome: 'nothing_to_submit' }), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    renderForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const keys = keysSent();
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('after a 403 the NEXT submission carries a DIFFERENT key (the route REMEMBERS the refusal under the key)', async () => {
    // `mapRefusal` in `src/app/api/portal/change-requests/route.ts` remembers
    // 403 `forbidden` / `company_fields_require_primary` / `member_archived`
    // and 404 `not_found` under the key, exactly as it remembers the
    // validation 422. Keeping the key past one of those answered the member's
    // corrected, CHANGED body with 422 `idempotency-key-reused` until they
    // reloaded the page (seam pass, 2026-09-16, finding #1).
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: 'forbidden', fields: ['company_name'] }), { status: 403, headers: { 'content-type': 'application/json' } }));
    renderForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const keys = keysSent();
    expect(keys[1]).not.toBe(keys[0]);
    expect(keys[1]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a network error and the retry after it carry the SAME key (nothing was reserved, or the reservation is still live)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      fetchMock.mockRejectedValue(new Error('network down'));
      renderForm();
      fireEvent.click(submitButton());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      fireEvent.click(submitButton());
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      const keys = keysSent();
      expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
      expect(keys[1]).toBe(keys[0]);
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('after a validation 422 the NEXT submission carries a DIFFERENT key (the refusal is remembered under the old one)', async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ error: 'validation_error', issues: [{ path: ['contact', 'phone'], code: 'custom', message: 'invalid phone: not_e164' }] }), {
        status: 422,
        headers: { 'content-type': 'application/json' },
      }),
    );
    renderForm();
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    fireEvent.click(submitButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const keys = keysSent();
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe('PortalChangeRequestForm on AURA (spec 122 US3)', () => {
  it('uses AURA cards and fields, and keeps Submit in an ActionBar that says when changes are unsaved', () => {
    const { container } = renderForm();
    for (const id of ['firstName', 'companyName', 'regLine1', 'billCountry']) {
      expect(container.querySelector(`#${id}`)?.closest('.aura-field')).not.toBeNull();
    }
    expect(container.querySelector('#description')).toHaveClass('aura-textarea');
    expect(screen.getByRole('heading', { level: 2, name: copy.billingAddressSection })).toHaveClass('aura-card__title');
    const bar = screen.getByRole('region', { name: 'Actions' });
    expect(bar).toContainElement(submitButton());
    const status = bar.querySelector('[role="status"]')!;
    expect(status.textContent).toBe('');
    fireEvent.change(container.querySelector('#roleTitle')!, { target: { value: 'CFO' } });
    expect(status.textContent).toBe(enMessages.common.unsavedStatus);
  });

  it('lists a client-side failure in a focused error summary', async () => {
    const { container } = renderForm();
    fireEvent.change(container.querySelector('#billLine1')!, { target: { value: 'Box 9' } });
    fireEvent.click(submitButton());
    const summary = await screen.findByRole('alert', { name: /fix 3 fields/i });
    await waitFor(() => expect(summary).toHaveFocus());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
