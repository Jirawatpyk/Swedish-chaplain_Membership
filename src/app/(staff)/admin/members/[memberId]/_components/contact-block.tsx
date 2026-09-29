/**
 * One contact on the member detail page (primary or other): name, status
 * badges, the marketing pair, the write affordances and the details grid.
 * Moved out of the page for spec 122 US5b-1 so the page and the preview route
 * render one view, and drawn as the `Admin-member-detail` board's contact
 * row: the name with its status badges, the actions on the right, then a
 * two-column details grid. Badges are AURA tones with an icon and a word,
 * never colour alone.
 */
import type { getTranslations } from 'next-intl/server';
import { MailWarningIcon } from 'lucide-react';
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { Contact, MarketingState } from '@/modules/members';
import { Badge } from '@jirawatpyk/aura-react/server';
import { CopyButton } from '@/components/members/copy-button';
import { DetailField } from '@/components/members/detail-field';
import { InvitePortalButton } from '@/components/members/invite-portal-button';
import { ResendBouncedInviteButton } from '@/components/members/resend-bounced-invite-button';
import { ResendVerificationButton } from '@/components/members/resend-verification-button';
import { ContactActions } from '@/components/members/contact-actions';
import { MarketingStateBadge } from '@/components/members/marketing-state-badge';
import { MarketingSwitch } from '@/components/members/marketing-switch';
import { ContactAvatar } from './contact-avatar';

export type PendingInvitation = {
  /**
   * Migration 0017 narrowed chamber_app's `invitations` visibility to
   * just user_id / consumed_at / expires_at (the `id` column is the
   * raw 7-day token and is owner-role only). The UI therefore knows
   * only the expiry — sufficient for the inline "Expires in N days"
   * badge.
   */
  readonly expiresAt: Date;
  /**
   * Round-11 review fix — precomputed at the page-level (single
   * `Date.now()` call per request) instead of inside ContactBlock,
   * which the react-hooks/purity lint flagged as impure-during-render.
   * Server component still renders once per request so `Date.now()`
   * is conceptually pure here, but the precompute makes the rule
   * happy and centralises the "now" instant for any future
   * snapshot-style consistency requirement.
   */
  readonly daysUntilExpiry: number;
  /**
   * Cluster 3 (2026-07-12) — true when `expiresAt <= now` at page-render
   * time. An expired-but-unconsumed invitation now surfaces (the repo
   * dropped its `expires_at > NOW()` filter) so the UI can show an
   * "Invitation expired" badge + a re-invite affordance instead of a
   * false "Portal linked" dead-end.
   *
   * This flag and the directory's portal badge (`derivePortalState`) now share
   * ONE boundary implementation — `isInvitationExpired` (`@/lib/invitation-expiry`)
   * — so they cannot drift. That helper's `<=` boundary is pinned by
   * tests/unit/lib/invitation-expiry.test.ts.
   */
  readonly expired: boolean;
};

/** The language's name in the page's language ("Thai"), as the board shows it. */
function languageName(code: string, locale: string): string {
  try {
    return new Intl.DisplayNames([locale], { type: 'language' }).of(code) ?? code.toUpperCase();
  } catch {
    return code.toUpperCase();
  }
}

export function ContactBlock({
  contact,
  memberId,
  pendingInvitation,
  marketingState,
  canWrite,
  canMarketing,
  verificationPending,
  locale,
  t,
}: {
  contact: Contact;
  memberId: string;
  pendingInvitation?: PendingInvitation | undefined;
  /**
   * 108 PR-D (FR-031 / FR-031a) — the DISPLAYED marketing state, derived by
   * the page via `deriveMarketingState` (suppression > opt-out > on;
   * `'unavailable'` when the suppression read was degraded). Replaces the
   * pre-108 two-state "Subscribed" badge so this page and the Marketing
   * audience page always agree. Always a text label (never colour alone).
   */
  marketingState: MarketingState;
  /** S1-P1-10: false for the read-only manager — hides Invite/Promote/Remove. */
  canWrite: boolean;
  /**
   * 108 PR-D (FR-030 / FR-034) — `contacts.marketing` holder: renders the
   * switch. Independent of `canWrite`: the marketing role holds this but
   * not `contacts.write`, and a manager holds neither (badge only).
   */
  canMarketing: boolean;
  /** DV-11 — true when the linked user's email is unverified → show the
   *  "Re-send verification email" button. */
  verificationPending: boolean;
  /**
   * FIX 5 (056 polish) — active locale passed from the page-level
   * `getLocale()` call so the pending-invitation badge title renders
   * BE year for th-TH users instead of raw ค.ศ. ISO date.
   */
  locale: string;
  t: Awaited<ReturnType<typeof getTranslations<'admin.members.detail'>>>;
}) {
  // "Invite to portal" is only shown when the contact has an email and
  // is not already linked to an F1 portal account (FR-012 / T056).
  const canInvite = Boolean(contact.email) && !contact.linkedUserId;
  // Round-11 review fix — `daysUntilExpiry` is precomputed at the page
  // level (single `Date.now()` per request) and passed in via the
  // `pendingInvitation` prop.
  const daysUntilExpiry = pendingInvitation?.daysUntilExpiry ?? null;
  // Rendered as a plain flat row (no border, no bg) inside the outer
  // Contacts Card. Multiple contacts are separated by <Separator />
  // elements in the parent CardContent — no nested cards, no visual
  // card-in-card anti-pattern.
  return (
    <div>
      <div className="mb-3 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
        {/* Round-11 review fix — badges moved OUT of the <h3> so the
            heading text reads cleanly to screen readers (was producing
            "John Smith Primary Portal linked Expires in 5 days" as a
            single heading-tree node on VoiceOver). Heading + badge
            cluster live in adjacent flex containers, separated by
            `gap-2`. The badge cluster ships its own aria-label so SRs
            still hear the state info after the heading. */}
        <div className="flex flex-wrap items-center gap-2">
          <ContactAvatar name={`${contact.firstName} ${contact.lastName}`.trim()} />
          <h3 className="text-base font-semibold">
            {`${contact.firstName} ${contact.lastName}`.trim()}
          </h3>
          {/* `role="group"` — a bare <div> is `generic`, on which `aria-label`
              is ARIA-prohibited (axe `aria-prohibited-attr`, a hard violation
              once the cluster is empty). `empty:hidden` drops the labelled
              group for a contact with no badge at all. */}
          <div
            role="group"
            className="flex flex-wrap items-center gap-2 empty:hidden sm:[&:not(:empty)]:border-e sm:[&:not(:empty)]:pe-2"
            aria-label={t('sections.contactStatusBadges')}
          >
            {contact.isPrimary && (
              <>
                <Badge tone="accent">{t('sections.primary')}</Badge>
                {/* 108 FR-031 — the descriptor says WHAT primary means for
                    money email; the phrase "billing contact" is never used. */}
                <span className="text-xs text-[var(--aura-fg-secondary)]">
                  {t('marketing.primaryDescriptor')}
                </span>
              </>
            )}
            {contact.linkedUserId && !pendingInvitation && (
              <Badge tone="success">{t('portal.linked')}</Badge>
            )}
            {/* C6 round-10 ui-design-specialist — inline pending-
                invitation badge replaces "Portal linked" when the
                user row exists but `consumed_at` is NULL. Cluster 3
                (2026-07-12) splits this into a live vs expired variant. */}
            {pendingInvitation && !pendingInvitation.expired && daysUntilExpiry !== null && (
              <Badge
                tone="warning"
                title={t('pendingInvitations.expiresAt', {
                  // FIX 5 — use the shared Buddhist-aware helper so th-TH
                  // users see พ.ศ. (BE) in the hover tooltip, not raw ค.ศ.
                  date: formatLocalisedDate(
                    pendingInvitation.expiresAt.toISOString(),
                    locale,
                    { dateStyle: 'medium' },
                  ),
                })}
              >
                <MailWarningIcon
                  aria-hidden="true"
                  className="size-3"
                />
                <span>
                  {t('pendingInvitations.expiresInDays', {
                    days: daysUntilExpiry,
                  })}
                </span>
              </Badge>
            )}
            {/* Cluster 3 (2026-07-12) — an invitation that expired
                unaccepted (still consumed_at IS NULL, past expires_at).
                Destructive styling signals the dead-end; the sibling
                "Re-send invitation" button (below) is the recovery. */}
            {pendingInvitation && pendingInvitation.expired && (
              <Badge tone="danger">
                <MailWarningIcon
                  aria-hidden="true"
                  className="size-3"
                />
                <span>{t('pendingInvitations.expired')}</span>
                {/* The why as real (visually hidden) text — an aria-label on a
                    role-less span is ARIA-prohibited (review M2). */}
                <span className="sr-only">{`, ${t('pendingInvitations.expiredAria')}`}</span>
              </Badge>
            )}
            {/* F3 spec § Edge Cases — "Invite bounced" warning badge.
                Shown when invite_bounced_at is set (the invitation email
                bounced and was never delivered). Sits alongside a LIVE
                pending-invitation badge.

                Cluster 3 review (2026-07-12) — suppressed when the pending
                invite has ALSO expired: the red "Invitation expired" badge
                above already signals the dead-end and the shared "Re-send
                invitation" button below is the single recovery, so showing
                a second near-identical red "Invite bounced" badge for the
                same root cause is redundant (a11y double-badge finding).

                Task 10 (staff-invitation-lifecycle) — invite_bounced_at is
                only meaningful while a user is still linked. A staff
                Revoke/Prune hard-deletes the pending user, which
                `ON DELETE SET NULL`s contacts.linked_user_id; without this
                check a bounce recorded before the revoke would leave this
                badge stuck forever (resendBouncedInvite requires
                linkedUserId, so it can never clear the flag). Self-heals
                the read the moment the FK nulls out. */}
            {contact.inviteBouncedAt &&
              contact.linkedUserId &&
              !(pendingInvitation && pendingInvitation.expired) && (
              <Badge tone="danger">
                <MailWarningIcon
                  aria-hidden="true"
                  className="size-3"
                />
                <span>{t('inviteBounced.badge')}</span>
                <span className="sr-only">{`, ${t('inviteBounced.badgeAria')}`}</span>
              </Badge>
            )}
          </div>
          {/* 108 PR-D (FR-031 / FR-030 / FR-034) — the marketing PAIR: the
              five-state badge (was the two-state E-Blast subscription badge)
              plus, for `contacts.marketing` holders, its switch. Grouped
              together and OUTSIDE the status-badge cluster so an interactive
              control is never announced as a "status badge" (review M9), and
              OUTSIDE the `canWrite` cluster (marketing holds this right
              without `contacts.write`). Only for contacts that HAVE an email
              (no email = no E-Blast target). */}
          {contact.email && (
            <span className="inline-flex items-center gap-2">
              <MarketingStateBadge state={marketingState} />
              {canMarketing && (
                <MarketingSwitch
                  contactId={contact.contactId}
                  contactName={`${contact.firstName} ${contact.lastName}`.trim()}
                  state={marketingState}
                  size="sm"
                />
              )}
            </span>
          )}
        </div>
        {/* S1-P1-10: write affordances hidden for the read-only manager. */}
        {canWrite && (
          <div className="flex flex-wrap items-center justify-start gap-2 sm:justify-end">
            {canInvite && (
              <InvitePortalButton memberId={memberId} contactId={contact.contactId} />
            )}
            {/* F3 spec § Edge Cases + Cluster 3 — "Re-send invitation" button.
                Shown when the contact has a linked (pending) user AND the
                invitation is in a dead-end: it either BOUNCED
                (`inviteBouncedAt`) OR expired unaccepted
                (`pendingInvitation.expired`). The route re-issues the
                invitation email (owner role) for the still-pending user; the
                in-tx `status==='pending'` re-check keeps it safe. */}
            {contact.linkedUserId &&
              (contact.inviteBouncedAt ||
                (pendingInvitation && pendingInvitation.expired)) && (
                <ResendBouncedInviteButton memberId={memberId} contactId={contact.contactId} />
              )}
            {/* DV-11 — re-send verification email when the linked contact's
                email is still unverified (e.g. mid email-change).
                Fix 6: outer {canWrite && (…)} block already guards this
                section; redundant inner canWrite && removed for consistency
                with the sibling ResendBouncedInviteButton. */}
            {contact.linkedUserId && verificationPending && (
              <ResendVerificationButton memberId={memberId} contactId={contact.contactId} />
            )}
            <ContactActions
              memberId={memberId}
              isPrimary={contact.isPrimary}
              contact={{
                contactId: contact.contactId,
                firstName: contact.firstName,
                lastName: contact.lastName,
                // `contact.email` is a non-null branded Email on the domain
                // aggregate; pass it straight through (the dialog widens it to
                // a plain string for the RHF form value).
                email: contact.email,
                phone: contact.phone ?? null,
                roleTitle: contact.roleTitle ?? null,
                preferredLanguage: contact.preferredLanguage,
                // Drives email editability in the edit dialog: unlinked
                // (imported) contacts get an in-place email edit; a linked
                // PRIMARY stays read-only (sign-in identity, changed via the
                // member Edit page / FR-012a); a linked SECONDARY is editable
                // here (no other edit path) and routes through the same
                // FR-012a atomic flow.
                linkedUserId: contact.linkedUserId ?? null,
                isPrimary: contact.isPrimary,
              }}
            />
          </div>
        )}
      </div>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-1 sm:grid-cols-2">
        <DetailField
          label={t('fields.email')}
          value={contact.email}
          extra={
            <CopyButton value={contact.email} label={t('copy.copyEmail')} />
          }
        />
        <DetailField label={t('fields.phone')} value={contact.phone} />
        <DetailField label={t('fields.roleTitle')} value={contact.roleTitle} />
        <DetailField
          label={t('fields.preferredLanguage')}
          value={languageName(contact.preferredLanguage, locale)}
        />
      </dl>
    </div>
  );
}
