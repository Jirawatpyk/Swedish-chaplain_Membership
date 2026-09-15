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
import { PortalChangeRequestForm } from '@/components/members/change-requests/portal-change-request-form';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() } }));

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
    await waitFor(() => expect(screen.getByText(copy.errors.phone)).toBeTruthy());
    expect(screen.getByText(copy.errors.website)).toBeTruthy();
    expect(screen.getByText(enMessages.shared.validation.tooLong.replace('{max}', '2000'))).toBeTruthy();
    expect(screen.getByText(enMessages.shared.validation.required)).toBeTruthy();
    expect(screen.getByText(copy.errors.country)).toBeTruthy();
    expect(screen.getByText(enMessages.portal.changeRequests.errors.field)).toBeTruthy();
  });
});
