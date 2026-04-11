'use client';

/**
 * ErrorState — full-page error card (T049, ux-standards § 4.3).
 *
 * Used by Next.js error.tsx boundaries and by API failure surfaces.
 * Always shows a "Try again" button when an `onRetry` is provided so
 * users have an obvious recovery path.
 */
import { TriangleAlertIcon } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export interface ErrorStateProps {
  readonly title?: string;
  readonly description?: string;
  readonly onRetry?: () => void;
  readonly className?: string;
}

export function ErrorState({ title, description, onRetry, className }: ErrorStateProps) {
  const t = useTranslations();
  return (
    <div
      className={cn(
        'flex flex-col items-center justify-center gap-4 rounded-lg border border-destructive/20 bg-destructive/5 p-12 text-center',
        className,
      )}
      role="alert"
      aria-live="polite"
    >
      <TriangleAlertIcon className="size-10 text-destructive" aria-hidden />
      <div className="space-y-1">
        <p className="text-base font-medium text-destructive">{title ?? t('errors.generic')}</p>
        {description ? (
          <p className="max-w-md text-sm text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {onRetry ? (
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t('buttons.retry')}
        </Button>
      ) : null}
    </div>
  );
}
