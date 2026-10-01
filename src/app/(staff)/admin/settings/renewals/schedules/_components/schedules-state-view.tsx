/**
 * 122 US7b-2 (T738) — the reminder schedules page's two non-editor states as
 * AURA alerts, shared by the page and the no-DB preview: renewals switched off
 * (an info status) and a failed read (a danger alert with Retry, Go back and
 * the reference id from `ErrorCardActions`).
 */
import { getTranslations } from 'next-intl/server';
import { Alert } from '@jirawatpyk/aura-react/server';
import { ErrorCardActions } from '@/components/shell/error-card-actions';

export type SchedulesStateViewProps =
  | { readonly kind: 'disabled' }
  | { readonly kind: 'failed'; readonly correlationId: string };

export async function renderSchedulesStateView(props: SchedulesStateViewProps) {
  const t = await getTranslations('admin.renewals');
  if (props.kind === 'disabled') {
    return (
      <Alert tone="info" role="status">
        {t('error.featureDisabled')}
      </Alert>
    );
  }
  return (
    <Alert tone="danger" role="alert" title={t('error.loadFailed')}>
      {/* K12-1 — the shared Retry (router.refresh in a transition), Go back
          and the reference id. */}
      <ErrorCardActions
        correlationId={props.correlationId}
        goBackHref="/admin/renewals"
        retryLabel={t('error.retry')}
        pendingLabel={t('error.retrying')}
        retryFailedLabel={t('error.retryFailed')}
        goBackLabel={t('error.goBack')}
        referenceLabel={t('error.referenceLabel')}
      />
    </Alert>
  );
}
