import { getTranslations } from 'next-intl/server';
import { ChangePasswordFormSkeleton } from '@/components/auth/change-password-form-skeleton';
import { env } from '@/lib/env';
import { DetailContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import { AuraCardSkeleton } from '@/components/shell/aura-card-skeleton';
import {
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Portal account-hub loading skeleton (058 D2).
 *
 * Mirrors the account hub in `page.tsx` (Account [+ folded-in Sign out] →
 * Preferred language → Renewal preferences → Data & privacy) so the
 * shimmer→content swap doesn't pop extra sections into existence (CLS = 0,
 * ux-standards § 2.1). BUG-023 removed the standalone Appearance card (theme
 * toggle) and folded Sign out into the Account card — this skeleton matches.
 * Each card is self-titled: a title-height SkeletonBlock INSIDE the AURA card
 * head (mirroring the real `HubCard`'s h2 in its card head, so the title
 * doesn't shift when content arrives) + body SkeletonBlocks in the card body.
 * DetailContainer + the 880px card column match the real page (spec 122 US3,
 * `Portal-account`) so width never reflows.
 *
 * Flag-gated cards (R2-1): the page renders Data & privacy only when
 * `env.features.f9Dashboard && memberId` — `FEATURE_F9_DASHBOARD` defaults
 * FALSE, so an ungated skeleton would show a card that then collapses (CLS).
 * A route `loading.tsx` is a server component and can read `env` synchronously,
 * so we gate the Data & privacy skeleton card on the SAME flag.
 *
 * Unlinked-user caveat (accepted): the page also hides Renewal + Data &
 * privacy when `memberId === null` (e.g. a pending invitation), but a
 * `loading.tsx` receives NO props and cannot resolve memberId without a DB
 * call (which would defeat a fast skeleton). Linked members are the common
 * case, so the Renewal skeleton stays always-rendered to match them; the rare
 * unlinked-user CLS on Renewal/Data&privacy is knowingly accepted.
 */
function HubCardSkeleton({
  titleWidth = 'w-40',
  children,
}: {
  titleWidth?: string;
  children: React.ReactNode;
}) {
  return (
    // Title-skeleton INSIDE the card head so it lands where the real h2
    // renders — no shift on the content swap.
    <AuraCardSkeleton title={<SkeletonBlock className={`h-5 ${titleWidth}`} />}>
      <div className="flex flex-col gap-3">{children}</div>
    </AuraCardSkeleton>
  );
}

export default async function Loading() {
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <DetailContainer>
        <PageHeader
          title={<SkeletonBlock className="h-7 w-40" />}
          subtitle={<SkeletonBlock className="h-4 w-56" />}
          badge={<SkeletonBlock className="h-6 w-20" />}
        />

        <div className="flex max-w-[880px] flex-col gap-4">
        {/* Account: the email field, the 480px change-password form, the
            sessions note (sign-out is top-bar-only since 063). */}
        <HubCardSkeleton>
          <SkeletonBlock className="h-4 w-48" />
          <div className="max-w-[480px]">
            <ChangePasswordFormSkeleton />
          </div>
          <SkeletonBlock className="h-3 w-64" />
        </HubCardSkeleton>

        {/* Notification language: the company and personal groups, side by side from 768px. */}
        <HubCardSkeleton>
          <div className="grid gap-4 md:grid-cols-2 md:gap-8">
            {[0, 1].map((g) => (
              <div key={g} className="flex flex-col gap-3">
                <SkeletonBlock className="h-4 w-40" />
                <SkeletonBlock className="h-24 w-full" />
                <SkeletonBlock className="h-11 w-44" />
              </div>
            ))}
          </div>
        </HubCardSkeleton>

        {/* Renewal preferences. */}
        <HubCardSkeleton>
          <SkeletonBlock className="h-4 w-full" />
          <SkeletonBlock className="h-4 w-3/4" />
        </HubCardSkeleton>

        {/* Data & privacy — f9-gated, mirroring the page's
            `env.features.f9Dashboard && memberId` gate (R2-1). */}
        {env.features.f9Dashboard ? (
          <HubCardSkeleton>
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-4 w-full" />
            <SkeletonBlock className="h-4 w-1/2" />
          </HubCardSkeleton>
        ) : null}
        </div>
      </DetailContainer>
    </PageSkeletonShell>
  );
}
