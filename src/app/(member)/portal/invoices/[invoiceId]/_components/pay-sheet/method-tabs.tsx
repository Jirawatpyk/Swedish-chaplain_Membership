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

import { useId, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { CreditCardIcon, QrCodeIcon } from 'lucide-react';

import { cn } from '@/lib/utils';

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

  // Spec 122 US4 (`Pay-card` / `Pay-promptpay` boards) — a segmented
  // tablist on AURA's segmented-control styles. WAI-ARIA tabs by hand
  // (AURA-handoff #71): AURA's Tabs renders only the current panel and takes
  // no per-tab attributes, and the card panel MUST stay mounted — tearing
  // down Stripe <Elements> on every swap reloads the iframe (T082, commit
  // 018b9cf). Both panels stay in the DOM; the inactive one is `hidden`.
  return (
    <MethodTablist
      enabledMethods={enabledMethods}
      activeMethod={activeMethod}
      onMethodChange={onMethodChange}
      cardPanel={cardPanel ?? <p>{t('cardPlaceholder')}</p>}
      promptPayPanel={promptPayPanel ?? <p>{t('promptpayPlaceholder')}</p>}
    />
  );
}

function MethodTablist({
  enabledMethods,
  activeMethod,
  onMethodChange,
  cardPanel,
  promptPayPanel,
}: Required<MethodTabsProps>) {
  const t = useTranslations('portal.payment.methods');
  const base = useId();
  const refs = useRef<Partial<Record<PaymentMethod, HTMLButtonElement | null>>>({});
  const methods = (['card', 'promptpay'] as const).filter((m) => enabledMethods.includes(m));

  // Manual activation (WAI-ARIA APG): arrows / Home / End move focus only;
  // click, Enter or Space selects. Selecting a method re-initiates the
  // PaymentIntent (`pay-sheet-internal.tsx`), so an arrow sweep must not
  // spend initiate quota or reload the Stripe iframe — Base UI Tabs, which
  // this replaces, defaulted to the same (`activateOnFocus: false`).
  // null while focus is outside the list: the tab stop is then the selected
  // method, whatever changed it.
  const [focused, setFocused] = useState<PaymentMethod | null>(null);
  const tabStop = focused ?? activeMethod;
  const move = (m: PaymentMethod) => {
    setFocused(m);
    refs.current[m]?.focus();
  };
  const onKeyDown = (e: React.KeyboardEvent) => {
    const i = methods.indexOf(tabStop);
    const next =
      e.key === 'ArrowRight'
        ? methods[(i + 1) % methods.length]
        : e.key === 'ArrowLeft'
          ? methods[(i - 1 + methods.length) % methods.length]
          : e.key === 'Home'
            ? methods[0]
            : e.key === 'End'
              ? methods[methods.length - 1]
              : undefined;
    if (next === undefined) return;
    e.preventDefault();
    move(next);
  };
  const onBlur = (e: React.FocusEvent) => {
    if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(null);
  };

  const meta = {
    card: { label: t('card'), aria: t('cardAriaLabel'), Icon: CreditCardIcon, panel: cardPanel },
    promptpay: { label: t('promptpay'), aria: t('promptpayAriaLabel'), Icon: QrCodeIcon, panel: promptPayPanel },
  } as const;

  return (
    <div data-testid="pay-sheet-method-tabs" className="flex flex-col gap-4">
      <div
        role="tablist"
        aria-label={t('groupLabel')}
        onKeyDown={onKeyDown}
        onBlur={onBlur}
        className="aura-segmented flex w-full"
      >
        {methods.map((m) => {
          const on = m === activeMethod;
          const { label, aria, Icon } = meta[m];
          return (
            <button
              key={m}
              ref={(el) => {
                refs.current[m] = el;
              }}
              type="button"
              role="tab"
              id={`${base}-tab-${m}`}
              aria-controls={`${base}-panel-${m}`}
              aria-selected={on}
              aria-label={aria}
              tabIndex={m === tabStop ? 0 : -1}
              onFocus={() => setFocused(m)}
              onClick={() => onMethodChange(m)}
              data-testid={m === 'card' ? 'pay-sheet-tab-card' : 'pay-sheet-tab-promptpay'}
              className={cn('aura-segmented__option min-h-11 flex-1 justify-center gap-1.5', on && 'is-selected')}
            >
              <Icon aria-hidden="true" className="aura-icon size-4" />
              {label}
            </button>
          );
        })}
      </div>
      {methods.map((m) => (
        <div
          key={m}
          role="tabpanel"
          id={`${base}-panel-${m}`}
          aria-labelledby={`${base}-tab-${m}`}
          hidden={m !== activeMethod}
        >
          {meta[m].panel}
        </div>
      ))}
    </div>
  );
}

export default MethodTabs;
