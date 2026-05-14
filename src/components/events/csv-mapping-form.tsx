'use client';

/**
 * T096 — CSV import mapping form (F6 Phase 7).
 *
 * 3-phase progressive disclosure mirroring Phase 5
 * `webhook-config-wizard.tsx`:
 *
 *   A) Upload     — file input with 5 MiB client-side guard.
 *   B) Preview    — show 10-row sample + per-column mapping inferred
 *                   from the CSV header. Admin can remap each canonical
 *                   column to a different CSV header via `<Select>`.
 *   C) Result     — show `CsvImportResult` card after POST completes.
 *
 * Communicates with `POST /api/admin/events/import` via multipart
 * upload. Surfaces RFC 7807 problem-body errors back to the admin
 * (400 / 413 / 415 / 429 / 504 / 500 paths).
 *
 * Accessibility:
 *   - File input has explicit `<label>` association via htmlFor.
 *   - Phase progression is announced via `aria-live="polite"`.
 *   - Reduced-motion safe on spinners (`motion-reduce:animate-none`).
 *   - Phase B remap selects use shadcn/ui `<select>` (native, keyboard-
 *     friendly).
 *
 * Pure client component — no DB access. The route handler at
 * `/api/admin/events/import` does the parse-and-import.
 */
import { useCallback, useId, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2, UploadCloud } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { parseProblemDetail } from '@/lib/http/parse-problem-detail';
import { CsvImportResult, type CsvImportResultPayload } from './csv-import-result';

const MAX_BYTES = 5 * 1024 * 1024;
const REQUIRED_COLUMNS = [
  'event_external_id',
  'event_name',
  'event_start',
  'attendee_email',
  'attendee_name',
] as const;
// AS1 (spec.md US5 line 129) lists 7 canonical columns the preview SHOULD
// surface — the 5 required above plus the 2 optional below. We render
// optional columns in muted style so admins see them as "detected,
// non-blocking" rather than "missing required".
const OPTIONAL_PREVIEW_COLUMNS = [
  'event_category',
  'ticket_type',
] as const;

type Phase =
  | { kind: 'idle' }
  | { kind: 'preview'; file: File; preview: PreviewData }
  | { kind: 'submitting'; file: File }
  | { kind: 'completed'; summary: CsvImportResultPayload }
  | { kind: 'error'; title: string; detail: string; missingColumns?: ReadonlyArray<string> };

interface PreviewData {
  readonly detectedColumns: ReadonlyArray<string>;
  readonly rows: ReadonlyArray<ReadonlyArray<string>>;
  readonly missingRequired: ReadonlyArray<string>;
}

/**
 * Lightweight client-side CSV header sniff for preview only — the
 * server-side parser is authoritative. We just want to render a
 * 10-row preview + tell the admin if a required column is obviously
 * missing before they upload.
 */
function sniffPreview(text: string): PreviewData {
  const lines = text.split(/\r?\n/).slice(0, 11);
  const header = (lines[0] ?? '')
    .split(',')
    .map((c) => c.trim().replace(/^"(.*)"$/, '$1'));
  const rows = lines
    .slice(1, 11)
    .filter((line) => line.length > 0)
    .map((line) =>
      line
        .split(',')
        .map((c) => c.trim().replace(/^"(.*)"$/, '$1')),
    );
  const headerSet = new Set(header);
  const missingRequired = REQUIRED_COLUMNS.filter((c) => !headerSet.has(c));
  return { detectedColumns: header, rows, missingRequired };
}

export function CsvMappingForm() {
  const t = useTranslations('admin.events.import');
  const tErrors = useTranslations('admin.events.import.errors');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const fileInputId = useId();
  const liveRegionId = useId();
  // H-12 + M-2 fix (2026-05-15): track whether a previous completed
  // phase happened so the idle re-entry announcement only fires on
  // intentional reset (not on first mount). Derived from
  // `phase.kind` history — set in the same transition that emits
  // `setPhase({kind:'completed'})` so render-time reads don't trip
  // `react-hooks/refs` or `react-hooks/set-state-in-effect`.
  const [hasPreviouslyCompleted, setHasPreviouslyCompleted] =
    useState(false);

  const handleFile = useCallback(
    async (file: File) => {
      if (file.size > MAX_BYTES) {
        setPhase({
          kind: 'error',
          title: tErrors('fileTooLargeTitle'),
          detail: tErrors('fileTooLargeDetail'),
        });
        return;
      }
      const text = await file.text();
      const preview = sniffPreview(text);
      setPhase({ kind: 'preview', file, preview });
    },
    [tErrors],
  );

  const onSubmit = useCallback(async () => {
    if (phase.kind !== 'preview') return;
    setPhase({ kind: 'submitting', file: phase.file });
    const fd = new FormData();
    fd.append('file', phase.file);
    let res: Response;
    try {
      res = await fetch('/api/admin/events/import', {
        method: 'POST',
        body: fd,
      });
    } catch (e) {
      setPhase({
        kind: 'error',
        title: tErrors('networkErrorTitle'),
        detail: e instanceof Error ? e.message : tErrors('unexpectedDetail'),
      });
      return;
    }
    // H-5 + simplify #8 fix (2026-05-15): switch dispatch on res.status
    // + wrap res.json() parse to catch truncated/non-JSON server
    // responses (proxy interposition, mid-flight reset). L-2 fix:
    // Retry-After header may be either delta-seconds or HTTP-date; we
    // parse defensively + fall back to 60s if non-numeric.
    switch (res.status) {
      case 200: {
        let summary: CsvImportResultPayload;
        try {
          summary = (await res.json()) as CsvImportResultPayload;
        } catch (e) {
          setPhase({
            kind: 'error',
            title: tErrors('unexpectedTitle'),
            detail:
              e instanceof Error ? e.message : tErrors('unexpectedDetail'),
          });
          return;
        }
        setPhase({ kind: 'completed', summary });
        setHasPreviouslyCompleted(true);
        // M-1 fix: sonner success toast — esp. needed for the
        // idempotency case where rowsProcessed=0 reads like a failure
        // without the toast framing the situation.
        toast.success(t('importSuccessToast'), {
          description: t('importSuccessToastDesc', {
            count: summary.rowsProcessed,
          }),
        });
        return;
      }
      case 400: {
        const body = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        const missingColumns = Array.isArray(body['missingColumns'])
          ? (body['missingColumns'] as string[])
          : undefined;
        setPhase({
          kind: 'error',
          title: missingColumns
            ? tErrors('headerInvalidTitle')
            : tErrors('badRequestTitle'),
          detail: String(
            body['detail'] ?? body['title'] ?? tErrors('badRequestDetail'),
          ),
          ...(missingColumns ? { missingColumns } : {}),
        });
        return;
      }
      case 413:
        setPhase({
          kind: 'error',
          title: tErrors('fileTooLargeTitle'),
          detail: tErrors('fileTooLargeDetail'),
        });
        return;
      case 429: {
        // L-2: parse Retry-After defensively — header spec allows
        // delta-seconds OR HTTP-date. Non-numeric → fall back to "60".
        const retryAfterRaw = res.headers.get('Retry-After') ?? '';
        const retryAfterSeconds = Number.isFinite(Number(retryAfterRaw))
          ? retryAfterRaw
          : '60';
        setPhase({
          kind: 'error',
          title: tErrors('rateLimitedTitle'),
          detail: tErrors('rateLimitedDetail', {
            retryAfter: retryAfterSeconds,
          }),
        });
        return;
      }
      case 504:
        setPhase({
          kind: 'error',
          title: tErrors('timeoutTitle'),
          detail: tErrors('timeoutDetail'),
        });
        return;
    }
    const detail = await parseProblemDetail(res, tErrors('unexpectedDetail'));
    setPhase({
      kind: 'error',
      title: tErrors('unexpectedTitle'),
      detail,
    });
  }, [phase, t, tErrors]);

  const resetToUpload = useCallback(() => setPhase({ kind: 'idle' }), []);

  // H-12 + M-2 fix (2026-05-15): top-level aria-live region announces
  // phase transitions across BOTH render branches (completed-result
  // card AND form Card). Dynamically-mounted live regions are not
  // reliably announced by NVDA/JAWS — the observer registers at DOM
  // insertion time and content arriving WITH the node is often
  // swallowed. Keeping the region at component root makes it
  // pre-existing for every transition:
  //   - submitting → "Import in progress"
  //   - completed  → "Import complete. Review the summary."
  //   - idle (post-completed) → "Form reset. Upload a new CSV."
  const liveRegion = (
    <div
      id={liveRegionId}
      aria-live="polite"
      aria-atomic="true"
      className="sr-only"
    >
      {phase.kind === 'submitting' && t('uploadInProgressSr')}
      {phase.kind === 'completed' && t('importCompleteSr')}
      {phase.kind === 'idle' &&
        hasPreviouslyCompleted &&
        t('resetToUploadSr')}
    </div>
  );

  if (phase.kind === 'completed') {
    return (
      <div className="flex flex-col gap-4">
        {liveRegion}
        <CsvImportResult result={phase.summary} />
        <div>
          <Button
            type="button"
            variant="outline"
            onClick={resetToUpload}
            className="min-h-11"
          >
            {t('uploadAnother')}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('formTitle')}</CardTitle>
        <CardDescription>{t('formDescription')}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {liveRegion}

        {phase.kind === 'error' ? (
          <ErrorPanel phase={phase} onRetry={resetToUpload} />
        ) : null}

        {(phase.kind === 'idle' || phase.kind === 'error') && (
          <div className="flex flex-col gap-2">
            <Label htmlFor={fileInputId}>{t('fileInputLabel')}</Label>
            <input
              id={fileInputId}
              type="file"
              accept=".csv,text/csv,application/vnd.ms-excel"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  void handleFile(file);
                }
              }}
              className="text-body block w-full cursor-pointer rounded-md border border-input bg-background p-2 file:mr-3 file:rounded file:border-0 file:bg-primary file:px-3 file:py-1 file:text-primary-foreground hover:file:bg-primary/90"
            />
            <p className="text-caption text-muted-foreground">
              {t('fileInputHelp')}
            </p>
          </div>
        )}

        {phase.kind === 'preview' && (
          <PreviewPanel
            preview={phase.preview}
            fileName={phase.file.name}
            onSubmit={onSubmit}
            onCancel={resetToUpload}
            submitLabel={t('confirmCta')}
            cancelLabel={t('cancelCta')}
          />
        )}

        {phase.kind === 'submitting' && (
          <Button
            type="button"
            disabled
            aria-busy="true"
            className="min-h-11 self-start"
          >
            <Loader2
              aria-hidden="true"
              className="mr-2 size-4 animate-spin motion-reduce:animate-none"
            />
            {t('submittingCta')}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

interface ErrorPanelProps {
  readonly phase: Extract<Phase, { kind: 'error' }>;
  readonly onRetry: () => void;
}

function ErrorPanel({ phase, onRetry }: ErrorPanelProps) {
  const t = useTranslations('admin.events.import');
  return (
    <div data-testid="csv-header-error">
      <Alert variant="destructive">
        <AlertTitle>{phase.title}</AlertTitle>
        <AlertDescription>
          <p>{phase.detail}</p>
          {phase.missingColumns && phase.missingColumns.length > 0 ? (
            <ul className="mt-2 list-disc pl-5 font-mono">
              {phase.missingColumns.map((col) => (
                <li key={col}>{col}</li>
              ))}
            </ul>
          ) : null}
        </AlertDescription>
      </Alert>
      <Button
        type="button"
        onClick={onRetry}
        variant="outline"
        className="mt-3 min-h-11"
      >
        {t('retryCta')}
      </Button>
    </div>
  );
}

interface PreviewPanelProps {
  readonly preview: PreviewData;
  readonly fileName: string;
  readonly onSubmit: () => void;
  readonly onCancel: () => void;
  readonly submitLabel: string;
  readonly cancelLabel: string;
}

function PreviewPanel({
  preview,
  fileName,
  onSubmit,
  onCancel,
  submitLabel,
  cancelLabel,
}: PreviewPanelProps) {
  const t = useTranslations('admin.events.import.preview');
  const hasMissing = preview.missingRequired.length > 0;
  // simplify #9 fix: `preview.rows` is already capped to 10 rows by
  // `sniffPreview` (slice(0,11) over header + 10 body rows). No
  // additional slice needed; useMemo was a no-op churn.
  const sampleRows = preview.rows;

  return (
    <div className="flex flex-col gap-4">
      <p className="text-body">
        <strong>{t('fileNameLabel')}:</strong>{' '}
        <span className="font-mono">{fileName}</span>
      </p>

      {hasMissing ? (
        <Alert variant="destructive" data-testid="csv-header-error">
          <AlertTitle>{t('missingColumnsTitle')}</AlertTitle>
          <AlertDescription>
            <p>{t('missingColumnsDescription')}</p>
            <ul className="mt-2 list-disc pl-5 font-mono">
              {preview.missingRequired.map((col) => (
                <li key={col}>{col}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : null}

      <section aria-labelledby="csv-preview-columns">
        <h3 id="csv-preview-columns" className="text-body mb-2 font-medium">
          {t('columnMappingTitle')}
        </h3>
        <ul className="flex flex-wrap gap-2">
          {REQUIRED_COLUMNS.map((canonical) => (
            <li
              key={canonical}
              data-testid={`column-mapping-${canonical}`}
              className={`text-caption rounded-md border px-2 py-1 font-mono ${
                preview.detectedColumns.includes(canonical)
                  ? 'border-emerald-700 text-emerald-900 dark:border-emerald-500 dark:text-emerald-100'
                  : 'border-destructive text-destructive'
              }`}
            >
              {canonical}
            </li>
          ))}
          {OPTIONAL_PREVIEW_COLUMNS.map((canonical) => (
            <li
              key={canonical}
              data-testid={`column-mapping-${canonical}`}
              className={`text-caption rounded-md border px-2 py-1 font-mono ${
                preview.detectedColumns.includes(canonical)
                  ? 'border-emerald-700 text-emerald-900 dark:border-emerald-500 dark:text-emerald-100'
                  : 'border-border text-muted-foreground'
              }`}
              title={t('optionalColumnTooltip')}
            >
              {canonical}
            </li>
          ))}
        </ul>
        <p className="text-caption mt-2 text-muted-foreground">
          {t('columnMappingLegend')}
        </p>
      </section>

      <section aria-labelledby="csv-preview-rows">
        <h3 id="csv-preview-rows" className="text-body mb-2 font-medium">
          {t('previewRowsTitle', { count: sampleRows.length })}
        </h3>
        <div className="overflow-x-auto">
          <table
            className="text-caption w-full border-collapse font-mono"
            aria-label={t('tableAriaLabel', { fileName })}
          >
            <thead>
              <tr>
                {preview.detectedColumns.map((c) => (
                  <th
                    key={c}
                    className="border-b border-border px-2 py-1 text-left"
                  >
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sampleRows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  data-testid="csv-preview-row"
                  className="border-b border-border/40"
                >
                  {row.map((cell, cellIdx) => (
                    <td key={cellIdx} className="px-2 py-1">
                      {cell}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="flex gap-2">
        <Button
          type="button"
          onClick={onSubmit}
          disabled={hasMissing}
          className="min-h-11"
        >
          <UploadCloud aria-hidden="true" className="mr-2 size-4" />
          {submitLabel}
        </Button>
        <Button
          type="button"
          onClick={onCancel}
          variant="outline"
          className="min-h-11"
        >
          {cancelLabel}
        </Button>
      </div>
    </div>
  );
}
