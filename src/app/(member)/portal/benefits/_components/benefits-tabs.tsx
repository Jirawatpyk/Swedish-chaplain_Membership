'use client';

/**
 * 058 G1 — Benefits page tab chrome (spec §4.4).
 *
 * The ACTIVE PANEL is chosen server-side (the page reads ?tab= and only passes
 * the body it rendered). onValueChange writes ?tab= via router.replace
 * (history-replace, so the back button leaves the Benefits page rather than
 * cycling tabs) and drops ?page= (pagination is broadcast-tab-scoped). Deep-
 * link / share work because the param is the source of truth.
 *
 * Base UI Tabs (`@base-ui/react/tabs`) — controlled via `value` + `onValueChange`
 * on <Tabs>. The onValueChange callback signature is
 * `(value: TabsTab.Value, eventDetails) => void`; the value is `any`, so we
 * narrow it back onto the closed BenefitsTab union before navigating.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BENEFITS_TAB, type BenefitsTab } from '../_helpers/tabs';

export function BenefitsTabs({
  active,
  benefitsPanel,
  broadcastsPanel,
}: {
  readonly active: BenefitsTab;
  readonly benefitsPanel: React.ReactNode;
  readonly broadcastsPanel: React.ReactNode;
}): React.ReactElement {
  const t = useTranslations('portal.benefits.tabs');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onValueChange(value: unknown) {
    const next =
      value === BENEFITS_TAB.broadcasts ? BENEFITS_TAB.broadcasts : BENEFITS_TAB.benefits;
    startTransition(() => {
      router.replace(`/portal/benefits?tab=${next}`);
    });
  }

  return (
    <Tabs value={active} onValueChange={onValueChange} aria-busy={isPending}>
      <TabsList aria-label={t('ariaLabel')} variant="line">
        <TabsTrigger value={BENEFITS_TAB.benefits}>{t('benefits')}</TabsTrigger>
        <TabsTrigger value={BENEFITS_TAB.broadcasts}>{t('broadcasts')}</TabsTrigger>
      </TabsList>
      <TabsContent value={BENEFITS_TAB.benefits} className="pt-4">
        {active === BENEFITS_TAB.benefits ? benefitsPanel : null}
      </TabsContent>
      <TabsContent value={BENEFITS_TAB.broadcasts} className="pt-4">
        {active === BENEFITS_TAB.broadcasts ? broadcastsPanel : null}
      </TabsContent>
    </Tabs>
  );
}
