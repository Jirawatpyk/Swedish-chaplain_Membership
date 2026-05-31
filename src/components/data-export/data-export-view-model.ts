/**
 * F9 US6 (staff-review F1) — shared view-model builders for `DataExportPanel`.
 *
 * The member self-service page and the admin on-behalf card render the SAME
 * panel from the SAME export-job rows + the SAME label set. Centralising
 * the row projection (status-label map + date formatting + downloadable flag)
 * and the label assembly here removes the drift hazard of two byte-identical
 * copies (add a label to one caller, forget the other).
 *
 * Presentation-layer only: imports the `ExportStatus` TYPE from the insights
 * barrel (erased at compile) + the locale date formatter — no server runtime.
 */
import { formatLocalisedDate } from '@/lib/format-date-localised';
import type { ExportStatus } from '@/modules/insights';
import type { DataExportLabels, DataExportRow } from './data-export-panel';

/** Translator shape (next-intl `getTranslations('dataExport')` namespace fn). */
type Translate = (key: string) => string;

/** Minimal job shape the panel needs (decoupled from the repo row type). */
export interface DataExportJobView {
  readonly id: string;
  readonly status: ExportStatus;
  readonly createdAt: Date;
}

const STATUS_LABEL_KEY: Record<ExportStatus, string> = {
  requested: 'statusPending',
  processing: 'statusPending',
  ready: 'statusReady',
  delivered: 'statusDelivered',
  expired: 'statusExpired',
  failed: 'statusFailed',
};

/** Project export jobs → panel rows (status label, localised date, download flag). */
export function buildDataExportRows(
  jobs: readonly DataExportJobView[],
  t: Translate,
  locale: string,
): DataExportRow[] {
  return jobs.map((job) => ({
    jobId: job.id,
    status: job.status,
    statusLabel: t(STATUS_LABEL_KEY[job.status]),
    downloadable: job.status === 'ready' || job.status === 'delivered',
    requestedAt: formatLocalisedDate(job.createdAt.toISOString(), locale, {
      dateStyle: 'medium',
      timeStyle: 'short',
    }),
  }));
}

/** Assemble the panel's localised label set from the `dataExport` namespace. */
export function buildDataExportLabels(t: Translate): DataExportLabels {
  return {
    requestButton: t('requestButton'),
    requesting: t('requesting'),
    requestedTitle: t('requestedTitle'),
    requestedBody: t('requestedBody'),
    statusHeading: t('statusHeading'),
    empty: t('empty'),
    download: t('download'),
    errorTitle: t('errorTitle'),
    errorBody: t('errorBody'),
    expiresHint: t('expiresHint'),
    colStatus: t('colStatus'),
    colRequested: t('colRequested'),
    caption: t('statusHeading'),
    alreadyPending: t('alreadyPending'),
  };
}
