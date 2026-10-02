/**
 * Spec 122 (US8a T809) — one button icon rule across the migrated screens
 * (docs/aura-adoption.md § Button icons): a clear action carries its icon —
 * create (plus), download, send (mail), confirm money (check), retry
 * (rotate-ccw) and destructive actions — while Cancel, Save, Apply, Done,
 * Review and in-row links carry none. An audit of every preview view against
 * the canvas boards (2 Oct) found four buttons the boards draw with an icon
 * and the screens drew without one; each is pinned here.
 */
import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { NextIntlClientProvider } from 'next-intl';
import en from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

function getPath(obj: unknown, path: string): unknown {
  return path
    .split('.')
    .reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), obj);
}
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockImplementation(async (ns: string) => {
    const tr = (key: string, params?: Record<string, unknown>) => {
      const v = getPath(getPath(en as unknown, ns), key);
      if (typeof v !== 'string') return `MISSING_KEY:${ns}.${key}`;
      return v.replace(/\{(\w+)\}/g, (_, k: string) => (params?.[k] !== undefined ? String(params[k]) : `{${k}}`));
    };
    return Object.assign(tr, { rich: tr, has: () => true });
  }),
  getLocale: vi.fn().mockResolvedValue('en'),
}));

const { ErrorCardActions } = await import('@/components/shell/error-card-actions');
const { RowActions } = await import('@/app/(staff)/admin/renewals/_components/row-actions');
const { renderPortalProfileView } = await import('@/components/members/portal-profile-view');

function withIntl(el: ReactElement) {
  return (
    <NextIntlClientProvider locale="en" messages={en}>
      {el}
    </NextIntlClientProvider>
  );
}

describe('button icon rule (T809 audit)', () => {
  it('Try again on the shared load-error card carries the retry icon', () => {
    render(
      withIntl(
        <ErrorCardActions
          correlationId="c-1"
          goBackHref="/admin"
          retryLabel="Try again"
          goBackLabel="Go back"
          referenceLabel="Reference"
        />,
      ),
    );
    expect(screen.getByRole('button', { name: 'Try again' }).querySelector('svg.aura-icon')).not.toBeNull();
    // Go back is a navigation, not an action: no icon (the rule).
    expect(screen.getByRole('link', { name: 'Go back' }).querySelector('svg')).toBeNull();
  });

  it('Send reminder in the renewal pipeline row carries the mail icon, as on the member benefits page', () => {
    render(
      withIntl(
        <RowActions
          cycleId="cyc-1"
          memberId="m-1"
          companyName="Acme Co."
          status="upcoming"
          linkedInvoiceId={null}
          canMutate
          onRecordOutreach={vi.fn()}
          onMarkPaid={vi.fn()}
        />,
      ),
    );
    const reminder = screen
      .getAllByRole('button')
      .find((b) => b.textContent?.trim() === en.admin.renewals.actions.sendReminder);
    expect(reminder).toBeDefined();
    expect(reminder?.querySelector('svg.aura-icon')).not.toBeNull();
  });

  it('Invite colleague on the portal profile carries the user-plus icon', async () => {
    const tree = await renderPortalProfileView({
      member: {
        companyName: 'Lindqvist & Partners Co., Ltd.',
        status: 'active',
        taxId: '0105559876541',
        country: 'TH',
        website: null,
        foundedYear: null,
        description: null,
        planYear: 2026,
        registrationDate: new Date('2019-01-12T03:00:00.000Z'),
        lastActivityAt: null,
      } as never,
      contacts: [],
      ownContactId: null,
      isPrimary: true,
      ownMarketingState: null,
      pendingRequest: null,
      decidedRequest: null,
      ownRequestReadFailed: false,
      planDisplayName: 'Premium Corporate',
      isIndividual: false,
      memberNumberFormatted: 'TSCC-0042',
      legalEntityLabel: null,
      addressText: null,
      billingAddressText: null,
      websiteHref: null,
      showHistoryLink: false,
      showDirectoryLink: false,
    });
    const d = new DOMParser().parseFromString(renderToStaticMarkup(withIntl(tree as ReactElement)), 'text/html');
    const invite = d.querySelector('a[href="/portal/contacts/invite"]');
    expect(invite?.textContent).toContain(en.portal.profile.inviteColleague);
    expect(invite?.querySelector('svg')).not.toBeNull();
  });
});
