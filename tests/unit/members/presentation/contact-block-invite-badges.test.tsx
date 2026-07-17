/**
 * Cluster 3 (2026-07-12) — member-detail ContactBlock invitation badges.
 *
 * Pins the launch-critical portal-invite dead-end fix: when a portal
 * invitation expires unaccepted (`invitations.consumed_at` still NULL,
 * `expires_at < now`), the repo now surfaces it and the page marks the
 * `PendingInvitation` as `expired`. ContactBlock must then:
 *
 *   - show a red "Invitation expired" badge (NOT the amber "Expires in N
 *     days"),
 *   - surface the "Re-send invitation" affordance,
 *   - and NOT show the misleading "Portal linked" badge (the linked user
 *     is still `pending`, never activated).
 *
 * Plus the two unchanged neighbours: a LIVE pending invite still shows
 * amber + no resend; a fully-linked (consumed) contact still shows
 * "Portal linked".
 *
 * Harness mirrors credit-notes-new-page-guard.test.tsx: the page's heavy
 * server boundaries are mocked and the (synchronous) ContactBlock server
 * component is invoked + rendered to static markup. The `t` translator is
 * built from the real en.json so the assertions exercise the shipped copy
 * (and the new `pendingInvitations.expired*` keys).
 */
import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ReactElement } from 'react';
import { createTranslator } from 'next-intl';
import enMessages from '@/i18n/messages/en.json';

// --- Page boundary mocks (only ContactBlock is exercised; the async page
//     default export + its data reads are never called). --------------------
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
}));
vi.mock('@/modules/members/members-deps', () => ({ buildMembersDeps: vi.fn() }));
vi.mock('@/modules/broadcasts', () => ({ makeDrizzleMarketingUnsubscribesRepo: vi.fn() }));
vi.mock('@/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-subscriptions', () => ({
  resolveContactSubscriptions: vi.fn(),
}));
vi.mock('@/app/(staff)/admin/members/[memberId]/_lib/resolve-contact-verification', () => ({
  resolveContactVerification: vi.fn(),
}));

// --- Child presentation stubs (client components ContactBlock renders). -----
vi.mock('@/components/members/subscription-badge', () => ({
  SubscriptionBadge: () => <span data-testid="subscription-badge" />,
}));
vi.mock('@/components/members/invite-portal-button', () => ({
  InvitePortalButton: () => <button data-testid="invite-portal-btn">invite</button>,
}));
vi.mock('@/components/members/resend-bounced-invite-button', () => ({
  ResendBouncedInviteButton: () => (
    <button data-testid="resend-invite-btn">re-send</button>
  ),
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

/** A linked contact (has a pending portal account) with an email. */
function makeContact(
  overrides: Partial<Record<string, unknown>> = {},
): ContactBlockProps['contact'] {
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
    linkedUserId: '33333333-3333-4333-8333-333333333333',
    inviteBouncedAt: null,
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
    subscribed: true,
    canWrite: true,
    verificationPending: false,
    locale: 'en',
    t,
    ...props,
  } as ContactBlockProps;
  return renderToStaticMarkup(<ContactBlock {...full} /> as ReactElement);
}

describe('ContactBlock — invitation badges (Cluster 3)', () => {
  it('EXPIRED invite → "Invitation expired" badge + re-send affordance, NO "Portal linked"', () => {
    const markup = renderBlock({
      pendingInvitation: {
        expiresAt: new Date('2026-03-20T00:00:00Z'),
        daysUntilExpiry: 0,
        expired: true,
      },
    });
    expect(markup).toContain('Invitation expired');
    expect(markup).toContain('resend-invite-btn');
    expect(markup).not.toContain('Portal linked');
    // Not the amber live-pending copy.
    expect(markup).not.toContain('Expires in');
  });

  it('LIVE pending invite → amber "Expires in N days", no re-send, no "Portal linked"', () => {
    const markup = renderBlock({
      pendingInvitation: {
        expiresAt: new Date('2026-04-14T00:00:00Z'),
        daysUntilExpiry: 5,
        expired: false,
      },
    });
    expect(markup).toContain('Expires in 5 days');
    expect(markup).not.toContain('Invitation expired');
    expect(markup).not.toContain('resend-invite-btn');
    expect(markup).not.toContain('Portal linked');
  });

  it('linked + consumed (no pending invite) → "Portal linked", no expired badge, no re-send', () => {
    const markup = renderBlock({ pendingInvitation: undefined });
    expect(markup).toContain('Portal linked');
    expect(markup).not.toContain('Invitation expired');
    expect(markup).not.toContain('resend-invite-btn');
  });

  it('bounced invite (no pending row) → re-send affordance still surfaces', () => {
    const markup = renderBlock({
      contact: makeContact({ inviteBouncedAt: new Date('2026-03-01T00:00:00Z') }),
      pendingInvitation: undefined,
    });
    expect(markup).toContain('resend-invite-btn');
  });

  it('Task 10 (staff-invitation-lifecycle) — post-revoke state (bounced set, no linked user) → NO "Invite bounced" badge, no re-send', () => {
    // A staff Revoke/Prune hard-deletes the pending user, which
    // `ON DELETE SET NULL`s contacts.linked_user_id. If a bounce was
    // recorded BEFORE the revoke, invite_bounced_at is now a stale marker
    // with no user to resend to — resendBouncedInvite requires
    // linkedUserId, so the badge could never self-clear via the normal
    // recovery flow. The badge (and its paired re-send button) must be
    // suppressed once linkedUserId is null, regardless of inviteBouncedAt.
    const markup = renderBlock({
      contact: makeContact({
        inviteBouncedAt: new Date('2026-03-01T00:00:00Z'),
        linkedUserId: null,
      }),
      pendingInvitation: undefined,
    });
    expect(markup).not.toContain('Invite bounced');
    expect(markup).not.toContain('resend-invite-btn');
  });

  it('Cluster 3 review — consumed/active contact whose stale expired invite was suppressed → "Portal linked", NOT expired', () => {
    // The repo active-user anti-join excludes an ACTIVE user's lingering
    // unconsumed+expired row, so the page passes NO pendingInvitation for this
    // contact. A linked contact with no pending invite must render the honest
    // "Portal linked" badge — never the false "Invitation expired".
    const markup = renderBlock({
      contact: makeContact({
        linkedUserId: '33333333-3333-4333-8333-333333333333',
      }),
      pendingInvitation: undefined,
    });
    expect(markup).toContain('Portal linked');
    expect(markup).not.toContain('Invitation expired');
    expect(markup).not.toContain('resend-invite-btn');
  });

  it('Cluster 3 review — bounced AND expired → ONE red badge (expired), bounced badge suppressed', () => {
    // FIX 2 (a11y double-badge): a bounced-then-expired invite shares one root
    // cause + one re-send button; the red "Invitation expired" badge covers it,
    // so the near-identical "Invite bounced" badge is suppressed.
    const markup = renderBlock({
      contact: makeContact({ inviteBouncedAt: new Date('2026-03-01T00:00:00Z') }),
      pendingInvitation: {
        expiresAt: new Date('2026-03-20T00:00:00Z'),
        daysUntilExpiry: 0,
        expired: true,
      },
    });
    expect(markup).toContain('Invitation expired');
    // The second, near-identical red badge is gone.
    expect(markup).not.toContain('Invite bounced');
    // The single shared recovery affordance is still present.
    expect(markup).toContain('resend-invite-btn');
  });
});
