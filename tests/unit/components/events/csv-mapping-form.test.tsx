/**
 * Component tests for the CSV import mapping form — FR-019b
 * event-mismatch preview preservation (PR 1.3 / #11).
 *
 * The bug: when the server returns `event_mismatch_warning`, the form
 * used to overwrite `phase.preview` with an EMPTY literal, so dismissing
 * the warning dialog left the admin on a blank "Confirm and import 0
 * rows" preview that re-loops (0-width table + an ENABLED import-0 CTA).
 * These tests pin that the REAL preview (row count + CTA count) survives
 * the warning AND its dialog dismissal, while the "Continue anyway"
 * safety-net bypass is unaffected.
 *
 * Timer note: the global setup installs fake timers; this file overrides
 * with real timers because `userEvent` + fetch + the PreviewPanel /
 * Base UI AlertDialog double-RAF focus effects need them. Every
 * assertion uses `findBy*` / `waitFor` — a sync `getBy` right after the
 * dialog's double-RAF focus effect can hang jsdom (project gotcha).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { NextIntlClientProvider } from 'next-intl';

// The component imports `toast` from sonner (used only on completed /
// timeout branches, but mocked so no real toast host is needed).
vi.mock('sonner', () => ({
  toast: {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  },
}));

// Stub the EventPicker so `selectedEventId` is non-null on mount. The
// real picker fetches `/api/admin/events` + relies on cmdk/popover;
// without a selection the Confirm button is gated (submitDisabled). The
// `[onChange]` dep is exhaustive-deps-safe and cannot loop: setState to
// the same id/label short-circuits (React bail-out). Repo mock pattern:
// async factory + `React.createElement` (see payments/pay-sheet.test).
vi.mock('@/components/events/event-picker', async () => {
  const React = await import('react');
  function EventPicker({
    onChange,
  }: {
    onChange: (
      id: string | null,
      ev: { eventId: string; name: string; startDate: string } | null,
    ) => void;
  }) {
    React.useEffect(() => {
      onChange('ev-fixed-1', {
        eventId: 'ev-fixed-1',
        name: 'Test Event',
        startDate: '2026-06-01',
      });
    }, [onChange]);
    return React.createElement('div', { 'data-testid': 'event-picker-stub' });
  }
  return { EventPicker };
});

import { CsvMappingForm } from '@/components/events/csv-mapping-form';
import enMessages from '@/i18n/messages/en.json';
import { buildFormats } from '@/i18n/formats';

// 5 canonical REQUIRED_COLUMNS present → missingRequired=[] → Confirm is
// enabled once an event is selected. 3 non-empty data rows → totalRowCount=3.
const CSV_3_ROWS = [
  'event_external_id,event_name,event_start,attendee_email,attendee_name',
  'ext-1,Test Event,2026-06-01,alice@example.com,Alice',
  'ext-1,Test Event,2026-06-01,bob@example.com,Bob',
  'ext-1,Test Event,2026-06-01,carol@example.com,Carol',
].join('\n');

function mismatchResponse(): Response {
  return new Response(
    JSON.stringify({
      kind: 'event_mismatch_warning',
      priorImports: [
        {
          recordId: 'rec-prior-1',
          eventId: 'ev-other-9',
          uploadedAt: '2026-06-20T09:30:00.000Z',
        },
      ],
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function renderForm() {
  return render(
    <NextIntlClientProvider
      locale="en"
      messages={enMessages}
      formats={buildFormats('en')}
    >
      <CsvMappingForm />
    </NextIntlClientProvider>,
  );
}

async function uploadThreeRowCsv(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const file = new File([CSV_3_ROWS], 'attendees.csv', { type: 'text/csv' });
  // jsdom's Blob/File does not implement `.text()` (Node's does, but the
  // jsdom global wins in this environment). The component calls
  // `await file.text()` in `handleFile`, so attach a spec-compatible
  // reader on this instance (surgical — no Blob.prototype mutation).
  Object.defineProperty(file, 'text', {
    value: () => Promise.resolve(CSV_3_ROWS),
    configurable: true,
  });
  const input = screen.getByLabelText(/Choose a \.csv file/i);
  await user.upload(input, file);
}

describe('CsvMappingForm — FR-019b mismatch preview preservation', () => {
  beforeEach(() => {
    // userEvent + fetch + double-RAF focus effects require real timers.
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it('keeps the real 3-row preview after dismissing the mismatch warning (no blank import-0 loop)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mismatchResponse()),
    );
    const user = userEvent.setup();
    renderForm();

    await uploadThreeRowCsv(user);

    // Baseline: preview heading + CTA both show 3 before submit.
    expect(await screen.findByText('Preview (3 rows)')).toBeInTheDocument();
    const confirm = await screen.findByRole('button', {
      name: /Confirm and import 3 rows/i,
    });

    // Submit → server flags event mismatch → warning dialog opens.
    await user.click(confirm);
    const dialog = await screen.findByRole('alertdialog');
    expect(
      within(dialog).getByText('This CSV may belong to a different event'),
    ).toBeInTheDocument();

    // Dismiss via the dialog's Cancel (autoFocus — the safe default action;
    // scoped `within(dialog)` because the PreviewPanel also has a "Cancel").
    const dialogCancel = await within(dialog).findByRole('button', {
      name: /Cancel/i,
    });
    await user.click(dialogCancel);

    // RED against pre-fix code: preview collapsed to "Preview (0 rows)" +
    // an ENABLED "Confirm and import 0 rows" CTA. GREEN: the real 3-row
    // preview survives so the admin never lands on a blank import-0 loop.
    expect(await screen.findByText('Preview (3 rows)')).toBeInTheDocument();
    expect(
      await screen.findByRole('button', {
        name: /Confirm and import 3 rows/i,
      }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Preview (0 rows)')).not.toBeInTheDocument();
    expect(
      screen.queryByText(/Confirm and import 0 rows/i),
    ).not.toBeInTheDocument();
  });

  it('re-arms the warning on a second Confirm and preserves the row count', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => mismatchResponse()),
    );
    const user = userEvent.setup();
    renderForm();

    await uploadThreeRowCsv(user);

    await user.click(
      await screen.findByRole('button', {
        name: /Confirm and import 3 rows/i,
      }),
    );
    const firstDialog = await screen.findByRole('alertdialog');
    await user.click(
      await within(firstDialog).findByRole('button', { name: /Cancel/i }),
    );

    // Preview preserved (GREEN) → the same 3-row Confirm CTA is present.
    const secondConfirm = await screen.findByRole('button', {
      name: /Confirm and import 3 rows/i,
    });

    // Re-submitting (no force) must re-arm the warning, not silently pass.
    await user.click(secondConfirm);
    expect(await screen.findByRole('alertdialog')).toBeInTheDocument();
    expect(await screen.findByText('Preview (3 rows)')).toBeInTheDocument();
  });

  it('forwards force_proceed on "Continue anyway" (safety-net bypass unaffected)', async () => {
    // Typed params so `.mock.calls[n]` is a 2-tuple (input, init) — a
    // zero-arg `vi.fn` infers an empty-tuple call signature (TS2493).
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        mismatchResponse(),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderForm();

    await uploadThreeRowCsv(user);

    await user.click(
      await screen.findByRole('button', {
        name: /Confirm and import 3 rows/i,
      }),
    );
    const dialog = await screen.findByRole('alertdialog');
    await user.click(
      await within(dialog).findByRole('button', { name: /Continue anyway/i }),
    );

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const secondCall = fetchMock.mock.calls[1];
    expect(secondCall).toBeDefined();
    const secondInit = secondCall?.[1] as RequestInit | undefined;
    const body = secondInit?.body as FormData | undefined;
    expect(body?.get('force_proceed')).toBe('true');
    expect(body?.get('event_id')).toBe('ev-fixed-1');
  });
});

// ---------------------------------------------------------------------------
// PR 4.2 (#10a) — FR-026 column remap. A non-EventCreate tenant uploads a
// CSV whose attendee columns are under NON-canonical headers (and which
// lacks event columns entirely — the picker supplies them per #10b). The
// admin maps each required attendee column via a native <select>; Confirm
// stays disabled until the required columns are mapped; on submit the form
// sends the mapping INVERTED to the parser's header→canonical direction.
// ---------------------------------------------------------------------------
const CSV_REMAP = [
  'Email Address,Full Name,Company Name',
  'lars@example.com,Lars Larsson,Volvo AB',
  'ingrid@example.com,Ingrid Nilsson,Saab',
].join('\n');

function completedResponse(): Response {
  return new Response(
    JSON.stringify({
      kind: 'completed',
      summary: {
        rowsProcessed: 2,
        rowsAlreadyImported: 0,
        eventsCreated: 0,
        eventsUpdated: 1,
        matchCounts: {
          member_contact: 0,
          member_domain: 0,
          member_fuzzy: 0,
          non_member: 2,
          unmatched: 0,
        },
        errorRows: [],
        durationMs: 10,
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

async function uploadRemapCsv(
  user: ReturnType<typeof userEvent.setup>,
): Promise<void> {
  const file = new File([CSV_REMAP], 'eventbrite.csv', { type: 'text/csv' });
  Object.defineProperty(file, 'text', {
    value: () => Promise.resolve(CSV_REMAP),
    configurable: true,
  });
  const input = screen.getByLabelText(/Choose a \.csv file/i);
  await user.upload(input, file);
}

describe('CsvMappingForm — FR-026 column remap (#10a)', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useFakeTimers();
  });

  it('renders remap selects, gates Confirm until required attendee columns are mapped, and posts an inverted header→canonical column_mapping', async () => {
    const fetchMock = vi.fn(
      async (_input: RequestInfo | URL, _init?: RequestInit) =>
        completedResponse(),
    );
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderForm();

    await uploadRemapCsv(user);

    // A <select> renders per required attendee column, labelled by the
    // canonical field name.
    const emailSelect = (await screen.findByLabelText(
      /attendee_email/i,
    )) as HTMLSelectElement;
    const nameSelect = (await screen.findByLabelText(
      /attendee_name/i,
    )) as HTMLSelectElement;
    expect(emailSelect.tagName).toBe('SELECT');
    expect(nameSelect.tagName).toBe('SELECT');
    // The detected (non-canonical) headers are the options.
    expect(
      within(emailSelect).getByRole('option', { name: 'Email Address' }),
    ).toBeInTheDocument();

    // Confirm is disabled until the required columns are mapped.
    const confirm = await screen.findByRole('button', {
      name: /Confirm and import/i,
    });
    expect(confirm).toBeDisabled();

    // Map only one required column → still gated.
    await user.selectOptions(emailSelect, 'Email Address');
    expect(confirm).toBeDisabled();

    // Map the second required column → gate opens.
    await user.selectOptions(nameSelect, 'Full Name');
    await waitFor(() => expect(confirm).toBeEnabled());

    // Submit → assert the FormData carries the INVERTED map.
    await user.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const body = init?.body as FormData | undefined;
    const raw = body?.get('column_mapping');
    expect(typeof raw).toBe('string');
    const parsed = JSON.parse(raw as string) as Record<string, string>;
    // INVERTED — header → canonical (the parser's expected direction).
    expect(parsed).toEqual({
      'Email Address': 'attendee_email',
      'Full Name': 'attendee_name',
    });
    expect(body?.get('event_id')).toBe('ev-fixed-1');
  });
});
