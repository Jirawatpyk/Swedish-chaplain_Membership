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
 * narrow it back onto the closed BenefitsTab union (via the shared
 * `resolveBenefitsTab` clamp) before navigating.
 */
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BENEFITS_TAB, type BenefitsTab, resolveBenefitsTab } from '../_helpers/tabs';

/**
 * Discriminated union on `showBroadcastsTab` (the F7 kill-switch / break-glass
 * flag). This makes the illegal combination
 * `{ showBroadcastsTab: false, active: 'broadcasts' }` UNREPRESENTABLE at the
 * type level (the false-arm pins `active` to `benefits` and omits
 * `broadcastsPanel` entirely), so the page-level invariant is enforced by the
 * compiler rather than only by JSDoc + caller discipline.
 *
 *  - false → only the Benefits tab + panel exist (F7 off). The page already
 *    forces `active` back to `benefits` when F7 is off, so a hand-crafted
 *    `?tab=broadcasts` cannot reach the broadcasts panel. xhigh #12.
 *  - true  → both tabs; `active` may be either; `broadcastsPanel` is required.
 *
 * The component KEEPS its runtime `showBroadcastsTab ?` guards as
 * defence-in-depth against a non-TS / `any` caller that bypasses the union.
 */
export type BenefitsTabsProps =
  | {
      readonly showBroadcastsTab: false;
      readonly active: typeof BENEFITS_TAB.benefits;
      readonly benefitsPanel: React.ReactNode;
    }
  | {
      readonly showBroadcastsTab: true;
      readonly active: BenefitsTab;
      readonly benefitsPanel: React.ReactNode;
      readonly broadcastsPanel: React.ReactNode;
    };

export function BenefitsTabs(props: BenefitsTabsProps): React.ReactElement {
  // NOTE: do NOT destructure `showBroadcastsTab` off `props` — TS only narrows
  // the discriminated union when the discriminant is read via `props.x`. A
  // separately-bound `const { showBroadcastsTab } = props` severs that link, so
  // `props.broadcastsPanel` would not type-check inside the true-arm. We read
  // the discriminant inline (`props.showBroadcastsTab`) so narrowing flows.
  const { active, benefitsPanel } = props;
  const t = useTranslations('portal.benefits.tabs');
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  function onValueChange(value: unknown) {
    const next = resolveBenefitsTab(value);
    startTransition(() => {
      router.replace(`/portal/benefits?tab=${next}`);
    });
  }

  return (
    <Tabs value={active} onValueChange={onValueChange} aria-busy={isPending}>
      <TabsList aria-label={t('ariaLabel')} variant="line">
        <TabsTrigger value={BENEFITS_TAB.benefits}>{t('benefits')}</TabsTrigger>
        {props.showBroadcastsTab ? (
          <TabsTrigger value={BENEFITS_TAB.broadcasts}>{t('broadcasts')}</TabsTrigger>
        ) : null}
      </TabsList>
      <TabsContent value={BENEFITS_TAB.benefits} className="pt-4">
        {active === BENEFITS_TAB.benefits ? benefitsPanel : null}
      </TabsContent>
      {props.showBroadcastsTab ? (
        <TabsContent value={BENEFITS_TAB.broadcasts} className="pt-4">
          {active === BENEFITS_TAB.broadcasts ? props.broadcastsPanel : null}
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
