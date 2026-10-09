/**
 * CSV import result card (F6 Phase 7 + F6.1 US5 augmentations).
 *
 * Pure presentational component — renders the `ImportSummary` payload
 * returned by `POST /api/admin/events/import` (200 OK path):
 *   1. Headline counters: rowsProcessed, rowsAlreadyImported,
 *      rowsStateChanged (conditional), eventsCreated, eventsUpdated,
 *      durationMs.
 *   2. Per-match-type breakdown table via `MatchStatusBadge` primitive.
 *   3. Collapsible error-rows section (`<details>` + `<summary>`).
 *   4. F6.1 surfaces: recordId chip, historyPersisted+auditCompletionEmitted
 *      degraded banners, persistent error-CSV download link.
 *
 * Distinct `rowsProcessed` vs `rowsAlreadyImported` labels per
 * `contracts/csv-import-api.md` — admins must clearly see the
 * difference between "0 actually delivered" and "100 idempotency-
 * skipped".
 *
 * Accessibility:
 *   - WCAG 2.5.8 tap target (≥24×24px) on the `<summary>` toggle via
 *     `min-h-6 + py-1`.
 *   - `role="region"` + `aria-label` on the Card so SR users can
 *     navigate INTO the result via region-jump shortcuts. The
 *     phase-transition announcement is owned by the persistent
 *     live region in `csv-mapping-form.tsx`.
 *   - data-testid hooks for the E2E spec.
 */
import { useTranslations } from 'next-intl';
import { Alert, Card, Icon, buttonClass } from '@jirawatpyk/aura-react';
import { MatchStatusBadge } from './match-status-badge';
import type { MatchType } from '@/modules/events';

export interface CsvImportResultPayload {
  readonly rowsProcessed: number;
  readonly rowsAlreadyImported: number;
  /**
   * `rowsStateChanged` counter for re-uploaded rows whose
   * payment_status flipped via FR-018 Notes-inference detection.
   * Surfaced as a 6th headline counter so admins see that the
   * Notes-fix re-upload had EFFECT (not silently bucketed into
   * rowsAlreadyImported per SC-004).
   */
  readonly rowsStateChanged?: number;
  readonly eventsCreated: number;
  readonly eventsUpdated: number;
  readonly matchCounts: Readonly<Record<MatchType, number>>;
  readonly errorRows: ReadonlyArray<{
    readonly rowNumber: number;
    readonly reason: string;
  }>;
  readonly durationMs: number;
  /**
   * Import record ID quotable for support tickets. Optional because
   * Phase 7 (pre-F6.1) imports don't carry recordId. F6.1 imports
   * always populate this from `runImportCsv` outcome.
   */
  readonly recordId?: string;
  /**
   * `false` when both the placeholder INSERT and the recovery INSERT
   * for `csv_import_records` failed — admin's rows committed are
   * still safe, but the recordId quoted here will NOT match a DB row.
   * Surface degraded copy ("history degraded; rows are still
   * committed") instead of the standard recordId chip.
   * Optional/undefined => treat as `true` (back-compat).
   */
  readonly historyPersisted?: boolean;
  /**
   * F6.1 Phase 5 US5 (T045) — when `true`, surface a persistent
   * "Download error CSV" link to the signed-URL endpoint. The link
   * resolves to a 15-min Vercel Blob signed URL via the 307 redirect
   * at `/api/admin/events/import/{recordId}/error-csv`. Hidden when
   * absent or false (Phase 7 imports OR imports with no failed rows).
   */
  readonly errorCsvAvailable?: boolean;
  /**
   * `false` when the per-import `csv_import_completed` audit row
   * failed to emit. DB side effects (rows + history) are committed
   * but the audit trail is incomplete for THIS import — surface a
   * "Audit trail degraded" chip so admins can quote the recordId to
   * support during incident response. Optional/undefined => treat
   * as `true` (back-compat).
   */
  readonly auditCompletionEmitted?: boolean;
  /**
   * R7.B1 / Staff R2 R030 closure — `true` when the FR-019b safety-net
   * query (event-mismatch detector) failed during this upload. The
   * import proceeded fail-open (no priorImports lookup ran), so the
   * routine "looks like you uploaded this to event X before" guard
   * was unavailable. Admin should manually verify event selection.
   * Optional/undefined => treat as `false` (back-compat).
   */
  readonly safetyNetFailedOpen?: boolean;
}

interface CsvImportResultProps {
  readonly result: CsvImportResultPayload;
}

const MATCH_TYPE_ORDER: ReadonlyArray<MatchType> = [
  'member_contact',
  'member_domain',
  'member_fuzzy',
  'non_member',
  'unmatched',
];

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)} s`;
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.round(seconds % 60);
  return `${minutes}m ${remainder}s`;
}

export function CsvImportResult({ result }: CsvImportResultProps) {
  const t = useTranslations('admin.events.import.result');
  const tHistory = useTranslations('admin.events.import.history');
  const tMatch = useTranslations('admin.events.matchType');

  return (
    // No `aria-live` on the Card — it mounts SIMULTANEOUSLY with its
    // content, so SR-side live-region observers register too late and
    // either swallow the announcement or cascade-read the full Card.
    // The persistent live region in `csv-mapping-form.tsx` handles the
    // phase-transition announcement reliably. `role="region"` +
    // `aria-label` keep the Card navigable via SR region-jump shortcuts.
    <Card
      role="region"
      aria-label={t('regionLabel')}
      data-testid="csv-import-result"
      title={t('title')}
      headingLevel={2}
    >
      <div className="flex flex-col gap-[var(--aura-space-6)]">
        {/* Headline counters */}
        <dl className="grid grid-cols-2 gap-x-[var(--aura-space-6)] gap-y-[var(--aura-space-3)] sm:grid-cols-3 md:grid-cols-6">
          <Counter
            label={t('rowsProcessedLabel')}
            value={result.rowsProcessed}
            testId="result-rows-processed"
            tone="success"
          />
          <Counter
            label={t('rowsAlreadyImportedLabel')}
            description={t('rowsAlreadyImportedDescription')}
            value={result.rowsAlreadyImported}
            testId="result-rows-already-imported"
            tone="muted"
          />
          {/* Render the state-change counter only when at least one
              row's payment_status flipped; admins for vanilla re-
              uploads don't need a clutter cell. */}
          {(result.rowsStateChanged ?? 0) > 0 ? (
            <Counter
              label={t('rowsStateChangedLabel')}
              description={t('rowsStateChangedDescription')}
              value={result.rowsStateChanged ?? 0}
              testId="result-rows-state-changed"
              tone="success"
            />
          ) : null}
          <Counter
            label={t('eventsCreatedLabel')}
            value={result.eventsCreated}
            testId="result-events-created"
          />
          <Counter
            label={t('eventsUpdatedLabel')}
            value={result.eventsUpdated}
            testId="result-events-updated"
          />
          <Counter
            label={t('durationLabel')}
            valueText={formatDuration(result.durationMs)}
            testId="result-duration"
          />
        </dl>

        {/* Record ID for support tickets; degraded-history warning when
            DB-side audit row failed to persist (rows are still committed).
            Degraded banner sits ABOVE the recordId so admins read the
            warning first — the recordId is meaningless if support
            cannot find a matching DB row. */}
        {result.recordId !== undefined ? (
          <div
            className="flex flex-col items-start gap-[var(--aura-space-2)]"
            data-testid="result-record-id-block"
          >
            {result.historyPersisted === false ? (
              <Alert
                tone="warning"
                role="status"
                className="w-full"
                data-testid="result-history-degraded"
              >
                {t('historyDegraded')}
              </Alert>
            ) : null}
            {/* Audit-completion degraded chip — when false, the per- */}
            {/* import csv_import_completed audit row failed to emit. */}
            {/* Rows + history may still be safe; the gap is purely on */}
            {/* the audit trail. */}
            {result.auditCompletionEmitted === false ? (
              <Alert
                tone="warning"
                role="status"
                className="w-full"
                data-testid="result-audit-degraded"
              >
                {t('auditDegraded')}
              </Alert>
            ) : null}
            {/* R7.B1 / Staff R2 R030 — FR-019b safety-net fail-open chip */}
            {/* When true, the duplicate-protection query was unavailable */}
            {/* and the import proceeded without it. Admin should */}
            {/* manually verify the event selection. */}
            {result.safetyNetFailedOpen === true ? (
              <Alert
                tone="warning"
                role="status"
                className="w-full"
                data-testid="result-safety-net-unavailable"
              >
                {t('safetyNetUnavailable')}
              </Alert>
            ) : null}
            <p
              className="aura-text-caption text-[var(--aura-fg-secondary)]"
              data-testid="result-record-id"
            >
              {t('recordIdLabel')}:{' '}
              <span className="font-mono select-all">{result.recordId}</span>
            </p>
            {/* F6.1 T045 — persistent download link to the signed-URL
                endpoint. Only rendered when the import committed an
                error-CSV blob (rowsFailed > 0 + blob upload succeeded).
                Browser follows the 307 redirect from the server. */}
            {result.errorCsvAvailable ? (
              <a
                href={`/api/admin/events/import/${result.recordId}/error-csv`}
                className={buttonClass({ variant: 'secondary', touchHeight: true })}
                data-testid="result-download-error-csv"
                aria-label={tHistory('downloadErrorCsvAriaLabel', {
                  recordId: result.recordId.slice(0, 8),
                })}
              >
                <Icon name="download" />
                {tHistory('downloadErrorCsv')}
              </a>
            ) : null}
          </div>
        ) : null}

        {/* Per-match-type breakdown */}
        <section aria-labelledby="csv-result-match-breakdown" data-testid="result-match-counts">
          <h3
            id="csv-result-match-breakdown"
            className="mb-[var(--aura-space-2)] font-medium"
          >
            {t('matchBreakdownTitle')}
          </h3>
          <ul className="flex flex-wrap gap-[var(--aura-space-3)]">
            {MATCH_TYPE_ORDER.map((mt) => (
              <li key={mt} className="flex items-center gap-[var(--aura-space-2)]">
                <MatchStatusBadge matchType={mt} label={tMatch(mt)} />
                <span className="tabular-nums">
                  {result.matchCounts[mt]}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Error rows (collapsible) */}
        {result.errorRows.length > 0 ? (
          <details className="rounded-[var(--aura-radius-md)] border border-[var(--aura-border-danger)] p-[var(--aura-space-3)]">
            <summary className="min-h-6 cursor-pointer py-1 font-medium text-[var(--aura-fg-danger)]">
              {t('errorRowsTitle', { count: result.errorRows.length })}
            </summary>
            <ul className="aura-text-caption mt-[var(--aura-space-3)] flex flex-col gap-[var(--aura-space-2)]">
              {result.errorRows.map((row) => (
                <li
                  key={`${row.rowNumber}-${row.reason}`}
                  data-testid="result-error-row"
                  className="font-mono"
                >
                  <strong>
                    {t('errorRowLabel', { rowNumber: row.rowNumber })}
                  </strong>
                  : {row.reason}
                </li>
              ))}
            </ul>
          </details>
        ) : (
          <p className="aura-text-caption text-[var(--aura-fg-secondary)]">
            {t('noErrorRows')}
          </p>
        )}
      </div>
    </Card>
  );
}

interface CounterProps {
  readonly label: string;
  readonly description?: string;
  readonly value?: number;
  readonly valueText?: string;
  readonly testId: string;
  readonly tone?: 'success' | 'muted';
}

const COUNTER_TONE_CLASSES = {
  success: 'text-[var(--aura-fg-positive)]',
  muted: 'text-[var(--aura-fg-secondary)]',
} as const;

function Counter({ label, description, value, valueText, testId, tone }: CounterProps) {
  // F6.1 R3 a11y-fix 2026-05-16 — description was previously a
  // sibling `<p>` after `<dd>` inside the `<dl>`'s wrapping `<div>`.
  // HTML spec + axe `only-dlitems` rule restrict `<dl> > <div>` to
  // ONLY contain `<dt>`/`<dd>` (definition pair grouping). Move the
  // description into the `<dd>` as a `<small>` block-styled child;
  // keeps semantic pair grouping intact + retains visual layout.
  return (
    <div className="flex flex-col gap-[var(--aura-space-1)]">
      <dt className="aura-text-caption text-[var(--aura-fg-secondary)]">{label}</dt>
      <dd
        data-testid={testId}
        className={`aura-text-h2 tabular-nums ${tone ? COUNTER_TONE_CLASSES[tone] : ''}`}
      >
        {valueText ?? value}
        {description ? (
          <small className="aura-text-caption mt-[var(--aura-space-1)] block font-normal text-[var(--aura-fg-secondary)]">
            {description}
          </small>
        ) : null}
      </dd>
    </div>
  );
}
