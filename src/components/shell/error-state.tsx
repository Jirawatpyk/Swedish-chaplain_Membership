'use client';

/**
 * ErrorState — full-page error card (T049, ux-standards § 4.3).
 *
 * Used by Next.js error.tsx boundaries and by API failure surfaces.
 * Always shows a "Try again" button when an `onRetry` is provided so
 * users have an obvious recovery path.
 *
 * PR O — AURA's EmptyState in the danger tone (5.13), framed, announced as
 * a polite alert as before.
 */
import { useTranslations } from 'next-intl';
import { Button, EmptyState } from '@jirawatpyk/aura-react';

export interface ErrorStateProps {
  readonly title?: string;
  readonly description?: string;
  readonly onRetry?: () => void;
  readonly className?: string;
}

export function ErrorState({ title, description, onRetry, className }: ErrorStateProps) {
  const t = useTranslations();
  return (
    <EmptyState
      tone="danger"
      bordered
      icon="triangle-alert"
      headingLevel={false}
      role="alert"
      aria-live="polite"
      title={title ?? t('errors.generic')}
      {...(description ? { description } : {})}
      {...(onRetry
        ? {
            action: (
              <Button variant="secondary" size="sm" touchHeight onClick={onRetry}>
                {t('buttons.retry')}
              </Button>
            ),
          }
        : {})}
      {...(className ? { className } : {})}
    />
  );
}
