/**
 * F114 — PR-1 review UX M12 (closed in PR-2): a server-side 422
 * `validation_error` is rendered PER RULE on the field it names, never the
 * one generic "Please check this value." — the server can refuse what the
 * client schema let through (its phone parser is stricter, a website scheme,
 * a length the client did not bound), and the member must learn WHICH rule.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { NextIntlClientProvider } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';
import type { ChangeRequestFormValues } from '@/lib/change-request-form-values';
import { toast } from '@/lib/toast';
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

beforeEach(() => {
  vi.useRealTimers();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('PortalChangeRequestForm — server 422 issues map to per-rule copy (UX M12)', () => {
  it('phone / website / too_big / too_small / country each get their own message; an unknown rule keeps the generic one', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: 'validation_error',
          issues: [
            { path: ['contact', 'phone'], code: 'custom', message: 'invalid phone: not_e164' },
            { path: ['company', 'website'], code: 'custom', message: 'website scheme not allowed' },
            { path: ['company', 'description'], code: 'too_big', maximum: 2000, message: 'String must contain at most 2000 character(s)' },
            { path: ['contact', 'last_name'], code: 'too_small', minimum: 1, message: 'String must contain at least 1 character(s)' },
            { path: ['company', 'billing_address', 'country'], code: 'custom', message: 'expected ISO 3166-1 alpha-2' },
            { path: ['contact', 'first_name'], code: 'custom', message: 'something the client has no copy for' },
          ],
        }),
        { status: 422, headers: { 'content-type': 'application/json' } },
      ),
    );
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PortalChangeRequestForm initialValues={{ ...LIVE, phone: '+66899999999' }} canProposeCompanyFields pending={null} privacyNoticeHref={null} />
      </NextIntlClientProvider>,
    );
    fireEvent.submit(screen.getByTestId('change-request-form'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    // Each message sits on its own field (and again in the error summary,
    // spec 122 US3), so read it from the field's error line.
    const onField = (id: string) => document.getElementById(`${id}-error`)?.textContent ?? '';
    await waitFor(() => expect(onField('phone')).toContain(copy.errors.phone));
    expect(onField('website')).toContain(copy.errors.website);
    expect(onField('description')).toContain(enMessages.shared.validation.tooLong.replace('{max}', '2000'));
    expect(onField('lastName')).toContain(enMessages.shared.validation.required);
    expect(onField('billCountry')).toContain(copy.errors.country);
    expect(onField('firstName')).toContain(enMessages.portal.changeRequests.errors.field);
    // …and the error summary lists all six and takes focus.
    const summary = await screen.findByRole('alert', { name: /fix 6 fields/i });
    await waitFor(() => expect(summary).toHaveFocus());
  });
});

describe('PortalChangeRequestForm — the read-only 503 (portal error states #1)', () => {
  it('says the system is read-only, keeps the form, and retries under the SAME Idempotency-Key', async () => {
    // The proxy's flat refusal (`src/proxy.ts` build503) — no `error.code`.
    const readOnly = () =>
      new Response(
        JSON.stringify({ error: 'read-only-mode', message: 'The system is currently in read-only mode for maintenance.', retryAfterSeconds: 300 }),
        { status: 503, headers: { 'content-type': 'application/json', 'Retry-After': '300' } },
      );
    fetchMock.mockResolvedValueOnce(readOnly()).mockResolvedValueOnce(readOnly());
    render(
      <NextIntlClientProvider locale="en" messages={enMessages}>
        <PortalChangeRequestForm initialValues={{ ...LIVE, phone: '+66899999999' }} canProposeCompanyFields pending={null} privacyNoticeHref={null} />
      </NextIntlClientProvider>,
    );
    fireEvent.submit(screen.getByTestId('change-request-form'));
    await waitFor(() =>
      expect(screen.getByTestId('submit-status')).toHaveTextContent(enMessages.portal.changeRequests.status.readOnly),
    );
    expect(toast.error, 'the status line IS the message').not.toHaveBeenCalled();
    expect((screen.getByLabelText(/phone/i) as HTMLInputElement).value).toBe('+66899999999');

    fireEvent.submit(screen.getByTestId('change-request-form'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const keyOf = (call: number): string | undefined =>
      (fetchMock.mock.calls[call]?.[1] as RequestInit | undefined)?.headers
        ? ((fetchMock.mock.calls[call]![1] as RequestInit).headers as Record<string, string>)['Idempotency-Key']
        : undefined;
    expect(keyOf(0)).toBeTruthy();
    expect(keyOf(1), 'a 503 is retryable — the route must see the same attempt').toBe(keyOf(0));
  });
});
