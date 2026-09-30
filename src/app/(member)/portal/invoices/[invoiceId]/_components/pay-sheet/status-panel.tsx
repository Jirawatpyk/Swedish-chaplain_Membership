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

import { Button, Icon } from '@jirawatpyk/aura-react';

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
      // Spec 122 US4 (`Pay-processing` / `Pay-3ds` boards): the status sits
      // in the middle of the drawer — a spinner while the charge settles, a
      // lock while the bank's challenge is open — then the title, the
      // reassurance line and, for 3-D Secure, a compact Cancel payment.
      className="flex min-h-[calc(100dvh-9rem)] flex-col items-center justify-center gap-3.5 px-2 py-8 text-center"
    >
      {kind === 'three-d-secure' ? (
        <span className="flex size-16 items-center justify-center rounded-full bg-[var(--aura-alert-info-bg)] text-[var(--aura-alert-info-fg)]">
          <Icon name="lock" size="lg" />
        </span>
      ) : (
        <span className="flex size-16 items-center justify-center rounded-full bg-[var(--aura-bg-surface-hover)] text-[var(--aura-fg-secondary)]">
          <Icon name="loader-circle" size="lg" className="motion-safe:animate-spin" />
        </span>
      )}
      <h3 className="m-0 text-lg font-semibold text-[var(--aura-fg-primary)]">{t('title')}</h3>
      <p className="m-0 max-w-[340px] text-[var(--aura-fg-secondary)]">{t('body')}</p>
      {onCancel ? (
        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={onCancel}
          // WCAG 2.5.5 / SC 2.5.8 — ≥ 44×44 px on mobile (G-Review #7).
          touchHeight
          data-testid={cfg.cancelTestId}
        >
          {t('cancel')}
        </Button>
      ) : null}
    </div>
  );
}
