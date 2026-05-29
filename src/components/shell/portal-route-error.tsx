'use client';

/**
 * Shared body for member-portal route `error.tsx` boundaries (R2
 * consolidation of ~16 near-identical copies).
 *
 * Each `(member)/portal/**` `error.tsx` is a thin wrapper that renders this
 * with its route's layout container + a log tag, so a runtime throw shows a
 * recoverable, page-scoped error (Retry + `error.digest`) at the SAME
 * max-width as the page (CLS-0) instead of bubbling to the root portal
 * boundary. Pass the matching container (`TableContainer` / `DetailContainer`
 * / `FormContainer`) — keeping the error width aligned with the sibling
 * `page.tsx` is the contract the per-route wrappers exist to enforce.
 *
 * `actions` appends extra recovery affordances after the Retry button (e.g. a
 * "back to …" link for the compose page).
 */
import { useEffect, type ComponentType, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertCircleIcon } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { PageHeader } from '@/components/layout/page-header';

export interface PortalRouteErrorProps {
  readonly error: Error & { digest?: string };
  readonly reset: () => void;
  /** The route's layout container — must match the sibling page.tsx. */
  readonly container: ComponentType<{ children: ReactNode }>;
  /** Diagnostic console tag, e.g. "[portal invoices error boundary]". */
  readonly logTag: string;
  /** Optional extra recovery actions rendered after the Retry button. */
  readonly actions?: ReactNode;
}

export function PortalRouteError({
  error,
  reset,
  container: Container,
  logTag,
  actions,
}: PortalRouteErrorProps): React.JSX.Element {
  const t = useTranslations('errors');
  const tButtons = useTranslations('buttons');

  useEffect(() => {
    console.error(logTag, error);
  }, [error, logTag]);

  return (
    <Container>
      <PageHeader title={t('generic')} />
      <Card>
        <CardHeader className="flex flex-row items-start gap-3">
          <AlertCircleIcon className="size-6 text-destructive" aria-hidden />
          <div>
            <CardTitle>{t('generic')}</CardTitle>
            <CardDescription>
              {error.digest ? t('errorId', { id: error.digest }) : null}
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="flex flex-wrap gap-2">
          <Button onClick={reset}>{tButtons('retry')}</Button>
          {actions}
        </CardContent>
      </Card>
    </Container>
  );
}
