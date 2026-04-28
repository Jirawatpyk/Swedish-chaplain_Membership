'use client';

/**
 * <MethodTabs> — payment method selector for the PaySheet drawer (G2 T075).
 *
 * Contract:
 *   - specs/009-online-payment — FR-002: if exactly one method is enabled,
 *     render it as a non-tab heading (no tab UI), otherwise render one
 *     tab per enabled method.
 *   - Keyboard: arrow-key navigation is inherited from the shadcn
 *     <Tabs> primitive (Base-UI Tabs → Radix-equivalent).
 *   - a11y: each <TabsTrigger> carries a localized `aria-label` whose
 *     text STARTS with the visible label (e.g. "Card — switch payment
 *     method") so the accessible name CONTAINS the visible name —
 *     WCAG 2.5.3 (Label in Name) requirement for voice-control users
 *     who say "click Card" to trigger the tab. Earlier versions had
 *     the aria-label fully replace the visible label which broke
 *     speech-recognition input. Icons remain `aria-hidden` so they
 *     don't double-announce.
 *   - i18n keys: portal.payment.methods.{card,promptpay,
 *     cardAriaLabel,promptpayAriaLabel,cardPlaceholder,promptpayPlaceholder}
 *
 * G2 scope: tab chrome + panel plumbing only. G3 will replace the
 * placeholder panel content with the real Stripe Elements card form
 * (card tab) and the PromptPay QR (Phase 4).
 */

import { useTranslations } from 'next-intl';
import { CreditCardIcon, QrCodeIcon } from 'lucide-react';

import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';

export type PaymentMethod = 'card' | 'promptpay';

export interface MethodTabsProps {
  readonly enabledMethods: readonly PaymentMethod[];
  readonly activeMethod: PaymentMethod;
  readonly onMethodChange: (method: PaymentMethod) => void;
  /**
   * Optional slot for the card-method panel content. G3 will wire the
   * actual <Elements>-wrapped card form here. In G2 we fall back to a
   * localized placeholder.
   */
  readonly cardPanel?: React.ReactNode;
  /**
   * Optional slot for the PromptPay-method panel content. Phase 4 will
   * wire the actual QR renderer. In G2 we fall back to a localized
   * placeholder.
   */
  readonly promptPayPanel?: React.ReactNode;
}

export function MethodTabs({
  enabledMethods,
  activeMethod,
  onMethodChange,
  cardPanel,
  promptPayPanel,
}: MethodTabsProps) {
  const t = useTranslations('portal.payment.methods');

  // FR-002 — one method: no tabs, just a heading.
  if (enabledMethods.length === 1) {
    const only = enabledMethods[0]!;
    const label = only === 'card' ? t('card') : t('promptpay');
    const placeholder =
      only === 'card' ? t('cardPlaceholder') : t('promptpayPlaceholder');
    return (
      <section data-testid="pay-sheet-single-method">
        <h3 className="text-body font-medium text-foreground">{label}</h3>
        <div className="mt-4">
          {only === 'card' ? (cardPanel ?? <p>{placeholder}</p>) : null}
          {only === 'promptpay'
            ? (promptPayPanel ?? <p>{placeholder}</p>)
            : null}
        </div>
      </section>
    );
  }

  const tabCount =
    (enabledMethods.includes('card') ? 1 : 0) +
    (enabledMethods.includes('promptpay') ? 1 : 0);
  // Full-width TabsList with equal-width columns. Tailwind JIT cannot
  // compose `grid-cols-${n}` at runtime so map to known literals.
  const gridCols = tabCount === 2 ? 'grid-cols-2' : 'grid-cols-1';

  return (
    <Tabs
      value={activeMethod}
      onValueChange={(value) => {
        if (value === 'card' || value === 'promptpay') {
          onMethodChange(value);
        }
      }}
      data-testid="pay-sheet-method-tabs"
    >
      <TabsList className={`grid w-full ${gridCols} h-11 p-1`}>
        {enabledMethods.includes('card') && (
          <TabsTrigger
            value="card"
            aria-label={t('cardAriaLabel')}
            data-testid="pay-sheet-tab-card"
            className="h-full gap-1.5"
          >
            <CreditCardIcon aria-hidden="true" className="size-4" />
            {t('card')}
          </TabsTrigger>
        )}
        {enabledMethods.includes('promptpay') && (
          <TabsTrigger
            value="promptpay"
            aria-label={t('promptpayAriaLabel')}
            data-testid="pay-sheet-tab-promptpay"
            className="h-full gap-1.5"
          >
            <QrCodeIcon aria-hidden="true" className="size-4" />
            {t('promptpay')}
          </TabsTrigger>
        )}
      </TabsList>
      {/*
       * `keepMounted` — critical for the card panel so the Stripe
       * <Elements> tree + PaymentElement iframe are NOT torn down
       * when the user toggles to PromptPay and back. Without this,
       * every tab swap re-fires the Stripe iframe load + 300ms
       * skeleton floor + button fade-in, which reads as a visible
       * "flash" (T082 UX feedback 2026-04-24). Base UI Tabs.Panel
       * supports keepMounted natively — panels stay in the DOM and
       * are hidden via `hidden` attribute when inactive.
       */}
      {enabledMethods.includes('card') && (
        <TabsContent value="card" keepMounted>
          {cardPanel ?? <p>{t('cardPlaceholder')}</p>}
        </TabsContent>
      )}
      {enabledMethods.includes('promptpay') && (
        <TabsContent value="promptpay" keepMounted>
          {promptPayPanel ?? <p>{t('promptpayPlaceholder')}</p>}
        </TabsContent>
      )}
    </Tabs>
  );
}

export default MethodTabs;
