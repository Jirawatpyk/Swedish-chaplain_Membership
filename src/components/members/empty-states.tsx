'use client';

/**
 * FR-034 — four distinct empty states for the members directory.
 *
 * (a) zero-members — onboarding CTA "Add your first member" + illustration.
 *     The CTA targets `/admin/members/new` (`members.write`); a viewer
 *     without that permission gets no CTA, and an admin-only hint in
 *     place of the "add your first member" description.
 * (b) filtered — "No members match these filters" + Clear-filters CTA
 * (c) all-invited — needs-invite chip filtered to zero rows (design doc
 *     2026-07-23 §3.6/§3.7) — "Everyone has been invited" + a CTA that
 *     clears only the `portal` param, preserving other active filters
 * (d) server-error — retry + localized message
 *
 * ARIA live-region on the error state so screen readers announce the
 * failure without a page change (ux-standards § 7.3).
 *
 * 122 US5a (T503) — AURA `EmptyState` (boards `Admin-state-members-empty`,
 * `-filtered`, `-error`); the live-region role sits on a wrapper.
 */

import type { ReactNode } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Button, Card, EmptyState } from '@jirawatpyk/aura-react';
import { BuildingIcon, MailCheckIcon, SearchXIcon } from 'lucide-react';

/**
 * The members list's one card (the list card rule, spec 122 US8a): the
 * filters with the table, the empty state or the error (boards
 * `Admin-state-members-filtered`, `-error`). Below 640px it drops its frame
 * and padding, so the phone rows, which are cards of their own, sit on the
 * page gutter (as on Plans, Renewals and Invoices).
 */
export function MembersStateCard({ children }: { readonly children: ReactNode }) {
  return (
    <Card data-members-state-card="" flushBelow="sm" className="max-sm:border-0 max-sm:p-0">
      <div className="flex flex-col gap-4">{children}</div>
    </Card>
  );
}

export function MembersZeroState({
  canAddMember,
}: {
  /** `canPerform(role, 'members.write')` — the gate on `/admin/members/new`. */
  readonly canAddMember: boolean;
}) {
  const t = useTranslations('admin.members.emptyStates.zero');
  return (
    <div role="status">
      <EmptyState
        bordered
        headingLevel={2}
        icon={<BuildingIcon aria-hidden="true" />}
        title={t('title')}
        description={canAddMember ? t('description') : t('adminOnlyHint')}
        action={
          canAddMember ? (
            <Button href="/admin/members/new" size="sm" icon="plus">
              {t('cta')}
            </Button>
          ) : undefined
        }
      />
    </div>
  );
}

export function MembersFilteredEmptyState() {
  const t = useTranslations('admin.members.emptyStates.filtered');
  const router = useRouter();
  const pathname = usePathname();
  return (
    <div role="status">
      <EmptyState
        bordered
        headingLevel={2}
        icon={<SearchXIcon aria-hidden="true" />}
        title={t('title')}
        description={t('description')}
        action={
          <Button variant="secondary" size="sm" icon="x" onClick={() => router.replace(pathname)}>
            {t('cta')}
          </Button>
        }
      />
    </div>
  );
}

export function MembersAllInvitedEmptyState() {
  const t = useTranslations('admin.members.emptyStates.allInvited');
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  return (
    <div role="status">
      <EmptyState
        bordered
        headingLevel={2}
        icon={<MailCheckIcon aria-hidden="true" />}
        title={t('title')}
        description={t('description')}
        action={
          <Button
            variant="secondary"
            size="sm"
            icon="x"
            onClick={() => {
              // Clear ONLY the chip — router.replace(pathname) (what the
              // filtered empty state does) would also throw away the user's
              // Plan filter.
              const params = new URLSearchParams(searchParams.toString());
              params.delete('portal');
              params.delete('page');
              params.delete('cursor');
              const qs = params.toString();
              router.replace(qs ? `${pathname}?${qs}` : pathname);
            }}
          >
            {t('cta')}
          </Button>
        }
      />
    </div>
  );
}

export function MembersErrorState() {
  const t = useTranslations('admin.members.emptyStates.error');
  const router = useRouter();
  return (
    // role="alert" implies aria-live="assertive". The board draws the error
    // in the danger colours: AURA's EmptyState danger tone (5.13, #82).
    <EmptyState
      role="alert"
      tone="danger"
      bordered
      headingLevel={2}
      icon="triangle-alert"
      title={t('title')}
      description={t('description')}
      action={
        <Button variant="secondary" size="sm" icon="rotate-ccw" onClick={() => router.refresh()}>
          {t('cta')}
        </Button>
      }
    />
  );
}
