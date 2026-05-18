'use client';

/**
 * CSV import mapping form (F6 Phase 7).
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
import { useCallback, useEffect, useId, useRef, useState } from 'react';
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
import { EventPicker } from './event-picker';
import { EventCreateInlineModal } from './event-create-inline-modal';
import {
  EventMismatchWarningDialog,
  type PriorImportEntry,
} from './event-mismatch-warning-dialog';

const MAX_BYTES = 5 * 1024 * 1024;
const REQUIRED_COLUMNS = [
  'event_external_id',
  'event_name',
  'event_start',
  'attendee_email',
  'attendee_name',
] as const;
/**
 * F6.1 (FR-001) — EventCreate adapter signature columns (case-sensitive
 * exact match). When ALL six are present, the server-side parser
 * switches to EventCreate adapter mode and translates the 29-col native
 * format into the canonical row shape. Client-side preview must
 * recognise this so it does NOT flag the generic REQUIRED_COLUMNS as
 * "missing" when the file is in EventCreate format — staff-review
 * T060 follow-up: missing this detection caused the
 * Confirm button to stay disabled on Grant Thornton fixture uploads.
 */
const EVENTCREATE_REQUIRED_COLUMNS = [
  'Basic Info',
  'Status',
  'First Name',
  'Last Name',
  'Email',
  'Attendee ID',
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
  /**
   * UX-R1.2 F-02 — total non-empty data rows in the uploaded file
   * (excluding header). Preview caps display at 10 rows; this field
   * lets the UI communicate "showing 10 of N" so admin can see the
   * scope of the upcoming import before clicking Confirm.
   */
  readonly totalRowCount: number;
}

/**
 * RFC-4180 single-line tokeniser. Handles:
 *   - double-quoted cells (cells with embedded commas → must be quoted)
 *   - `""` escape for literal double-quote inside a quoted cell
 *   - whitespace trimming on unquoted cells only (quoted cells preserve)
 *
 * Bug-fix 2026-05-18 — replaced naive `.split(',')` which split on EVERY
 * comma including those inside quoted strings. Real EventCreate exports
 * routinely include cells like `"Please provide name, address, tax ID"`
 * and dates like `"May 16, 2026"` that the naive split shredded into
 * fragmented columns + wrong cell offsets in preview.
 *
 * The server-side parser at `streaming-csv-importer.ts` already does
 * proper RFC-4180 parsing; this client-side helper only needs the
 * tokeniser for accurate preview rendering. Multi-line quoted cells
 * (which RFC-4180 also permits) are NOT supported here — preview
 * truncates at first \n; the server-side parser handles those.
 */
function tokeniseCsvLine(line: string): string[] {
  const cells: string[] = [];
  let cur = '';
  let inQuotes = false;
  let i = 0;
  while (i < line.length) {
    const ch = line[i] ?? '';
    if (inQuotes) {
      if (ch === '"') {
        // Lookahead for `""` escape → literal quote.
        if (line[i + 1] === '"') {
          cur += '"';
          i += 2;
          continue;
        }
        // End of quoted cell.
        inQuotes = false;
        i += 1;
        continue;
      }
      cur += ch;
      i += 1;
      continue;
    }
    // Unquoted state.
    if (ch === '"') {
      // Opening quote — only valid at start of cell.
      if (cur.length === 0) {
        inQuotes = true;
        i += 1;
        continue;
      }
      // Quote mid-cell-unquoted is unusual but tolerate by treating as literal.
      cur += ch;
      i += 1;
      continue;
    }
    if (ch === ',') {
      cells.push(cur);
      cur = '';
      i += 1;
      continue;
    }
    cur += ch;
    i += 1;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/**
 * Lightweight client-side CSV header sniff for preview only — the
 * server-side parser is authoritative. We just want to render a
 * 10-row preview + tell the admin if a required column is obviously
 * missing before they upload.
 */
function sniffPreview(text: string): PreviewData {
  // UX-R1.2 F-02 — count ALL non-empty data rows before slicing for
  // the 10-row preview. Filter empty lines (trailing newline + blank
  // separator lines tolerated). `-1` for header row.
  const allLines = text
    .split(/\r?\n/)
    .filter((line) => line.trim().length > 0);
  const totalRowCount = Math.max(0, allLines.length - 1);
  const lines = allLines.slice(0, 11);
  const header = tokeniseCsvLine(lines[0] ?? '');
  const rows = lines
    .slice(1, 11)
    .map((line) => tokeniseCsvLine(line));
  const headerSet = new Set(header);
  // F6.1 FR-001 — if the file is in EventCreate native format (all 6
  // adapter columns present), the server adapter translates it into
  // the canonical schema. Client-side preview MUST treat this as
  // valid (no missing required columns) so the Confirm button is
  // not gated on the generic-CSV schema. Staff-review T060 fix
  //.
  const isEventCreateFormat = EVENTCREATE_REQUIRED_COLUMNS.every((c) =>
    headerSet.has(c),
  );
  const missingRequired = isEventCreateFormat
    ? []
    : REQUIRED_COLUMNS.filter((c) => !headerSet.has(c));
  return { detectedColumns: header, rows, missingRequired, totalRowCount };
}

export function CsvMappingForm() {
  const t = useTranslations('admin.events.import');
  const tErrors = useTranslations('admin.events.import.errors');
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // F6.1 (T028) — event selection state lives OUTSIDE the phase machine
  // so the admin can change the dropdown between Cancel/Continue cycles
  // without losing the preview file.
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null);
  const [selectedEventLabel, setSelectedEventLabel] = useState<string | null>(
    null,
  );
  const [createModalOpen, setCreateModalOpen] = useState(false);
  // Hold a callback the EventPicker registers so we can imperatively
  // push a freshly-created event into its dropdown state on `onCreated`
  // — closes the stale-button-label window between create-success and
  // the next refresh round-trip.
  const addPickerEventRef = useRef<((event: {
    eventId: string;
    name: string;
    startDate: string;
  }) => void) | null>(null);
  const [mismatchDialog, setMismatchDialog] = useState<{
    open: boolean;
    priorImports: ReadonlyArray<PriorImportEntry>;
  }>({ open: false, priorImports: [] });
  const fileInputId = useId();
  const liveRegionId = useId();
  const eventPickerLabelId = useId();
  // Tracks whether a previous completed phase happened so the idle
  // re-entry announcement only fires on intentional reset (not first
  // mount). Updated alongside the `setPhase({kind:'completed'})`
  // transition rather than in a `useEffect`: setting state in an
  // effect would cause an extra render before the live-region content
  // stabilises, and reading a ref during render to gate that re-
  // render would violate the "render is a pure function of
  // props+state" invariant.
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

  // S2 + UX-I6 (Round 1): inline `processImportResponse` into
  // `submitImport`. Previously a single-call helper with stale-closure
  // smell (`_fakePhase = phase` to "satisfy closure" + eslint-disable
  // react-hooks/exhaustive-deps). Merged + truthful deps array.
  const submitImport = useCallback(
    async (file: File, forceProceed: boolean): Promise<void> => {
      if (selectedEventId === null) {
        setPhase({
          kind: 'error',
          title: tErrors('eventNotSelectedTitle'),
          detail: tErrors('eventNotSelectedDetail'),
        });
        return;
      }
      setPhase({ kind: 'submitting', file });
      const fd = new FormData();
      fd.append('file', file);
      fd.append('event_id', selectedEventId);
      if (forceProceed) fd.append('force_proceed', 'true');

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

      // S5 + UX-I6 (Round 1): parse the body once + branch on
      // discriminator. Previously double-parsed via `res.clone().json()`
      // for the warning short-circuit AND again for the generic 200,
      // which would TypeError on the second `await res.json()` against
      // an already-consumed body — silently swallowed by `catch { body
      // = {} }` and hiding the real bug.
      let body: Record<string, unknown> = {};
      try {
        body = (await res.json()) as Record<string, unknown>;
      } catch {
        body = {};
      }

      switch (res.status) {
        case 200: {
          if (body['kind'] === 'event_mismatch_warning') {
            const priorImports = Array.isArray(body['priorImports'])
              ? (body['priorImports'] as PriorImportEntry[])
              : [];
            setMismatchDialog({ open: true, priorImports });
            setPhase({
              kind: 'preview',
              file,
              preview: {
                detectedColumns: [],
                rows: [],
                missingRequired: [],
                totalRowCount: 0,
              },
            });
            return;
          }
          // F6.1 `completed` envelope wraps summary at top-level.
          const rawSummary = (body['summary'] ?? body) as Omit<
            CsvImportResultPayload,
            'recordId' | 'historyPersisted' | 'safetyNetFailedOpen'
          >;
          // Smart-feature S-02 (Round 1) — thread recordId from the
          // F6.1 envelope so the result card can render it for support.
          // R2-I4 (Round 2) — thread `historyPersisted` so the card can
          // render the degraded-history warning when both placeholder
          // and CR-5 recovery INSERTs failed.
          // R8.B1 / Staff R3 R068 closure — thread `safetyNetFailedOpen`
          // from the envelope into the summary so the
          // "duplicate-protection unavailable" chip renders when the
          // FR-019b safety-net query failed. Previously the form layer
          // silently dropped this envelope field — R7's R030 wiring
          // existed at every layer EXCEPT this one, so the chip was
          // dead code in production.
          const summary: CsvImportResultPayload = {
            ...rawSummary,
            ...(typeof body['recordId'] === 'string'
              ? { recordId: body['recordId'] }
              : {}),
            ...(typeof body['historyPersisted'] === 'boolean'
              ? { historyPersisted: body['historyPersisted'] }
              : {}),
            ...(typeof body['safetyNetFailedOpen'] === 'boolean'
              ? { safetyNetFailedOpen: body['safetyNetFailedOpen'] }
              : {}),
          };
          setPhase({ kind: 'completed', summary });
          setHasPreviouslyCompleted(true);
          toast.success(t('importSuccessToast'), {
            description: t('importSuccessToastDesc', {
              count: summary.rowsProcessed ?? 0,
            }),
          });
          return;
        }
        case 400: {
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
        case 504: {
          // Route's 504 extras carry `recordId` + `sourceFormat` +
          // `historyPersisted` + `summary` per the F6.1 timeout envelope.
          // When the partial summary is available, surface it as a
          // result card (with the degraded-history banner when needed)
          // so admins see WHICH rows committed — re-uploading the same
          // CSV will skip them via idempotency receipts.
          const summary = body['summary'];
          if (summary !== null && typeof summary === 'object') {
            const partialSummary: CsvImportResultPayload = {
              ...(summary as Omit<
                CsvImportResultPayload,
                'recordId' | 'historyPersisted' | 'safetyNetFailedOpen'
              >),
              ...(typeof body['recordId'] === 'string'
                ? { recordId: body['recordId'] }
                : {}),
              ...(typeof body['historyPersisted'] === 'boolean'
                ? { historyPersisted: body['historyPersisted'] }
                : {}),
              // R8.B1 / Staff R3 R068 — same safety-net signal on the
              // 504 timeout extras envelope so partial-import admin
              // retry surfaces the chip too.
              ...(typeof body['safetyNetFailedOpen'] === 'boolean'
                ? { safetyNetFailedOpen: body['safetyNetFailedOpen'] }
                : {}),
            };
            setPhase({ kind: 'completed', summary: partialSummary });
            setHasPreviouslyCompleted(true);
            toast.warning(tErrors('timeoutTitle'), {
              description: tErrors('timeoutDetail'),
            });
            return;
          }
          setPhase({
            kind: 'error',
            title: tErrors('timeoutTitle'),
            detail: tErrors('timeoutDetail'),
          });
          return;
        }
        default: {
          const detail = await parseProblemDetail(
            new Response(JSON.stringify(body), {
              status: res.status,
              headers: { 'Content-Type': 'application/json' },
            }),
            tErrors('unexpectedDetail'),
          );
          setPhase({
            kind: 'error',
            title: tErrors('unexpectedTitle'),
            detail,
          });
          return;
        }
      }
    },
    [selectedEventId, t, tErrors],
  );

  // Mismatch override — re-submit current preview with force_proceed=true.
  const onContinueDespiteMismatch = useCallback(() => {
    setMismatchDialog({ open: false, priorImports: [] });
    if (phase.kind === 'preview') {
      void submitImport(phase.file, true);
    }
  }, [phase, submitImport]);

  const onSubmit = useCallback(async () => {
    if (phase.kind !== 'preview') return;
    await submitImport(phase.file, false);
  }, [phase, submitImport]);

  const resetToUpload = useCallback(() => setPhase({ kind: 'idle' }), []);

  // Top-level aria-live region announces phase transitions across all
  // render branches. NVDA/JAWS register the observer at DOM-insertion
  // time, and content arriving WITH the node is often swallowed —
  // dynamically-mounted live regions are unreliable. Hoisting the
  // region into a single stable outer `<div>` that wraps BOTH the
  // completed-result branch AND the form Card branch guarantees the
  // region itself is pre-existing across the type-changing inner
  // reconcile (Card → CsvImportResult subtree), so the transition
  // text actually reaches the SR queue:
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

  return (
    <div className="flex flex-col gap-4">
      {liveRegion}
      {/* F6.1 (T026) — inline event-create modal (MVP placeholder). */}
      <EventCreateInlineModal
        open={createModalOpen}
        onOpenChange={setCreateModalOpen}
        onCreated={(event) => {
          // Auto-select the new event so the admin can immediately
          // proceed to upload the CSV. R2 (Round 2 — code-reviewer #2):
          // push the new event into EventPicker's local state so the
          // button label updates immediately (previously stayed on
          // "Select an event…" until the next refresh round-trip).
          addPickerEventRef.current?.({
            eventId: event.eventId,
            name: event.name,
            startDate: event.startDate,
          });
          setSelectedEventId(event.eventId);
          setSelectedEventLabel(event.name);
        }}
      />
      {/* F6.1 (T027) — FR-019b event-mismatch warning. */}
      <EventMismatchWarningDialog
        open={mismatchDialog.open}
        onOpenChange={(open) =>
          setMismatchDialog((prev) => ({ ...prev, open }))
        }
        priorImports={mismatchDialog.priorImports}
        onContinue={onContinueDespiteMismatch}
      />
      {phase.kind === 'completed' ? (
        <>
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
        </>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>{t('formTitle')}</CardTitle>
            <CardDescription>{t('formDescription')}</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-6">
            {/* F6.1 (T028 · 4-phase wizard) — EventPicker rendered ABOVE
                the file input across every non-completed phase. Admin
                can change selection between attempts; the picker is the
                authoritative event binding. */}
            <div className="flex flex-col gap-2">
              <Label id={eventPickerLabelId}>{t('eventPicker.fieldLabel')}</Label>
              <EventPicker
                triggerAriaLabelledBy={eventPickerLabelId}
                value={selectedEventId}
                onChange={(eventId, event) => {
                  setSelectedEventId(eventId);
                  setSelectedEventLabel(event?.name ?? null);
                }}
                filenameHint={
                  phase.kind === 'preview' ? phase.file.name : null
                }
                onCreateNew={() => setCreateModalOpen(true)}
                registerAddEvent={(add) => {
                  addPickerEventRef.current = add;
                }}
              />
              <p className="text-caption text-muted-foreground">
                {t('eventPicker.fieldHelp')}
              </p>
              {selectedEventLabel !== null && (
                <p className="text-caption text-muted-foreground">
                  <strong>{t('eventPicker.selectedPrefix')}:</strong>{' '}
                  {selectedEventLabel}
                </p>
              )}
            </div>

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
                submitLabel={t('preview.confirmCtaWithCount', {
                  count: phase.preview.totalRowCount,
                })}
                cancelLabel={t('cancelCta')}
                submitDisabled={selectedEventId === null}
                submitDisabledReason={
                  selectedEventId === null
                    ? t('eventPicker.submitGatedHint')
                    : null
                }
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
      )}
    </div>
  );
}

interface ErrorPanelProps {
  readonly phase: Extract<Phase, { kind: 'error' }>;
  readonly onRetry: () => void;
}

function ErrorPanel({ phase, onRetry }: ErrorPanelProps) {
  const t = useTranslations('admin.events.import');
  // UX-R1.2 F-04 — focus management on phase transition. Same
  // double-RAF pattern as PreviewPanel; moves SR focus to the
  // error AlertTitle on mount so users hear the error message
  // instead of staying anchored on the now-unmounted file input.
  const errorTitleRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        errorTitleRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2 !== 0) window.cancelAnimationFrame(raf2);
    };
  }, []);
  return (
    <div data-testid="csv-header-error">
      <Alert variant="destructive">
        <AlertTitle ref={errorTitleRef} tabIndex={-1} className="focus:outline-none">
          {phase.title}
        </AlertTitle>
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
  /** F6.1 — gate submit when no event picked. */
  readonly submitDisabled?: boolean;
  readonly submitDisabledReason?: string | null;
}

function PreviewPanel({
  preview,
  fileName,
  onSubmit,
  onCancel,
  submitLabel,
  cancelLabel,
  submitDisabled = false,
  submitDisabledReason = null,
}: PreviewPanelProps) {
  const t = useTranslations('admin.events.import.preview');
  const hasMissing = preview.missingRequired.length > 0;
  // simplify #9 fix: `preview.rows` is already capped to 10 rows by
  // `sniffPreview` (slice(0,11) over header + 10 body rows). No
  // additional slice needed; useMemo was a no-op churn.
  const sampleRows = preview.rows;

  // UX-R1.2 F-04 — focus management on phase transition. When this
  // panel mounts (after file-chooser closes + sniff completes), move
  // SR focus to the preview heading so keyboard + screen-reader users
  // are placed at the new content instead of the now-unmounted file
  // input. Double-RAF pattern from `reject-dialog.tsx:57-69` waits
  // for DOM mount + layout before calling .focus(); reduced-motion
  // safe because raf cancellation handles unmount mid-frame.
  const previewHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    let raf2 = 0;
    const raf1 = window.requestAnimationFrame(() => {
      raf2 = window.requestAnimationFrame(() => {
        previewHeadingRef.current?.focus();
      });
    });
    return () => {
      window.cancelAnimationFrame(raf1);
      if (raf2 !== 0) window.cancelAnimationFrame(raf2);
    };
  }, []);

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
        <div className="mb-2 flex items-baseline justify-between">
          <h3
            id="csv-preview-rows"
            ref={previewHeadingRef}
            tabIndex={-1}
            className="text-body font-medium focus:outline-none"
          >
            {t('previewRowsTitle', { count: sampleRows.length })}
          </h3>
          <span className="text-caption text-muted-foreground">
            {t('totalRowsHint', {
              columns: preview.detectedColumns.length,
              sampled: sampleRows.length,
              total: preview.totalRowCount,
            })}
          </span>
        </div>
        {/*
          F6.1 R3 a11y-fix 2026-05-16 — axe-core `scrollable-region-focusable`
          required a keyboard-focusable handle on the horizontally-scrolling
          region so keyboard-only users can pan a wide preview. Pattern
          mirrors `recent-deliveries-panel.tsx` (role=region + aria-labelledby
          + tabIndex=0 + visible focus ring).

          UX-fix 2026-05-18 — bounded max-h on the region so very tall
          tables (e.g., 10 rows × 250-char PDPA cells) don't push the
          Confirm button below the viewport. Vertical scroll inside the
          region; horizontal scroll for many-column CSVs. Cell-level
          truncation (max-w + line-clamp) limits each row's height.
        */}
        {/*
          UX-fix 2026-05-18 — force ALWAYS-visible scrollbars via
          `overflow-x-scroll` + `overflow-y-auto`. Browser default
          (`overflow: auto`) hides scrollbars when not actively
          scrolling on some platforms (Windows native, macOS with
          "Show scroll bars: When scrolling" setting) — admin
          couldn't see the horizontal scroll affordance + missed
          that the table has 35+ columns. `overflow-x-scroll`
          shows the bar permanently when there's any chance of
          overflow. Also added `scrollbar-thin` style hooks for
          Firefox + thicker WebKit bars for Windows visibility.
        */}
        <div
          role="region"
          aria-labelledby="csv-preview-rows"
          tabIndex={0}
          className="max-h-[28rem] overflow-x-scroll overflow-y-auto rounded-md border border-border focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring [scrollbar-color:var(--muted-foreground)_transparent] [scrollbar-width:thin] [&::-webkit-scrollbar]:h-2.5 [&::-webkit-scrollbar]:w-2.5 [&::-webkit-scrollbar-thumb]:rounded [&::-webkit-scrollbar-thumb]:bg-muted-foreground/40 [&::-webkit-scrollbar-thumb:hover]:bg-muted-foreground/60 [&::-webkit-scrollbar-track]:bg-muted/30"
        >
          {/*
            UX-fix 2026-05-18 — `table-fixed` forces browser to honor
            per-cell `width:` declarations (default `table-layout: auto`
            collapses cells to natural content width when the parent is
            narrow, defeating the fixed-column-width design + hiding the
            horizontal scrollbar). With `table-fixed`, the table's
            intrinsic width = sum of per-cell widths = 35 cols × 8rem =
            ~4480px, which forces horizontal overflow in any reasonable
            viewport so the scrollbar is always present.
          */}
          {/*
            `min-w-max` + inline `width` style sums per-cell widths so
            the table extends to its natural intrinsic width (35 cols ×
            8rem = 280rem ≈ 4480px). Without this, the table collapsed
            to parent container width and the horizontal scrollbar
            never appeared because browser saw no overflow.
          */}
          <table
            className="min-w-max table-fixed border-collapse font-mono text-xs"
            style={{
              width: `${preview.detectedColumns.length * 8}rem`,
            }}
            aria-label={t('tableAriaLabel', { fileName })}
          >
            <thead className="sticky top-0 z-10 bg-muted">
              <tr>
                {/*
                  Bug-fix 2026-05-18 — some EventCreate CSV exports
                  contain duplicate column names (e.g., "Billing
                  Address" appearing twice). React requires unique keys
                  so we suffix with the column index. Duplicates remain
                  visible to the admin (intentional — flag of CSV
                  quirk; admin may re-export from EventCreate).

                  UX-fix 2026-05-18 — highlight canonical columns
                  (EventCreate-format required + generic-CSV required +
                  optional) with subtle emerald background; non-canonical
                  columns are muted. Admins can scan which columns
                  actually drive the import.
                */}
                {preview.detectedColumns.map((c, idx) => {
                  const isCanonical =
                    EVENTCREATE_REQUIRED_COLUMNS.includes(
                      c as (typeof EVENTCREATE_REQUIRED_COLUMNS)[number],
                    ) ||
                    REQUIRED_COLUMNS.includes(
                      c as (typeof REQUIRED_COLUMNS)[number],
                    ) ||
                    OPTIONAL_PREVIEW_COLUMNS.includes(
                      c as (typeof OPTIONAL_PREVIEW_COLUMNS)[number],
                    );
                  // Canonical columns get a 2px emerald bottom-border accent
                  // + emerald text — clear visual signal of "these drive the
                  // import" without overwhelming the table. Non-canonical
                  // columns use muted text + thin default bottom-border.
                  //
                  // `min-w-[10rem]` on every cell forces the table to
                  // overflow horizontally on wide CSVs (e.g., 35 columns ×
                  // 10rem = ~5600px > container width) so the horizontal
                  // scrollbar appears at the bottom. Without min-width,
                  // truncate + max-w would collapse columns to natural
                  // content width and the table would silently fit the
                  // container with no scroll affordance.
                  const accentClass = isCanonical
                    ? 'border-b-2 border-b-emerald-500 bg-emerald-50/70 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300'
                    : 'border-b border-border text-muted-foreground';
                  return (
                    <th
                      key={`${c}-${idx}`}
                      title={c}
                      scope="col"
                      className={
                        idx === 0
                          ? // UX-R1.2 F-09 — narrower sticky col on mobile
                            // (6rem ≈ 96px = 26% of 375px viewport, was
                            // 37% at 8rem). Restores at sm: ≥640px where
                            // there's more horizontal space.
                            `sticky left-0 z-20 w-[6rem] min-w-[6rem] max-w-[6rem] sm:w-[8rem] sm:min-w-[8rem] sm:max-w-[8rem] truncate border-r border-border bg-muted px-2 py-1.5 text-left font-medium ${accentClass}`
                          : `w-[8rem] min-w-[8rem] max-w-[8rem] truncate px-2 py-1.5 text-left font-medium ${accentClass}`
                      }
                    >
                      {isCanonical ? '✓ ' : ''}{c}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {sampleRows.map((row, rowIdx) => (
                <tr
                  key={rowIdx}
                  data-testid="csv-preview-row"
                  className={`border-b border-border/40 transition-colors hover:bg-muted/40 ${
                    rowIdx % 2 === 1 ? 'bg-muted/20' : ''
                  }`}
                >
                  {row.map((cell, cellIdx) => (
                    <td
                      key={cellIdx}
                      title={cell}
                      className={
                        cellIdx === 0
                          ? // Sticky first column MUST have SOLID
                            // background — `bg-muted/20` (zebra) is 20%
                            // transparent and lets scrolled-past columns
                            // bleed through. Use solid `bg-background`
                            // OR `bg-muted` per row parity (both solid).
                            `sticky left-0 z-10 w-[6rem] min-w-[6rem] max-w-[6rem] sm:w-[8rem] sm:min-w-[8rem] sm:max-w-[8rem] truncate border-r border-border ${
                              rowIdx % 2 === 1 ? 'bg-muted' : 'bg-background'
                            } px-2 py-1 align-top`
                          : 'w-[8rem] min-w-[8rem] max-w-[8rem] truncate px-2 py-1 align-top'
                      }
                    >
                      {cell || (
                        <>
                          {/* UX-R1.2 F-06 — em-dash decorative only;
                              SR-only fallback carries the semantic
                              "(empty)" to assistive tech. Bumped opacity
                              from /50 (~1.98:1) to /70 (~2.8:1) — still
                              under 4.5:1 but with aria-hidden marks the
                              em-dash as decoration per WCAG SC 1.4.3
                              exemption. */}
                          <span
                            aria-hidden="true"
                            className="text-muted-foreground/70"
                          >
                            —
                          </span>
                          <span className="sr-only">
                            {t('emptyCell')}
                          </span>
                        </>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="text-caption mt-1.5 text-muted-foreground">
          {t('tableHelpText')}
        </p>
      </section>

      <div className="flex flex-col gap-2">
        <div className="flex gap-2">
          <Button
            type="button"
            onClick={onSubmit}
            disabled={hasMissing || submitDisabled}
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
        {/* H7.2 / IMP-R2-4 — stable outer mount of the aria-live region
            so NVDA/JAWS register the observer on first render. Content
            varies conditionally; min-h prevents layout collapse to 0px
            when there's no reason. Mirrors the precedent at the
            phase-state live region near the top of this component. */}
        <p
          className="text-caption text-muted-foreground min-h-[1lh]"
          aria-live="polite"
          aria-atomic="true"
        >
          {submitDisabled && submitDisabledReason !== null
            ? submitDisabledReason
            : ''}
        </p>
      </div>
    </div>
  );
}
