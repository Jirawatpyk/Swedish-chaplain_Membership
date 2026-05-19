/**
 * F6.1 (Feature 013) — shared test fixtures for `importCsv` use-case
 * tests that pre-date F6.1 (the `selectedEvent` field was added in
 * T022 / Feature 013).
 *
 * Provides a default `SelectedEventForImport` that legacy Phase 7
 * tests can spread into their `ImportCsvInput` argument so the strict
 * type-checker is satisfied without changing per-test semantics.
 *
 * Note: tests that depend on F6.1 behavior (safety-net, event-mismatch
 * warning, format detection) should construct their OWN selectedEvent
 * with realistic values — this fixture is a backward-compat shim only.
 */
import { asEventId } from '@/modules/events';
import type { SelectedEventForImport } from '@/modules/events/application/use-cases/import-csv';
import type { CsvImporter } from '@/modules/events/application/ports/csv-importer';
import { ok } from '@/lib/result';

/**
 * Stub `selectedEvent` for legacy tests. Values are deterministic so
 * test snapshots remain stable. eventId is a fixed UUID v4 — DOES NOT
 * exist in any real DB; tests that hit live Neon must override with a
 * pre-seeded event.
 */
export const f6CsvTestSelectedEventStub: SelectedEventForImport = {
  eventId: asEventId('00000000-0000-4000-8000-00000000abcd'),
  externalId: 'test-event-external-id',
  name: 'Test Event',
  startDate: new Date('2026-06-15T10:00:00.000Z'),
  category: null,
};

/**
 * F6.1 (Feature 013) — wrap a legacy Phase-7 `parseStream` mock as the
 * new `parseStreamWithFormat` method (default-pinned to `generic_csv`).
 *
 * Pre-F6.1 tests mock `parseStream` only; the F6.1 use-case now calls
 * `parseStreamWithFormat`. This helper produces a compatible adapter
 * so legacy tests continue to drive the use-case without re-mocking
 * the entire async iterator.
 */
export function wrapParseStreamAsFormat(
  parseStreamFn: CsvImporter['parseStream'],
): CsvImporter['parseStreamWithFormat'] {
  return async (input) => {
    const r = await parseStreamFn({
      bytes: input.bytes,
      ...(input.columnMapping !== undefined && {
        columnMapping: input.columnMapping,
      }),
    });
    if (!r.ok) return r;
    return ok({
      format: 'generic_csv' as const,
      rows: r.value,
      unknownColumns: [],
    });
  };
}

/**
 * F2 (Round 2 — code-simplifier): test-side factory for the `CsvImporter`
 * mock. Encapsulates the 6+ duplicated IIFE-style mock wrapper sites
 * that read:
 *
 *   csvImporter: ((parseStreamFn) => ({
 *     parseStream: parseStreamFn,
 *     parseStreamWithFormat: wrapParseStreamAsFormat(parseStreamFn),
 *   }))(vi.fn(...)),
 *
 * Tests pass their `parseStream` spy/mock directly; the helper threads
 * it through `wrapParseStreamAsFormat` so both port methods are wired.
 * `parseStream` is preserved as a spy so existing tests asserting call
 * args (when added) continue to work.
 */
export function makeCsvImporterMock(
  parseStreamFn: CsvImporter['parseStream'],
): CsvImporter {
  return {
    parseStream: parseStreamFn,
    parseStreamWithFormat: wrapParseStreamAsFormat(parseStreamFn),
  };
}
