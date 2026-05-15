/**
 * T097 — CSV import result card (F6 Phase 7).
 *
 * Pure presentational component — renders the `ImportSummary` payload
 * returned by `POST /api/admin/events/import` (200 OK path) in a
 * card layout with:
 *   1. Headline counters: rowsProcessed, rowsAlreadyImported,
 *      eventsCreated, eventsUpdated, durationMs.
 *   2. Per-match-type breakdown table reusing the
 *      `MatchStatusBadge` primitive (Phase 4 T064).
 *   3. Collapsible error-rows section (`<details>` + `<summary>`)
 *      listing `{rowNumber, reason}`. Empty when zero errors.
 *
 * Distinct `rowsProcessed` vs `rowsAlreadyImported` labels per
 * contracts/csv-import-api.md csv-import-api contracts R3 — admins must clearly see
 * the difference between "0 actually delivered" and "100 idempotency-
 * skipped".
 *
 * Accessibility:
 *   - WCAG 2.5.8 tap target (≥24×24px) on the `<summary>` toggle via
 *     `min-h-6 + py-1`, mirroring Phase 5 round-6 H-04 fix.
 *   - `role="region"` + `aria-label` on the Card so SR users can
 *     navigate INTO the result via region-jump shortcuts. The
 *     phase-transition announcement is owned by the persistent
 *     live region in `csv-mapping-form.tsx`.
 *   - data-testid hooks for the E2E spec (T091).
 */
import { useTranslations } from 'next-intl';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { MatchStatusBadge } from './match-status-badge';
import type { MatchType } from '@/modules/events';

export interface CsvImportResultPayload {
  readonly rowsProcessed: number;
  readonly rowsAlreadyImported: number;
  readonly eventsCreated: number;
  readonly eventsUpdated: number;
  readonly matchCounts: Readonly<Record<MatchType, number>>;
  readonly errorRows: ReadonlyArray<{
    readonly rowNumber: number;
    readonly reason: string;
  }>;
  readonly durationMs: number;
  /**
   * Smart-feature S-02 (Round 1 — enterprise-ux-designer): import
   * record ID quotable for support tickets. Optional because Phase 7
   * (pre-F6.1) imports don't carry recordId. F6.1 imports always
   * populate this from `runImportCsv` outcome.
   */
  readonly recordId?: string;
  /**
   * R2-I4 (Round 2 — silent-failure-hunter): `false` when CR-5 recovery
   * also failed and the `csv_import_records` row could not be persisted
   * — admin's rows committed are still safe, but the recordId quoted
   * here will NOT match a DB row. Surface degraded copy ("history
   * degraded; rows are still committed") instead of the standard
   * recordId chip. Optional/undefined => treat as `true` (Phase 7
   * back-compat).
   */
  readonly historyPersisted?: boolean;
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
    >
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Headline counters */}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3 md:grid-cols-5">
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

        {/* Smart-feature S-02 (Round 1) — record ID quotable for support.
            Rendered as a small caption row below counters; uses monospace
            for click-to-copy ergonomics.
            R2-I4 (Round 2) — when `historyPersisted === false`, the
            recordId is shown together with an inline "history degraded"
            warning so admins quoting it to support understand that the
            DB-side row was lost (rows are still committed, only the
            audit/history surface is degraded). */}
        {result.recordId !== undefined ? (
          <div className="flex flex-col gap-1" data-testid="result-record-id-block">
            <p
              className="text-caption text-muted-foreground"
              data-testid="result-record-id"
            >
              {t('recordIdLabel')}:{' '}
              <span className="font-mono select-all">{result.recordId}</span>
            </p>
            {result.historyPersisted === false ? (
              <p
                className="text-caption text-amber-700 dark:text-amber-300"
                role="status"
                data-testid="result-history-degraded"
              >
                {t('historyDegraded')}
              </p>
            ) : null}
          </div>
        ) : null}

        {/* Per-match-type breakdown */}
        <section aria-labelledby="csv-result-match-breakdown" data-testid="result-match-counts">
          <h3 id="csv-result-match-breakdown" className="text-body mb-2 font-medium">
            {t('matchBreakdownTitle')}
          </h3>
          <ul className="flex flex-wrap gap-3">
            {MATCH_TYPE_ORDER.map((mt) => (
              <li key={mt} className="flex items-center gap-2">
                <MatchStatusBadge matchType={mt} label={tMatch(mt)} />
                <span className="text-body tabular-nums">
                  {result.matchCounts[mt]}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {/* Error rows (collapsible) */}
        {result.errorRows.length > 0 ? (
          <details className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <summary className="text-body cursor-pointer min-h-6 py-1 font-medium text-destructive">
              {t('errorRowsTitle', { count: result.errorRows.length })}
            </summary>
            <ul className="text-caption mt-3 flex flex-col gap-2">
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
          <p className="text-caption text-muted-foreground">
            {t('noErrorRows')}
          </p>
        )}
      </CardContent>
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

function Counter({ label, description, value, valueText, testId, tone }: CounterProps) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-caption text-muted-foreground">{label}</dt>
      <dd
        data-testid={testId}
        className={`text-h2 tabular-nums ${
          tone === 'success'
            ? 'text-emerald-700 dark:text-emerald-300'
            : tone === 'muted'
              ? 'text-muted-foreground'
              : ''
        }`}
      >
        {valueText ?? value}
      </dd>
      {description ? (
        <p className="text-caption text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}
