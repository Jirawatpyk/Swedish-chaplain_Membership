'use client';

/**
 * Spec 122 US5a — the body of a route `error.tsx` boundary on AURA: an
 * `EmptyState` with the generic message, the error id when Next gives one,
 * and a Retry that calls the boundary's `reset`. The caller keeps its own
 * layout container and page header.
 */
import { useTranslations } from 'next-intl';
import { Button, EmptyState } from '@jirawatpyk/aura-react';

export function RouteErrorPanel({
  digest,
  onRetry,
}: {
  readonly digest?: string | undefined;
  readonly onRetry: () => void;
}) {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');
  return (
    // role="alert": the failure is announced without a page change.
    <div role="alert">
      <EmptyState
        bordered
        headingLevel={2}
        icon="circle-alert"
        title={t('generic')}
        description={digest ? t('errorId', { id: digest }) : undefined}
        action={
          <Button icon="rotate-ccw" onClick={onRetry}>
            {tButtons('retry')}
          </Button>
        }
      />
    </div>
  );
}
