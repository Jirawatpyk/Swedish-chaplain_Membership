'use client';

/**
 * <MethodTabs> — payment method selector for the PaySheet drawer (G2 T075).
 *
 * Contract:
 *   - specs/009-online-payment — FR-002: if exactly one method is enabled,
 *     render it as a non-tab heading (no tab UI), otherwise render one
 *     tab per enabled method.
 *   - Keyboard: AURA Tabs with manual activation — arrows / Home / End
 *     move focus, click / Enter / Space selects.
 *   - a11y: each tab carries a localized `aria-label` whose
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

import { Tabs } from '@jirawatpyk/aura-react';
import { useTranslations } from 'next-intl';
import { CreditCardIcon, QrCodeIcon } from 'lucide-react';

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
        <h3 className="m-0 text-body font-medium text-[var(--aura-fg-primary)]">{label}</h3>
        <div className="mt-4">
          {only === 'card' ? (cardPanel ?? <p>{placeholder}</p>) : null}
          {only === 'promptpay'
            ? (promptPayPanel ?? <p>{placeholder}</p>)
            : null}
        </div>
      </section>
    );
  }

  // Spec 122 US4 (`Pay-card` / `Pay-promptpay` boards) — AURA Tabs, full-width
  // segmented (5.10, handoff #72); the panel keeps AURA's spacing under the track.
  //  - `keepMounted`: the card panel MUST stay mounted; tearing down Stripe
  //    <Elements> on every swap reloads the iframe (T082, commit 018b9cf).
  //  - `activation="manual"` (WAI-ARIA APG): arrows / Home / End move focus
  //    only; click, Enter or Space selects. Selecting a method re-initiates
  //    the PaymentIntent (`pay-sheet-internal.tsx`), so an arrow sweep must
  //    not spend initiate quota or reload the Stripe iframe.
  //  - `tabProps`: the Label-in-Name aria-label and the test ids.
  const methods = (['card', 'promptpay'] as const).filter((m) => enabledMethods.includes(m));
  const meta = {
    card: {
      label: t('card'),
      aria: t('cardAriaLabel'),
      Icon: CreditCardIcon,
      panel: cardPanel ?? <p>{t('cardPlaceholder')}</p>,
      testId: 'pay-sheet-tab-card',
    },
    promptpay: {
      label: t('promptpay'),
      aria: t('promptpayAriaLabel'),
      Icon: QrCodeIcon,
      panel: promptPayPanel ?? <p>{t('promptpayPlaceholder')}</p>,
      testId: 'pay-sheet-tab-promptpay',
    },
  } as const;

  return (
    <div data-testid="pay-sheet-method-tabs">
      <Tabs
        label={t('groupLabel')}
        value={activeMethod}
        onChange={(id) => {
          const next = methods.find((m) => m === id);
          if (next) onMethodChange(next);
        }}
        keepMounted
        activation="manual"
        variant="segmented"
        fullWidth
        tabs={methods.map((m) => {
          const { label, aria, Icon, panel, testId } = meta[m];
          return {
            id: m,
            label,
            icon: <Icon aria-hidden="true" />,
            content: panel,
            tabProps: { 'aria-label': aria, 'data-testid': testId },
          };
        })}
      />
    </div>
  );
}

export default MethodTabs;
