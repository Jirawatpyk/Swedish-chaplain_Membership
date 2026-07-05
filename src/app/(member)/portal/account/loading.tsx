import { getTranslations } from 'next-intl/server';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { ChangePasswordFormSkeleton } from '@/components/auth/change-password-form-skeleton';
import { env } from '@/lib/env';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
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
 * Each card is self-titled: a title-height SkeletonBlock INSIDE the CardHeader
 * (mirroring the real `HubCard`'s h2-in-CardHeader, so the title doesn't shift
 * when content arrives) + body SkeletonBlocks in CardContent. FormContainer
 * matches the real page (42rem) so width never reflows.
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
    <Card>
      {/* Title-skeleton INSIDE the CardHeader so it lands where the real h2
          renders (h-5 ≈ the text-base h2) — no shift on the content swap. */}
      <CardHeader>
        <SkeletonBlock className={`h-5 ${titleWidth}`} />
      </CardHeader>
      <CardContent className="space-y-3">{children}</CardContent>
    </Card>
  );
}

export default async function Loading() {
  const tLayout = await getTranslations('layout');
  return (
    <PageSkeletonShell ariaLabel={tLayout('loadingForm')}>
      <FormContainer>
        <PageHeader
          title={<SkeletonBlock className="h-7 w-40" />}
          subtitle={<SkeletonBlock className="h-4 w-56" />}
          badge={<SkeletonBlock className="h-6 w-20" />}
        />

        {/* Account: email + change-password form + forgot-password link +
            the folded-in Sign out button (BUG-023). */}
        <HubCardSkeleton>
          <SkeletonBlock className="h-4 w-48" />
          <ChangePasswordFormSkeleton />
          <SkeletonBlock className="h-4 w-40" />
          {/* Sign out row — separated by a rule in the real card; 44px tap
              target (ux-standards § 9.1) so the swap doesn't reflow. */}
          <div className="border-t pt-4">
            <SkeletonBlock className="h-11 w-28" />
          </div>
        </HubCardSkeleton>

        {/* Preferred language: description line + locale form. */}
        <HubCardSkeleton>
          <SkeletonBlock className="h-4 w-64" />
          <SkeletonBlock className="h-[var(--input-height)] w-full" />
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
      </FormContainer>
    </PageSkeletonShell>
  );
}
