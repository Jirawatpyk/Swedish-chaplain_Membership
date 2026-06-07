import { getTranslations } from 'next-intl/server';
import { Card, CardContent } from '@/components/ui/card';
import { ChangePasswordFormSkeleton } from '@/components/auth/change-password-form-skeleton';
import { env } from '@/lib/env';
import { FormContainer } from '@/components/layout';
import { PageHeader } from '@/components/layout/page-header';
import {
  CardSkeleton,
  PageSkeletonShell,
  SkeletonBlock,
} from '@/components/shell/page-skeletons';

/**
 * Portal account-hub loading skeleton (058 D2).
 *
 * Mirrors the account hub in `page.tsx` (Account → Renewal preferences →
 * Data & privacy → Appearance) so the shimmer→content swap doesn't pop extra
 * sections into existence (CLS = 0, ux-standards § 2.1). Each section is an
 * <h2>-height SkeletonBlock + a Card placeholder; the Account section keeps
 * the two-card shape (change-password + preferred-locale). FormContainer
 * matches the real page (42rem) so width never reflows.
 *
 * Flag-gated sections (R2-1): the page renders Data & privacy only when
 * `env.features.f9Dashboard && memberId` — `FEATURE_F9_DASHBOARD` defaults
 * FALSE, so an ungated skeleton would show a 4th section that then collapses
 * (CLS). A route `loading.tsx` is a server component and can read `env`
 * synchronously, so we gate the Data & privacy skeleton on the SAME flag.
 *
 * Unlinked-user caveat (accepted): the page also hides Renewal + Data &
 * privacy when `memberId === null` (e.g. a pending invitation), but a
 * `loading.tsx` receives NO props and cannot resolve memberId without a DB
 * call (which would defeat a fast skeleton). Linked members are the common
 * case, so the Renewal skeleton stays always-rendered to match them; the rare
 * unlinked-user CLS on Renewal/Data&privacy is knowingly accepted.
 */
function SectionSkeleton({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-4">
      <SkeletonBlock className="h-6 w-40" />
      {children}
    </div>
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

        {/* Account: change-password card + preferred-locale card. */}
        <SectionSkeleton>
          <Card>
            <CardContent className="space-y-4 pt-6">
              <SkeletonBlock className="h-4 w-48" />
              <ChangePasswordFormSkeleton />
              <SkeletonBlock className="h-4 w-40" />
            </CardContent>
          </Card>
          <CardSkeleton rows={2} />
        </SectionSkeleton>

        {/* Renewal preferences. */}
        <SectionSkeleton>
          <CardSkeleton withDescription={false} rows={2} />
        </SectionSkeleton>

        {/* Data & privacy — f9-gated, mirroring the page's
            `env.features.f9Dashboard && memberId` gate (R2-1). */}
        {env.features.f9Dashboard ? (
          <SectionSkeleton>
            <CardSkeleton rows={3} />
          </SectionSkeleton>
        ) : null}

        {/* Appearance. */}
        <SectionSkeleton>
          <CardSkeleton withDescription={false} rows={1} />
        </SectionSkeleton>
      </FormContainer>
    </PageSkeletonShell>
  );
}
