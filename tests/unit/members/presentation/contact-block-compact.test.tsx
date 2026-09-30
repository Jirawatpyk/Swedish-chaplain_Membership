/**
 * 122 US5b-1 (board `Admin-member-detail-mobile`; maintainer, 29 Sep) — a
 * contact on a phone reads as the board's compact row: "Role · Language"
 * under the name (the Role and Language fields are desktop-only), email and
 * phone as links whose labels stay for screen readers, and the ⋯ menu at
 * the top right with Edit / Make primary under the details. From 640px up
 * the labelled grid is unchanged. Rendered with the real DetailField.
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
vi.mock('@/components/members/copy-button', () => ({
  CopyButton: () => <button data-testid="copy-btn">copy</button>,
}));

import { ContactBlock } from '@/app/(staff)/admin/members/[memberId]/_components/contact-block';

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

function html(props: Partial<ContactBlockProps>) {
  const el = document.createElement('div');
  el.innerHTML = renderBlock(props);
  return el;
}

describe('ContactBlock — compact on a phone (122 US5b-1)', () => {
  const contact = makeContact({ roleTitle: 'Managing Director', preferredLanguage: 'th', phone: '+66 81 234 5678' });

  it('puts "Role · Language" under the name on a phone and hides those two fields there', () => {
    const el = html({ contact });
    const subtitle = [...el.querySelectorAll('p')].find((p) => p.textContent === 'Managing Director · Thai');
    expect(subtitle?.className).toContain('sm:hidden');
    const roleField = [...el.querySelectorAll('dt')].find((d) => d.textContent === en.fields.roleTitle)!.parentElement!;
    expect(roleField.className).toContain('max-sm:hidden');
    const langField = [...el.querySelectorAll('dt')].find((d) => d.textContent === en.fields.preferredLanguage)!.parentElement!;
    expect(langField.className).toContain('max-sm:hidden');
  });

  it('shows email and phone as links, their labels kept for screen readers on a phone', () => {
    const el = html({ contact });
    expect(el.querySelector('a[href="mailto:jane@example.com"]')?.textContent).toBe('jane@example.com');
    expect(el.querySelector('a[href="tel:+66812345678"]')?.textContent).toBe('+66 81 234 5678');
    const emailLabel = [...el.querySelectorAll('dt')].find((d) => d.textContent === en.fields.email)!;
    expect(emailLabel.className).toContain('max-sm:sr-only');
  });

  it('on a phone the actions follow the details (the ⋯ sits top right)', () => {
    const el = html({ contact });
    const actions = el.querySelector('[data-testid="contact-actions"]')!.parentElement!;
    expect(actions.className).toContain('max-sm:order-last');
    expect(el.firstElementChild!.className).toContain('relative');
  });
});
