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
 *   - a11y: each <TabsTrigger> carries a localized `aria-label` so
 *     screen readers announce the target method on focus (WCAG 2.1 AA
 *     Name-Role-Value, SC 4.1.2).
 *   - i18n keys: portal.payment.methods.{card,promptpay,
 *     cardAriaLabel,promptpayAriaLabel,cardPlaceholder,promptpayPlaceholder}
 *
 * G2 scope: tab chrome + panel plumbing only. G3 will replace the
 * placeholder panel content with the real Stripe Elements card form
 * (card tab) and the PromptPay QR (Phase 4).
 */

import { useTranslations } from 'next-intl';

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
      <TabsList>
        {enabledMethods.includes('card') && (
          <TabsTrigger value="card" aria-label={t('cardAriaLabel')}>
            {t('card')}
          </TabsTrigger>
        )}
        {enabledMethods.includes('promptpay') && (
          <TabsTrigger
            value="promptpay"
            aria-label={t('promptpayAriaLabel')}
          >
            {t('promptpay')}
          </TabsTrigger>
        )}
      </TabsList>
      {enabledMethods.includes('card') && (
        <TabsContent value="card">
          {cardPanel ?? <p>{t('cardPlaceholder')}</p>}
        </TabsContent>
      )}
      {enabledMethods.includes('promptpay') && (
        <TabsContent value="promptpay">
          {promptPayPanel ?? <p>{t('promptpayPlaceholder')}</p>}
        </TabsContent>
      )}
    </Tabs>
  );
}

export default MethodTabs;
