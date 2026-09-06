/**
 * 108 PR-D T057 (FR-031, FR-033, FR-034) — `ContactBlock` marketing surface.
 *
 * The member page's per-contact block must show, for every non-removed
 * contact: the existing "Primary" badge WITH the descriptor "receives
 * invoices and payment emails" (the phrase "billing contact" is never
 * rendered — FR-031), the marketing state badge, and — only for holders of
 * `contacts.marketing` — the switch. A manager sees the state read-only
 * (FR-034). The old two-state "Subscribed" badge is replaced by the
 * five-state marketing badge so the page and the audience page agree.
 *
 * Same static-markup harness as contact-block-invite-badges.test.tsx: the
 * client children are stubbed, only the block's branching is exercised.
 */
import { describe, it, expect, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

vi.mock('next/navigation', () => ({ notFound: () => { throw new Error('NEXT_NOT_FOUND'); } }));
vi.mock('next/headers', () => ({ headers: vi.fn().mockResolvedValue(new Map()) }));
vi.mock('next-intl/server', () => ({
  getTranslations: vi.fn().mockResolvedValue((key: string) => key),
  getFormatter: vi.fn(),
  getLocale: vi.fn().mockResolvedValue('en'),
}));
vi.mock('@/lib/auth-session', () => ({ requireSession: vi.fn() }));
vi.mock('@/lib/tenant-context', () => ({ resolveTenantFromHeaders: () => ({ slug: 'tenant-a' }) }));
vi.mock('@/modules/members', () => ({
  getMember: vi.fn(),
  archiveWindowStatus: vi.fn(),
  formatMemberNumber: vi.fn(),
  resolveMemberNumberPrefix: vi.fn(),
  getMemberErasureStatus: vi.fn(),
  deriveMarketingState: vi.fn(),
}));
vi.mock('@/modules/members/members-deps', () => ({ buildMembersDeps: vi.fn() }));
vi.mock('@/modules/broadcasts', () => ({ makeDrizzleMarketingUnsubscribesRepo: vi.fn() }));
vi.mock('@/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-subscriptions', () => ({
  resolveContactSubscriptions: vi.fn(),
}));
vi.mock('@/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification', () => ({
  resolveContactVerification: vi.fn(),
}));
// The 108 PR-D FIVE-state badge (the pre-108 two-state `subscription-badge`
// was deleted); stubbed so its `useTranslations` never needs a provider, and
// so the assertions below can read `data-state` off a stable node.
vi.mock('@/components/members/marketing-state-badge', () => ({
  MarketingStateBadge: ({ state }: { state: string }) => (
    <span data-testid="marketing-state-badge" data-state={state} />
  ),
}));
vi.mock('@/components/members/marketing-switch', () => ({
  MarketingSwitch: ({ state, contactName }: { state: string; contactName: string }) => (
    <button data-testid="marketing-switch" data-state={state}>{contactName}</button>
  ),
}));
vi.mock('@/components/members/invite-portal-button', () => ({
  InvitePortalButton: () => <button data-testid="invite-portal-btn">invite</button>,
}));
vi.mock('@/components/members/resend-bounced-invite-button', () => ({
  ResendBouncedInviteButton: () => <button data-testid="resend-invite-btn">re-send</button>,
}));
vi.mock('@/components/members/resend-verification-button', () => ({
  ResendVerificationButton: () => <button data-testid="resend-verify-btn">verify</button>,
}));
vi.mock('@/components/members/contact-actions', () => ({
  ContactActions: () => <div data-testid="contact-actions" />,
}));
vi.mock('@/components/members/detail-field', () => ({
  DetailField: ({ label, value }: { label: string; value: unknown }) => (
    <div>{label}: {String(value ?? '')}</div>
  ),
}));
vi.mock('@/components/members/copy-button', () => ({
  CopyButton: () => <button data-testid="copy-btn">copy</button>,
}));

import { ContactBlock } from '@/app/(staff)/admin/members/[memberId]/page';

type ContactBlockProps = Parameters<typeof ContactBlock>[0];

const t = createTranslator({
  locale: 'en',
  messages: enMessages,
  namespace: 'admin.members.detail',
} as unknown as Parameters<typeof createTranslator>[0]) as unknown as ContactBlockProps['t'];

function makeContact(overrides: Partial<Record<string, unknown>> = {}): ContactBlockProps['contact'] {
  return {
    tenantId: 'tenant-a',
    contactId: '22222222-2222-4222-8222-222222222222',
    memberId: '11111111-1111-4111-8111-111111111111',
    firstName: 'Jane',
    lastName: 'Smith',
    email: 'jane@example.com',
    phone: null,
    roleTitle: null,
    preferredLanguage: 'en',
    dateOfBirth: null,
    linkedUserId: null,
    inviteBouncedAt: null,
    art14AttestedAt: null,
    marketing: { optedOutAt: null, source: null, byUserId: null },
    isPrimary: false,
    removedAt: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as ContactBlockProps['contact'];
}

function renderBlock(props: Partial<ContactBlockProps>): string {
  const full: ContactBlockProps = {
    contact: makeContact(),
    memberId: '11111111-1111-4111-8111-111111111111',
    marketingState: 'on',
    canWrite: true,
    canMarketing: true,
    verificationPending: false,
    locale: 'en',
    t,
    ...props,
  } as ContactBlockProps;
  return renderToStaticMarkup(<ContactBlock {...full} /> as ReactElement);
}

const en = enMessages.admin.members.detail;

describe('ContactBlock — marketing surface (108 PR-D)', () => {
  it('primary contact: "Primary" badge carries the money-email descriptor; "billing contact" is never rendered', () => {
    const markup = renderBlock({ contact: makeContact({ isPrimary: true }) });
    expect(markup).toContain(en.sections.primary);
    expect(markup).toContain(en.marketing.primaryDescriptor);
    expect(markup.toLowerCase()).not.toContain('billing contact');
  });

  it('secondary contact: no Primary badge, no descriptor', () => {
    const markup = renderBlock({});
    expect(markup).not.toContain(en.marketing.primaryDescriptor);
  });

  it.each(['on', 'off_by_staff', 'off_by_contact', 'unsubscribed', 'unavailable'] as const)(
    'renders the marketing state badge for state %s (replaces the old Subscribed badge)',
    (state) => {
      const markup = renderBlock({ marketingState: state });
      expect(markup).toContain(`data-testid="marketing-state-badge" data-state="${state}"`);
      expect(markup).not.toContain('subscription-badge');
    },
  );

  it('holder of contacts.marketing → the switch renders, named for the contact', () => {
    const markup = renderBlock({ canMarketing: true, marketingState: 'off_by_staff' });
    expect(markup).toContain('data-testid="marketing-switch" data-state="off_by_staff"');
    expect(markup).toContain('Jane Smith');
  });

  it('manager (no contacts.marketing) → state badge only, no switch (FR-034)', () => {
    const markup = renderBlock({ canMarketing: false, canWrite: false });
    expect(markup).toContain('marketing-state-badge');
    expect(markup).not.toContain('marketing-switch');
  });

  it('the switch does not depend on canWrite: marketing role has no contacts.write yet gets the switch', () => {
    const markup = renderBlock({ canMarketing: true, canWrite: false });
    expect(markup).toContain('marketing-switch');
    expect(markup).not.toContain('contact-actions');
  });

  it('primary contact with marketing off still shows the Primary badge (FR-033: money emails unaffected)', () => {
    const markup = renderBlock({
      contact: makeContact({ isPrimary: true }),
      marketingState: 'off_by_contact',
    });
    expect(markup).toContain(en.sections.primary);
    expect(markup).toContain('data-state="off_by_contact"');
  });
});
