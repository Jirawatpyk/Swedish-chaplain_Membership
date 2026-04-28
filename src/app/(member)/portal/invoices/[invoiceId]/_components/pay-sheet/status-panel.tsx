'use client';

/**
 * Simplify S2 — `<StatusPanel>` shared between the `processing` and
 * `three-d-secure` waiting states. Both panels were byte-identical
 * apart from i18n namespace + data-testid; this collapse keeps a
 * single render path so future a11y / motion-reduce / WCAG tweaks
 * land in ONE place.
 *
 * Caller wrappers (`<ProcessingPanel>`, `<ThreeDSecurePanel>`) keep
 * their existing import paths + testids so component tests + the E2E
 * viewport spec don't churn.
 *
 * Contract (specs/009-online-payment FR-028d):
 *   - role="status" + aria-live="polite" so SR announces state.
 *   - Shimmer reuses <Skeleton> primitive — motion-safe shimmer,
 *     motion-reduce static fallback inside the primitive's CSS.
 *   - Tertiary cancel button invokes `onCancel` prop. Parent owns
 *     POST /api/payments/[id]/cancel + drawer teardown.
 */
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export type StatusPanelKind = 'processing' | 'three-d-secure';

export interface StatusPanelProps {
  readonly kind: StatusPanelKind;
  /**
   * review-20260428-102639.md W14 closure — `onCancel` is now optional.
   * Omitted for `kind='processing'` because Stripe is finalising funds
   * capture; clicking Cancel would not actually reverse the charge and
   * misleads the user. Retained for `kind='three-d-secure'` where the
   * user is mid-challenge and abandon is genuinely possible.
   */
  readonly onCancel?: () => void;
}

interface KindConfig {
  readonly i18nNamespace: string;
  readonly panelTestId: string;
  readonly cancelTestId: string;
}

const KIND_CONFIG: Record<StatusPanelKind, KindConfig> = {
  processing: {
    i18nNamespace: 'portal.payment.processing',
    panelTestId: 'pay-sheet-processing-panel',
    cancelTestId: 'pay-sheet-processing-cancel',
  },
  'three-d-secure': {
    i18nNamespace: 'portal.payment.threeDSecure',
    panelTestId: 'pay-sheet-3ds-panel',
    cancelTestId: 'pay-sheet-3ds-cancel',
  },
};

export function StatusPanel({ kind, onCancel }: StatusPanelProps) {
  const cfg = KIND_CONFIG[kind];
  const t = useTranslations(cfg.i18nNamespace);
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid={cfg.panelTestId}
      className="space-y-4"
    >
      <h3 className="text-body font-medium text-foreground">{t('title')}</h3>
      <p className="text-caption text-muted-foreground">{t('body')}</p>
      {/* Visual progress shimmer — not interactive. */}
      <Skeleton className="h-2 w-full" />
      {onCancel ? (
        <Button
          type="button"
          variant="ghost"
          onClick={onCancel}
          // WCAG 2.5.5 / SC 2.5.8 — ≥ 44×44 px on mobile (G-Review #7).
          className="min-h-[44px] w-full"
          data-testid={cfg.cancelTestId}
        >
          {t('cancel')}
        </Button>
      ) : null}
    </div>
  );
}
