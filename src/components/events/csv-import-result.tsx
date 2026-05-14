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
 * contracts/csv-import-api.md round-2 R3 — admins must clearly see
 * the difference between "0 actually delivered" and "100 idempotency-
 * skipped".
 *
 * Accessibility:
 *   - WCAG 2.5.8 tap target (≥24×24px) on the `<summary>` toggle via
 *     `min-h-6 + py-1`, mirroring Phase 5 round-6 H-04 fix.
 *   - aria-live="polite" on the result card region for screen-reader
 *     announcement when the result first appears.
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
    <Card
      role="region"
      aria-live="polite"
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
